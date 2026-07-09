// カレンダー予定の取得(bin/ocr calendar-events)と digest への合成
import { execFileSync } from 'node:child_process';
import path from 'node:path';
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

/** ISO文字列を digest 対象日の分数にクランプ(前日開始は0、翌日終了は1440) */
function clampToDay(iso: string, date: string): number {
  const d = iso.slice(0, 10);
  if (d < date) return 0;
  if (d > date) return 24 * 60;
  return minuteOf(iso);
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
function judgeOverlap(
  event: RawCalendarEvent,
  date: string,
  chunks: { start: string; end: string }[],
): DigestCalendarEvent['overlap'] {
  const evStart = clampToDay(event.start, date);
  const evEnd = clampToDay(event.end, date);
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
      const overlap = judgeOverlap(e, digest.date, digest.chunks);
      if (overlap) out.overlap = overlap;
    }
    return out;
  });
  return { ...digest, calendar_available: true, calendar_events };
}

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
