// scrippo ネイティブヘルパー: OCR / ロック判定 / ウィンドウ情報 / カレンダー取得を1バイナリに集約
// build: ./ocr-src/build.sh  (swiftc main.swift -o bin/ocr -framework Vision -framework AppKit -framework EventKit)
//
// サブコマンド:
//   ocr recognize <image-path>  → {"text": "...", "confidence": 0.92}
//   ocr session-info            → {"locked": false, "lock_state_unknown": false,
//                                   "frontmost_app": "...", "window_title": "...",
//                                   "on_screen_apps": [...], "display_count": 2}
//   ocr calendar-events --date YYYY-MM-DD [--calendars "a,b"] [--list-calendars]
//                                → {"authorized": true, "events": [...]} / {"calendars": [...]}

import AppKit
import EventKit
import Foundation
import Vision

func printJSON(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let text = String(data: data, encoding: .utf8)
    else {
        FileHandle.standardError.write("{\"error\": \"json serialization failed\"}\n".data(using: .utf8)!)
        exit(1)
    }
    print(text)
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

// MARK: - recognize

func recognize(imagePath: String) {
    guard let image = NSImage(contentsOfFile: imagePath),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
    else {
        fail("cannot load image: \(imagePath)")
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["ja-JP", "en-US"]
    request.usesLanguageCorrection = true

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
    } catch {
        fail("ocr failed: \(error.localizedDescription)")
    }

    var lines: [String] = []
    var confidences: [Float] = []
    for observation in request.results ?? [] {
        guard let candidate = observation.topCandidates(1).first else { continue }
        lines.append(candidate.string)
        confidences.append(candidate.confidence)
    }
    let avgConfidence = confidences.isEmpty
        ? 0.0
        : Double(confidences.reduce(0, +)) / Double(confidences.count)

    printJSON([
        "text": lines.joined(separator: "\n"),
        "confidence": (avgConfidence * 100).rounded() / 100,
    ])
}

// MARK: - session-info

func sessionInfo() {
    // ロック判定: 取得できない場合は locked=true(フェイルセーフ)+ unknown フラグ
    var locked = true
    var lockStateUnknown = true
    if let session = CGSessionCopyCurrentDictionary() as? [String: Any] {
        if let value = session["CGSSessionScreenIsLocked"] {
            locked = (value as? Bool) ?? ((value as? Int) == 1)
            lockStateUnknown = false
        } else {
            // キーが無い = ロックされていない状態が通例だが、辞書自体は取れているので unlocked と判定
            locked = false
            lockStateUnknown = false
        }
    }

    var frontmostApp = ""
    var windowTitle = ""
    var onScreenApps: [String] = []
    var seenApps = Set<String>()

    if let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
        for window in windows {
            guard let layer = window[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
            let owner = (window[kCGWindowOwnerName as String] as? String) ?? ""
            if !owner.isEmpty && !seenApps.contains(owner) {
                seenApps.insert(owner)
                onScreenApps.append(owner)
            }
            if frontmostApp.isEmpty {
                // optionOnScreenOnly は前面から順に返すため、最初の layer 0 が最前面
                frontmostApp = owner
                // kCGWindowName は画面収録権限がある場合のみ取得可能。無ければ空文字のまま
                windowTitle = (window[kCGWindowName as String] as? String) ?? ""
            }
        }
    }

    printJSON([
        "locked": locked,
        "lock_state_unknown": lockStateUnknown,
        "frontmost_app": frontmostApp,
        "window_title": windowTitle,
        "on_screen_apps": onScreenApps,
        "display_count": NSScreen.screens.count,
    ])
}

// MARK: - calendar-events

func isEmailLike(_ s: String) -> Bool {
    let pattern = "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$"
    return s.range(of: pattern, options: .regularExpression) != nil
}

func participantStatusString(_ event: EKEvent) -> String {
    guard let attendees = event.attendees,
          let me = attendees.first(where: { $0.isCurrentUser })
    else { return "unknown" }
    switch me.participantStatus {
    case .accepted: return "accepted"
    case .declined: return "declined"
    case .tentative: return "tentative"
    case .pending: return "pending"
    default: return "unknown"
    }
}

/// デフォルト対象: 名前がメールアドレス形式かつ所属アカウント名と一致(= Googleプライマリカレンダー)。
/// 該当ゼロならメールアドレス形式のみで再判定(アカウント名が "Google" 等になる環境向けフォールバック)
func defaultSelectedCalendars(_ all: [EKCalendar]) -> [EKCalendar] {
    let strict = all.filter { isEmailLike($0.title) && $0.title == $0.source.title }
    if !strict.isEmpty { return strict }
    return all.filter { isEmailLike($0.title) }
}

func calendarEvents(dateString: String?, calendarFilter: [String]?, listOnly: Bool) {
    let store = EKEventStore()
    let semaphore = DispatchSemaphore(value: 0)
    var granted = false
    if #available(macOS 14.0, *) {
        store.requestFullAccessToEvents { ok, _ in granted = ok; semaphore.signal() }
    } else {
        store.requestAccess(to: .event) { ok, _ in granted = ok; semaphore.signal() }
    }
    semaphore.wait()

    let emptyKey = listOnly ? "calendars" : "events"
    guard granted else {
        printJSON(["authorized": false, emptyKey: [] as [Any]])
        return
    }

    let all = store.calendars(for: .event)
    let defaults = defaultSelectedCalendars(all)

    if listOnly {
        let defaultIds = Set(defaults.map { $0.calendarIdentifier })
        let list: [[String: Any]] = all
            .sorted { ($0.source.title, $0.title) < ($1.source.title, $1.title) }
            .map { cal in
                [
                    "name": cal.title,
                    "account": cal.source.title,
                    "default_selected": defaultIds.contains(cal.calendarIdentifier),
                ]
            }
        printJSON(["authorized": true, "calendars": list])
        return
    }

    guard let dateString else { fail("usage: ocr calendar-events --date YYYY-MM-DD [--calendars \"a,b\"]") }
    let df = DateFormatter()
    df.dateFormat = "yyyy-MM-dd"
    df.locale = Locale(identifier: "en_US_POSIX")
    df.timeZone = TimeZone.current
    guard let dayStart = df.date(from: dateString).map({ Calendar.current.startOfDay(for: $0) }),
          let dayEnd = Calendar.current.date(byAdding: .day, value: 1, to: dayStart)
    else { fail("invalid --date: \(dateString)") }

    let selected: [EKCalendar]
    if let filter = calendarFilter {
        selected = filter.contains("*") ? all : all.filter { filter.contains($0.title) }
    } else {
        selected = defaults
    }
    guard !selected.isEmpty else {
        printJSON(["authorized": true, "events": [] as [Any]])
        return
    }

    let out = DateFormatter()
    out.dateFormat = "yyyy-MM-dd'T'HH:mm:ssZZZZZ"
    out.locale = Locale(identifier: "en_US_POSIX")
    out.timeZone = TimeZone.current

    let predicate = store.predicateForEvents(withStart: dayStart, end: dayEnd, calendars: selected)
    let events: [[String: Any]] = store.events(matching: predicate)
        .sorted { $0.startDate < $1.startDate }
        .map { event in
            [
                "start": out.string(from: event.startDate),
                "end": out.string(from: event.endDate),
                "title": event.title ?? "",
                "calendar": event.calendar.title,
                "all_day": event.isAllDay,
                "my_status": participantStatusString(event),
                "attendee_count": event.attendees?.count ?? 0,
            ]
        }
    printJSON(["authorized": true, "events": events])
}

// MARK: - main

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "recognize":
    guard args.count > 2 else { fail("usage: ocr recognize <image-path>") }
    recognize(imagePath: args[2])
case "session-info":
    sessionInfo()
case "calendar-events":
    var dateString: String? = nil
    var calendarFilter: [String]? = nil
    var listOnly = false
    var i = 2
    while i < args.count {
        switch args[i] {
        case "--date":
            guard i + 1 < args.count else { fail("--date requires a value") }
            dateString = args[i + 1]
            i += 2
        case "--calendars":
            guard i + 1 < args.count else { fail("--calendars requires a value") }
            calendarFilter = args[i + 1].split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            i += 2
        case "--list-calendars":
            listOnly = true
            i += 1
        default:
            fail("unknown option: \(args[i])")
        }
    }
    calendarEvents(dateString: dateString, calendarFilter: calendarFilter, listOnly: listOnly)
default:
    fail("usage: ocr recognize <image-path> | ocr session-info | ocr calendar-events --date YYYY-MM-DD [--calendars \"a,b\"] [--list-calendars]")
}
