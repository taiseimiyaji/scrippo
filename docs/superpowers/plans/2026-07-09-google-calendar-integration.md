# Googleカレンダー統合(EventKit)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** macOSカレンダー.appに同期されたGoogleカレンダーの予定を EventKit で読み取り、`scrippo report` の digest に `calendar_events`(キャプチャ空白との overlap 判定付き)として合成して日報・振り返りの精度を上げる。

**Architecture:** 既存の Swift バイナリ `bin/ocr` に `calendar-events` サブコマンドを追加(EventKit、フィルタも Swift 側で適用)。TypeScript 側は新規 `src/calendar.ts` に「バイナリ呼び出し+出力検証」と「overlap 判定(純関数)」を置き、`report.ts` が digest 生成後(キャッシュの外で)予定を取得・合成する。キャプチャ経路(capture.ts / JSONL)は無変更。

**Tech Stack:** Swift (EventKit, JSONSerialization) / TypeScript (Node 24, 依存追加なし, node:test)

**Spec:** `docs/superpowers/specs/2026-07-09-google-calendar-integration-design.md`

## Global Constraints

- ランタイム依存は `@openai/codex-sdk` のみ。**依存を追加しない**(バリデーションは手書き)
- Swift は単一ファイル `ocr-src/main.swift` に集約。SwiftPM 不使用、`build.sh` の swiftc 一発ビルド
- `~/.scrippo` 配下のファイルは 600(`writeFileSecure` を使う)
- 決定的処理(overlap判定等)は純関数で書き、node:test でテスト。Swift 側は実機手動検証
- フェイルセーフ: カレンダー権限なし・取得失敗でも report は従来どおり動く(エラーで止めない)
- 予定タイトルは JSONL・digest-cache に**書かない**(メモリ上とプロンプトのみ)
- 日付・時刻はローカルタイムゾーン。digest 内の時刻表現は `HH:MM`
- コミットメッセージは既存慣行に合わせ `feat:`/`test:`/`docs:` プレフィックス

> **注意:** このリポジトリは現在 git 管理されていない。Task 1 開始前に `git init && git add -A && git commit -m "chore: initial commit"` を実行すること(既に git 管理済みならスキップ)。

---

### Task 1: Swift `calendar-events` サブコマンド

**Files:**
- Modify: `ocr-src/main.swift`(末尾の main スイッチと、新規関数群)
- Modify: `ocr-src/build.sh:6`(`-framework EventKit` 追加)

**Interfaces:**
- Produces(後続タスクが依存する CLI 仕様):
  - `bin/ocr calendar-events --date YYYY-MM-DD [--calendars "name1,name2"]`
    → stdout に `{"authorized": true, "events": [{"start": "2026-07-09T10:00:00+09:00", "end": "...", "title": "...", "calendar": "...", "all_day": false, "my_status": "accepted", "attendee_count": 5}]}`(start 昇順ソート)
  - `bin/ocr calendar-events --list-calendars`
    → `{"authorized": true, "calendars": [{"name": "...", "account": "...", "default_selected": true}]}`
  - 権限なし: `{"authorized": false, "events": []}`(または `"calendars": []`)で **exit 0**
  - `--calendars` 省略時のデフォルト選択: カレンダー名がメールアドレス形式かつ所属アカウント名(`EKSource.title`)と一致するもの。該当ゼロなら「メールアドレス形式の名前」だけで再判定(フォールバック)。`--calendars "*"` は全カレンダー
  - `my_status`: `accepted | declined | tentative | pending | unknown`(attendees に自分がいない・attendees なしは `unknown`)

- [ ] **Step 1: build.sh に EventKit を追加**

`ocr-src/build.sh` の swiftc 行を以下に変更:

```bash
swiftc -O ocr-src/main.swift -o bin/ocr -framework Vision -framework AppKit -framework EventKit
```

- [ ] **Step 2: main.swift にサブコマンドを実装**

`import Vision` の下に `import EventKit` を追加。`// MARK: - session-info` セクションの後・`// MARK: - main` の前に以下を追加:

```swift
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
```

`// MARK: - main` のスイッチに case を追加(`default` の直前):

```swift
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
```

`default:` の usage 文字列も更新:

```swift
default:
    fail("usage: ocr recognize <image-path> | ocr session-info | ocr calendar-events --date YYYY-MM-DD [--calendars \"a,b\"] [--list-calendars]")
```

- [ ] **Step 3: ビルド**

Run: `npm run build:ocr`
Expected: `built: bin/ocr`(エラーなし)

- [ ] **Step 4: 実機で手動検証**

```bash
./bin/ocr calendar-events --list-calendars
```

初回はカレンダーアクセスの権限ダイアログが出る → 許可。
Expected: `{"authorized": true, "calendars": [...]}` で、自分のメールアドレス名のカレンダーに `"default_selected": true` が付いていること。

```bash
./bin/ocr calendar-events --date $(date +%F)
./bin/ocr calendar-events --date $(date +%F) --calendars "*"
./bin/ocr calendar-events --date 不正な日付
```

Expected: 1本目はデフォルト対象(プライマリ)の予定のみ、2本目は全カレンダーの予定、3本目は stderr にエラーで exit 1。
確認ポイント: 終日イベントの `all_day: true` / 辞退した予定の `my_status: "declined"` / start 昇順。

権限を拒否した場合の挙動も確認する(システム設定 > プライバシーとセキュリティ > カレンダー でターミナルをオフ → `{"authorized": false, ...}` で exit 0)。確認後は許可に戻す。

- [ ] **Step 5: Commit**

```bash
git add ocr-src/main.swift ocr-src/build.sh bin/ocr
git commit -m "feat: add calendar-events subcommand to bin/ocr (EventKit)"
```

---

### Task 2: config に `calendar_names` を追加

**Files:**
- Modify: `src/util.ts:108-132`(`ScrippoConfig` / `DEFAULT_CONFIG` / `loadConfig`)
- Test: `test/util.test.ts`(既存ファイルに追記)

**Interfaces:**
- Produces: `ScrippoConfig.calendar_names: string[] | null`(null = 未設定 = Swift側デフォルト判定に任せる)。`loadConfig()` は既存呼び出しと後方互換(既存の config.json に `calendar_names` が無ければ null)

- [ ] **Step 1: 失敗するテストを書く**

`test/util.test.ts` の末尾に追記。既存テストの import に合わせて `loadConfig` は**純関数部分だけ**をテストできないため、パース部分を関数に切り出す方針にする(Step 3 参照)。テストは新関数 `parseConfig` に対して書く:

```ts
// --- parseConfig ---

test('parseConfig returns calendar_names when valid string array', () => {
  const c = parseConfig(JSON.stringify({ excluded_apps: [], calendar_names: ['a@example.com'] }));
  assert.deepEqual(c.calendar_names, ['a@example.com']);
});

test('parseConfig returns null calendar_names when absent or invalid', () => {
  assert.equal(parseConfig(JSON.stringify({ excluded_apps: [] })).calendar_names, null);
  assert.equal(parseConfig(JSON.stringify({ calendar_names: 'oops' })).calendar_names, null);
  assert.equal(parseConfig(JSON.stringify({ calendar_names: [1, 2] })).calendar_names, null);
});

test('parseConfig keeps excluded_apps defaults when field is invalid', () => {
  const c = parseConfig(JSON.stringify({ excluded_apps: 'oops' }));
  assert.deepEqual(c.excluded_apps, ['1Password', 'キーチェーンアクセス']);
});
```

import 行に `parseConfig` を追加(`from '../src/util.ts'`)。

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL(`parseConfig` is not exported)

- [ ] **Step 3: 実装**

`src/util.ts` の `ScrippoConfig`〜`loadConfig` を以下に置き換え:

```ts
export interface ScrippoConfig {
  excluded_apps: string[];
  /** 対象カレンダー名。null = 未設定(bin/ocr のデフォルト判定 = プライマリカレンダーのみ) */
  calendar_names: string[] | null;
}

const DEFAULT_CONFIG: ScrippoConfig = {
  excluded_apps: ['1Password', 'キーチェーンアクセス'],
  calendar_names: null,
};

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** config.json の文字列を検証つきでパース(壊れたフィールドはデフォルトに倒す) */
export function parseConfig(raw: string): ScrippoConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  return {
    excluded_apps: isStringArray(obj.excluded_apps)
      ? obj.excluded_apps
      : [...DEFAULT_CONFIG.excluded_apps],
    calendar_names: isStringArray(obj.calendar_names) ? obj.calendar_names : null,
  };
}

/** config.json を読む。無ければデフォルトを書いて返す。壊れていたらデフォルトで動く */
export function loadConfig(): ScrippoConfig {
  try {
    return parseConfig(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      ensureDataDirs();
      writeFileSecure(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
    }
    return { ...DEFAULT_CONFIG, excluded_apps: [...DEFAULT_CONFIG.excluded_apps] };
  }
}
```

注: デフォルトで書き出される config.json に `"calendar_names": null` が含まれるようになる(ユーザーが編集箇所に気づきやすい)。

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: 全テスト PASS(既存テストの回帰がないこと)

- [ ] **Step 5: Commit**

```bash
git add src/util.ts test/util.test.ts
git commit -m "feat: add calendar_names to config with validated parseConfig"
```

---

### Task 3: overlap 判定と digest 合成(純関数)

**Files:**
- Create: `src/calendar.ts`
- Modify: `src/digest.ts:27-32`(`Digest` インターフェースにカレンダー用フィールド追加)
- Test: `test/calendar.test.ts`(新規)

**Interfaces:**
- Consumes: `Digest`(`src/digest.ts`。`coverage: {first, last}` と `chunks[].start/end` は `HH:MM` 文字列)
- Produces:
  - `interface RawCalendarEvent { start: string; end: string; title: string; calendar: string; all_day: boolean; my_status: string; attendee_count: number }`(start/end は ISO 文字列)
  - `interface DigestCalendarEvent { start: string; end: string; title: string; all_day: boolean; my_status: string; attendee_count: number; overlap?: 'gap' | 'captured' | 'partial' }`(start/end は `HH:MM`。`calendar` フィールドは digest に**含めない** — プロンプトを小さく保つ)
  - `function attachCalendar(digest: Digest, available: boolean, events: RawCalendarEvent[]): Digest` — 元 digest は変更せず新オブジェクトを返す。`available === false` のとき `calendar_available: false` のみ付与し `calendar_events` は付けない
  - `Digest` に追加: `calendar_available?: boolean; calendar_events?: DigestCalendarEvent[]`

- [ ] **Step 1: Digest 型を拡張**

`src/digest.ts` の `Digest` インターフェースに追記:

```ts
export interface DigestCalendarEvent {
  start: string;
  end: string;
  title: string;
  all_day: boolean;
  my_status: string;
  attendee_count: number;
  overlap?: 'gap' | 'captured' | 'partial';
}

export interface Digest {
  date: string;
  coverage: { first: string; last: string; captured_minutes: number; gap_minutes: number };
  app_summary: { app: string; minutes: number }[];
  chunks: DigestChunk[];
  calendar_available?: boolean;
  calendar_events?: DigestCalendarEvent[];
}
```

- [ ] **Step 2: 失敗するテストを書く**

`test/calendar.test.ts` を新規作成:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachCalendar, type RawCalendarEvent } from '../src/calendar.ts';
import type { Digest } from '../src/digest.ts';

function digestWithChunks(chunks: { start: string; end: string }[]): Digest {
  return {
    date: '2026-07-09',
    coverage: { first: '09:00', last: '18:00', captured_minutes: 400, gap_minutes: 140 },
    app_summary: [],
    chunks: chunks.map((c) => ({
      ...c,
      dominant_app: 'Chrome',
      window_titles: [],
      ocr_highlights: '',
      gap_before_minutes: 0,
    })),
  };
}

function ev(start: string, end: string, opts: Partial<RawCalendarEvent> = {}): RawCalendarEvent {
  return {
    start: `2026-07-09T${start}:00+09:00`,
    end: `2026-07-09T${end}:00+09:00`,
    title: 'MTG',
    calendar: 'me@example.com',
    all_day: false,
    my_status: 'accepted',
    attendee_count: 3,
    ...opts,
  };
}

test('event fully inside a captured chunk → overlap: captured', () => {
  const d = attachCalendar(digestWithChunks([{ start: '10:00', end: '11:00' }]), true, [
    ev('10:00', '10:30'),
  ]);
  assert.equal(d.calendar_events![0].overlap, 'captured');
});

test('event fully outside chunks (gap) → overlap: gap', () => {
  const d = attachCalendar(digestWithChunks([{ start: '09:00', end: '10:00' }]), true, [
    ev('13:00', '14:00'),
  ]);
  assert.equal(d.calendar_events![0].overlap, 'gap');
});

test('event with exactly half captured → overlap: partial', () => {
  // chunk 10:00-10:30, event 10:00-11:00 → captured 30/60 = 0.5(どちらも過半でない)
  const d = attachCalendar(digestWithChunks([{ start: '10:00', end: '10:30' }]), true, [
    ev('10:00', '11:00'),
  ]);
  assert.equal(d.calendar_events![0].overlap, 'partial');
});

test('event mostly captured across two chunks → overlap: captured', () => {
  // chunks 10:00-10:25, 10:30-11:00 / event 10:00-11:00 → captured 55/60
  const d = attachCalendar(
    digestWithChunks([
      { start: '10:00', end: '10:25' },
      { start: '10:30', end: '11:00' },
    ]),
    true,
    [ev('10:00', '11:00')],
  );
  assert.equal(d.calendar_events![0].overlap, 'captured');
});

test('all-day event gets no overlap and keeps all_day flag', () => {
  const d = attachCalendar(digestWithChunks([{ start: '09:00', end: '18:00' }]), true, [
    ev('00:00', '00:00', { all_day: true }),
  ]);
  assert.equal(d.calendar_events![0].all_day, true);
  assert.equal(d.calendar_events![0].overlap, undefined);
});

test('zero-length event gets no overlap', () => {
  const d = attachCalendar(digestWithChunks([{ start: '09:00', end: '18:00' }]), true, [
    ev('10:00', '10:00'),
  ]);
  assert.equal(d.calendar_events![0].overlap, undefined);
});

test('digest events use HH:MM and drop the calendar field, keep status fields', () => {
  const d = attachCalendar(digestWithChunks([{ start: '09:00', end: '18:00' }]), true, [
    ev('10:00', '10:30', { my_status: 'declined', attendee_count: 7 }),
  ]);
  const e = d.calendar_events![0];
  assert.equal(e.start, '10:00');
  assert.equal(e.end, '10:30');
  assert.equal(e.my_status, 'declined');
  assert.equal(e.attendee_count, 7);
  assert.equal('calendar' in e, false);
});

test('attachCalendar with available=false sets flag and omits events', () => {
  const d = attachCalendar(digestWithChunks([]), false, []);
  assert.equal(d.calendar_available, false);
  assert.equal(d.calendar_events, undefined);
});

test('attachCalendar does not mutate the input digest', () => {
  const original = digestWithChunks([{ start: '09:00', end: '10:00' }]);
  attachCalendar(original, true, [ev('09:00', '09:30')]);
  assert.equal(original.calendar_events, undefined);
  assert.equal(original.calendar_available, undefined);
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL(`src/calendar.ts` が存在しない)

- [ ] **Step 4: 実装**

`src/calendar.ts` を新規作成(前半。バイナリ呼び出しは Task 4 で同ファイルに追記):

```ts
// カレンダー予定の取得(bin/ocr calendar-events)と digest への合成
import type { Digest, DigestCalendarEvent } from './digest.ts';

export interface RawCalendarEvent {
  start: string; // ISO文字列 (例: 2026-07-09T10:00:00+09:00)
  end: string;
  title: string;
  calendar: string;
  all_day: boolean;
  my_status: string;
  attendee_count: number;
}

/** ISO文字列/HH:MM文字列の壁時計 HH:MM を分数に(digest.ts の minuteOf と同じ規約) */
function minuteOf(time: string): number {
  const m = time.match(/(?:T|^)(\d{2}):(\d{2})/);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

function hhmm(time: string): string {
  const m = time.match(/(?:T|^)(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '00:00';
}

/** [start, end) 区間の重なり分数 */
function overlapMinutes(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * イベント時間帯とキャプチャ済み区間(chunk)の突合。
 * 過半がキャプチャ済みなら captured、過半が空白なら gap、どちらも過半でなければ partial
 */
function judgeOverlap(event: RawCalendarEvent, chunks: { start: string; end: string }[]):
  DigestCalendarEvent['overlap'] {
  const evStart = minuteOf(event.start);
  const evEnd = minuteOf(event.end);
  const total = evEnd - evStart;
  if (total <= 0) return undefined;
  let captured = 0;
  for (const c of chunks) {
    captured += overlapMinutes(evStart, evEnd, minuteOf(c.start), minuteOf(c.end));
  }
  if (captured / total > 0.5) return 'captured';
  if ((total - captured) / total > 0.5) return 'gap';
  return 'partial';
}

/** digest に calendar_available / calendar_events を付与した新オブジェクトを返す(入力は不変) */
export function attachCalendar(
  digest: Digest,
  available: boolean,
  events: RawCalendarEvent[],
): Digest {
  if (!available) return { ...digest, calendar_available: false };
  const calendar_events: DigestCalendarEvent[] = events.map((e) => {
    const out: DigestCalendarEvent = {
      start: hhmm(e.start),
      end: hhmm(e.end),
      title: e.title,
      all_day: e.all_day,
      my_status: e.my_status,
      attendee_count: e.attendee_count,
    };
    if (!e.all_day) {
      const overlap = judgeOverlap(e, digest.chunks);
      if (overlap) out.overlap = overlap;
    }
    return out;
  });
  return { ...digest, calendar_available: true, calendar_events };
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npm test`
Expected: 全テスト PASS

- [ ] **Step 6: Commit**

```bash
git add src/calendar.ts src/digest.ts test/calendar.test.ts
git commit -m "feat: add calendar overlap judgement and digest attachment"
```

---

### Task 4: バイナリ呼び出しと report 統合

**Files:**
- Modify: `src/calendar.ts`(fetch 部分を追記)
- Modify: `src/report.ts:174-193`(`runReport` に合成を追加)
- Test: `test/calendar.test.ts`(parse のテストを追記)

**Interfaces:**
- Consumes: Task 1 の CLI 仕様 / Task 2 の `loadConfig().calendar_names` / Task 3 の `attachCalendar`
- Produces:
  - `function parseCalendarOutput(stdout: string): { available: boolean; events: RawCalendarEvent[] }`(純関数、検証つき)
  - `function fetchCalendarEvents(date: string, calendarNames: string[] | null): { available: boolean; events: RawCalendarEvent[] }`(失敗はすべて `{available: false, events: []}` に倒す)

- [ ] **Step 1: parseCalendarOutput の失敗するテストを書く**

`test/calendar.test.ts` に追記(import に `parseCalendarOutput` を追加):

```ts
// --- parseCalendarOutput ---

test('parseCalendarOutput accepts valid output', () => {
  const out = parseCalendarOutput(
    JSON.stringify({
      authorized: true,
      events: [
        {
          start: '2026-07-09T10:00:00+09:00',
          end: '2026-07-09T11:00:00+09:00',
          title: 'チーム定例',
          calendar: 'me@example.com',
          all_day: false,
          my_status: 'accepted',
          attendee_count: 5,
        },
      ],
    }),
  );
  assert.equal(out.available, true);
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].title, 'チーム定例');
});

test('parseCalendarOutput treats unauthorized as unavailable', () => {
  const out = parseCalendarOutput(JSON.stringify({ authorized: false, events: [] }));
  assert.equal(out.available, false);
  assert.deepEqual(out.events, []);
});

test('parseCalendarOutput treats broken JSON or wrong shape as unavailable', () => {
  assert.equal(parseCalendarOutput('not json').available, false);
  assert.equal(parseCalendarOutput(JSON.stringify({ authorized: true })).available, false);
  assert.equal(
    parseCalendarOutput(JSON.stringify({ authorized: true, events: [{ title: 1 }] })).available,
    false,
  );
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL(`parseCalendarOutput` is not exported)

- [ ] **Step 3: fetch 部分を実装**

`src/calendar.ts` の先頭 import を更新し、末尾に追記:

```ts
import { execFileSync } from 'node:child_process';
import path from 'node:path';
```

```ts
const OCR_BIN = path.join(import.meta.dirname, '..', 'bin', 'ocr');

function isRawEvent(v: unknown): v is RawCalendarEvent {
  const e = v as Record<string, unknown>;
  return (
    typeof e === 'object' && e !== null &&
    typeof e.start === 'string' && typeof e.end === 'string' &&
    typeof e.title === 'string' && typeof e.calendar === 'string' &&
    typeof e.all_day === 'boolean' && typeof e.my_status === 'string' &&
    typeof e.attendee_count === 'number'
  );
}

/** bin/ocr calendar-events の出力を検証つきでパース。不正はすべて unavailable に倒す */
export function parseCalendarOutput(stdout: string): { available: boolean; events: RawCalendarEvent[] } {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (parsed.authorized !== true) return { available: false, events: [] };
    if (!Array.isArray(parsed.events) || !parsed.events.every(isRawEvent)) {
      return { available: false, events: [] };
    }
    return { available: true, events: parsed.events };
  } catch {
    return { available: false, events: [] };
  }
}

/**
 * 予定を取得。calendarNames が null なら --calendars を省略(Swift側デフォルト=プライマリのみ)。
 * バイナリ欠如・失敗・権限なしはすべて {available: false} に倒し、report を止めない。
 * 初回実行時は権限ダイアログでユーザー操作を待つため timeout は長めに取る
 */
export function fetchCalendarEvents(
  date: string,
  calendarNames: string[] | null,
): { available: boolean; events: RawCalendarEvent[] } {
  const args = ['calendar-events', '--date', date];
  if (calendarNames !== null) args.push('--calendars', calendarNames.join(','));
  try {
    const stdout = execFileSync(OCR_BIN, args, { encoding: 'utf8', timeout: 120_000 });
    return parseCalendarOutput(stdout);
  } catch {
    return { available: false, events: [] };
  }
}
```

- [ ] **Step 4: runReport に組み込む**

`src/report.ts` の import に追加:

```ts
import { fetchCalendarEvents, attachCalendar } from './calendar.ts';
import { loadConfig } from './util.ts';
```

(`loadConfig` は既存の `./util.ts` import 行に追加する)

`runReport` 内、`const digest = getDigest(options.date, options.force);` の直後に挿入:

```ts
  // 予定はキャッシュに入れず毎回取得して合成(権限なし・失敗時は従来どおりの日報生成)
  const calendar = fetchCalendarEvents(options.date, loadConfig().calendar_names);
  const digestWithCalendar = attachCalendar(digest, calendar.available, calendar.events);
```

以降の `buildPrompt(template.body, options.date, JSON.stringify(digest))` を `JSON.stringify(digestWithCalendar)` に変更。あわせて生成中メッセージの後に状態を1行出す:

```ts
  console.log(
    calendar.available
      ? `カレンダー予定: ${calendar.events.length}件`
      : 'カレンダー予定: 取得できません(権限未許可または未設定。scrippo status で確認)',
  );
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npm test`
Expected: 全テスト PASS

- [ ] **Step 6: Commit**

```bash
git add src/calendar.ts src/report.ts test/calendar.test.ts
git commit -m "feat: fetch calendar events at report time and merge into digest"
```

---

### Task 5: `scrippo status` にカレンダー診断を追加

**Files:**
- Modify: `src/cli.ts:105-141`(`cmdStatus`)

**Interfaces:**
- Consumes: Task 1 の `--list-calendars` 出力 / Task 2 の `loadConfig().calendar_names`

- [ ] **Step 1: 実装**

`src/cli.ts` の import に `loadConfig` を追加(既存の `./util.ts` import 行)。`cmdStatus` の画面収録権限ブロックの直後に追記:

```ts
  // カレンダー権限と対象カレンダーの診断
  let calendarLine = '不明(bin/ocr 未ビルド?)';
  try {
    const cal = JSON.parse(
      execFileSync(OCR_BIN, ['calendar-events', '--list-calendars'], {
        encoding: 'utf8',
        timeout: 120_000, // 初回は権限ダイアログでユーザー操作を待つ
      }),
    );
    if (cal.authorized !== true) {
      calendarLine =
        '要確認(権限がありません。システム設定 > プライバシーとセキュリティ > カレンダー を確認)';
    } else {
      const names = loadConfig().calendar_names;
      const calendars: { name: string; default_selected: boolean }[] = Array.isArray(cal.calendars)
        ? cal.calendars
        : [];
      const selected = names
        ? calendars.filter((c) => names.includes(c.name) || names.includes('*'))
        : calendars.filter((c) => c.default_selected);
      calendarLine = `OK(対象: ${selected.map((c) => c.name).join(', ') || '(なし)'})`;
      if (selected.length === 0) {
        calendarLine += '\n                  利用可能: ' + calendars.map((c) => c.name).join(', ');
      }
    }
  } catch {
    // bin/ocr が無い・失敗
  }
  console.log(`カレンダー:       ${calendarLine}`);
```

- [ ] **Step 2: 手動検証**

Run: `node src/cli.ts status`
Expected: `カレンダー:       OK(対象: <自分のメールアドレス>)` の行が出る。
`~/.scrippo/config.json` に `"calendar_names": ["存在しない名前"]` を設定して再実行 → `対象: (なし)` と利用可能一覧が出る。確認後 `null` に戻す。

- [ ] **Step 3: 回帰確認と Commit**

Run: `npm test`
Expected: PASS

```bash
git add src/cli.ts
git commit -m "feat: show calendar permission and target calendars in status"
```

---

### Task 6: テンプレート更新

**Files:**
- Modify: `templates/gyomu-nippo.md`
- Modify: `templates/furikaeri.md`

- [ ] **Step 1: gyomu-nippo.md を更新**

冒頭の指示文の直後(`# 出力フォーマット` の前)に追記:

```markdown
digest に calendar_events がある場合の扱い:
- overlap が "gap" のイベントは会議として「本日の作業」に時間帯つきで記載する
- overlap が "captured" のイベントは、その時間帯の画面作業と併記する(会議中の画面作業、または不参加の可能性)
- my_status が "declined" の会議は原則作業に数えない。ただし overlap が "gap" なら実際には出ていた可能性として備考に回す
- all_day: true のイベントは時間帯には入れず備考に記載する
- calendar_events が無い場合はこれらの指示を無視してよい
```

「備考」セクションの説明を更新:

```markdown
### 備考
キャプチャ空白が大きい時間帯のうち、calendar_events で説明がつかないもの(外出・離席の可能性)はここに記載。
終日イベントもここに記載。
```

- [ ] **Step 2: furikaeri.md を更新**

冒頭の指示文の直後に追記:

```markdown
digest に calendar_events がある場合は「予定と実績」セクションを含める。無い場合はセクションごと省略する。
```

「気づき」セクションの前に追記:

```markdown
### 予定と実績
- 予定どおり参加した会議(overlap: gap / partial のイベント)と会議に費やした合計時間
- 予定外に使った時間帯(カレンダー上は空きだが作業が途切れた・切り替えが多かった区間)
- 会議と会議の間の細切れ時間をどう使えたか
```

- [ ] **Step 3: 手動検証と Commit**

Run: `node src/cli.ts templates`
Expected: 2テンプレートが従来どおり一覧表示される(フロントマター破壊がないこと)。

```bash
git add templates/gyomu-nippo.md templates/furikaeri.md
git commit -m "feat: teach templates to use calendar_events"
```

---

### Task 7: README 更新

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 動作要件に追記**

「macOS権限」の行を以下に変更し、Googleアカウント同期の行を追加:

```markdown
- macOS権限: 画面収録(screencapture とウィンドウタイトル取得の両方をこの1つでカバー)
- macOS権限: カレンダーへのフルアクセス(日報にカレンダーの予定を含める場合。任意)
- Googleカレンダー連携する場合: システム設定 > インターネットアカウント に Google アカウントを追加し、カレンダー同期を有効化
```

- [ ] **Step 2: 「カレンダー連携」セクションを新設**

「使い方」セクションの後に追加:

```markdown
## カレンダー連携(任意)

macOSカレンダー.appに同期された予定を、日報生成時に読み取って突合します(EventKit使用・外部送信なし)。

- デフォルトでは**自分のメールアドレスを名前に持つカレンダー**(Googleアカウントのプライマリカレンダー)のみが対象
- 変更する場合は `~/.scrippo/config.json` の `calendar_names` にカレンダー名を列挙(`["*"]` で全カレンダー)
- 利用可能なカレンダー名と現在の対象は `scrippo status` で確認できます

予定はログ(JSONL)やキャッシュには保存されず、日報生成時にのみ読み取られます。対象外カレンダーの情報は Swift バイナリの外に出ません。
```

- [ ] **Step 3: プライバシー設計に追記**

「プライバシー設計」の箇条書きに追加:

```markdown
- カレンダーの予定はディスクに保存せず、日報生成時にのみ読み取って Codex へのプロンプトに含める
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document calendar integration in README"
```

---

### Task 8: E2E 手動検証

**Files:** なし(検証のみ)

- [ ] **Step 1: 実データで report を生成**

```bash
node src/cli.ts report --force
node src/cli.ts report --template furikaeri --force
```

確認ポイント:
- 「カレンダー予定: N件」が実際の当日の予定数と合う
- 日報の「本日の作業」に、キャプチャ空白と重なる会議が時間帯つきで載る
- 振り返りに「予定と実績」セクションが出る
- 予定ゼロの日・権限を一時的にオフにした状態でも従来どおり日報が生成される(オフ確認後は戻す)

- [ ] **Step 2: プロンプト調整(必要なら)**

出力が期待とずれる場合はテンプレートの指示文だけを調整して再実行(`--force`)。コードは変更しない。

- [ ] **Step 3: 最終確認と Commit**

Run: `npm test`
Expected: 全テスト PASS

```bash
git add -A
git commit -m "docs: template prompt adjustments after E2E verification"
```

(調整がなければこのコミットは不要)
