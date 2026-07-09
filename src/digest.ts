// JSONL → digest.json(決定的処理・LLM不使用)
import { normalizeOcrText } from './util.ts';

export interface DisplayRecord {
  id: number;
  ocr_text: string;
  confidence: number;
}

export interface CaptureRecord {
  ts: string;
  app?: string;
  window_title?: string;
  displays?: DisplayRecord[];
  skip_reason?: string | null;
}

export interface DigestChunk {
  start: string;
  end: string;
  dominant_app: string;
  window_titles: string[];
  ocr_highlights: string;
  gap_before_minutes: number;
}

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

const BUCKET_MINUTES = 10;
const MAX_CHUNK_MINUTES = 40;
const GAP_THRESHOLD_MINUTES = 5;
const DIGEST_MAX_BYTES = 50 * 1024;
const HIGHLIGHT_LIMITS = [1500, 1000, 600, 400, 250, 150, 100];
const MAX_TITLES_PER_CHUNK = 10;
const PRIORITY_LINE = /#\d+|!\d+|https?:\/\//;

/** ts文字列の壁時計 HH:MM を深夜0時からの分数に変換(タイムゾーン変換はしない) */
function minuteOf(ts: string): number {
  const m = ts.match(/T(\d{2}):(\d{2})/);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * チャンク内OCRテキストの要点抽出:
 * 行単位で重複除去し、URL・チケット番号・MR番号らしき行を優先して maxBytes まで残す
 */
export function selectHighlights(texts: string[], maxBytes: number): string {
  const seen = new Set<string>();
  const priority: string[] = [];
  const rest: string[] = [];
  for (const text of texts) {
    for (const line of normalizeOcrText(text).split('\n')) {
      if (line === '' || seen.has(line)) continue;
      seen.add(line);
      (PRIORITY_LINE.test(line) ? priority : rest).push(line);
    }
  }
  const out: string[] = [];
  let bytes = 0;
  for (const line of [...priority, ...rest]) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + (out.length > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) continue;
    out.push(line);
    bytes += lineBytes;
  }
  return out.join('\n');
}

interface Segment {
  records: CaptureRecord[];
  gapBefore: number;
}

/** 5分以上のキャプチャ空白でレコード列を分割 */
function splitByGaps(records: CaptureRecord[]): Segment[] {
  const segments: Segment[] = [];
  let current: CaptureRecord[] = [];
  let gapBefore = 0;
  for (const record of records) {
    if (current.length > 0) {
      const gap = minuteOf(record.ts) - minuteOf(current[current.length - 1].ts) - 1;
      if (gap >= GAP_THRESHOLD_MINUTES) {
        segments.push({ records: current, gapBefore });
        current = [];
        gapBefore = gap;
      }
    }
    current.push(record);
  }
  if (current.length > 0) segments.push({ records: current, gapBefore });
  return segments;
}

interface Bucket {
  records: CaptureRecord[];
  dominantApp: string;
}

function dominantApp(records: CaptureRecord[]): string {
  const counts = new Map<string, number>();
  for (const r of records) {
    const app = r.app ?? '(unknown)';
    counts.set(app, (counts.get(app) ?? 0) + 1);
  }
  let best = '(unknown)';
  let bestCount = -1;
  for (const [app, count] of counts) {
    if (count > bestCount) {
      best = app;
      bestCount = count;
    }
  }
  return best;
}

/** セグメント内をクロック整列の10分バケットに分け、同一dominant_appを最大40分までマージ */
function chunkSegment(segment: Segment, highlightLimit: number): DigestChunk[] {
  const buckets: Bucket[] = [];
  let currentKey = -1;
  for (const record of segment.records) {
    const key = Math.floor(minuteOf(record.ts) / BUCKET_MINUTES);
    if (key !== currentKey) {
      buckets.push({ records: [], dominantApp: '' });
      currentKey = key;
    }
    buckets[buckets.length - 1].records.push(record);
  }
  for (const b of buckets) b.dominantApp = dominantApp(b.records);

  const merged: Bucket[][] = [];
  for (const bucket of buckets) {
    const group = merged[merged.length - 1];
    if (group && group[0].dominantApp === bucket.dominantApp) {
      const start = minuteOf(group[0].records[0].ts);
      const end = minuteOf(bucket.records[bucket.records.length - 1].ts) + 1;
      if (end - start <= MAX_CHUNK_MINUTES) {
        group.push(bucket);
        continue;
      }
    }
    merged.push([bucket]);
  }

  return merged.map((group, i) => {
    const records = group.flatMap((b) => b.records);
    const titles: string[] = [];
    const texts: string[] = [];
    for (const r of records) {
      if (r.skip_reason === 'excluded') continue;
      if (r.window_title && !titles.includes(r.window_title) && titles.length < MAX_TITLES_PER_CHUNK) {
        titles.push(r.window_title);
      }
      if (!r.skip_reason && r.displays) {
        for (const d of r.displays) texts.push(d.ocr_text);
      }
    }
    return {
      start: hhmm(minuteOf(records[0].ts)),
      end: hhmm(minuteOf(records[records.length - 1].ts) + 1),
      dominant_app: dominantApp(records),
      window_titles: titles,
      ocr_highlights: selectHighlights(texts, highlightLimit),
      gap_before_minutes: i === 0 ? segment.gapBefore : 0,
    };
  });
}

function buildDigestOnce(date: string, records: CaptureRecord[], highlightLimit: number): Digest {
  const sorted = [...records].sort((a, b) => minuteOf(a.ts) - minuteOf(b.ts));
  if (sorted.length === 0) {
    return {
      date,
      coverage: { first: '', last: '', captured_minutes: 0, gap_minutes: 0 },
      app_summary: [],
      chunks: [],
    };
  }

  const firstMin = minuteOf(sorted[0].ts);
  const lastMin = minuteOf(sorted[sorted.length - 1].ts);
  const coverage = {
    first: hhmm(firstMin),
    last: hhmm(lastMin),
    captured_minutes: sorted.length,
    gap_minutes: lastMin - firstMin + 1 - sorted.length,
  };

  const appMinutes = new Map<string, number>();
  for (const r of sorted) {
    const app = r.app ?? '(unknown)';
    appMinutes.set(app, (appMinutes.get(app) ?? 0) + 1);
  }
  const app_summary = [...appMinutes.entries()]
    .map(([app, minutes]) => ({ app, minutes }))
    .sort((a, b) => b.minutes - a.minutes || a.app.localeCompare(b.app));

  const chunks = splitByGaps(sorted).flatMap((seg) => chunkSegment(seg, highlightLimit));

  return { date, coverage, app_summary, chunks };
}

/** digest を生成。50KB を超える場合は ocr_highlights の上限を段階的に縮めて再生成 */
export function buildDigest(date: string, records: CaptureRecord[]): Digest {
  let digest = buildDigestOnce(date, records, HIGHLIGHT_LIMITS[0]);
  for (const limit of HIGHLIGHT_LIMITS.slice(1)) {
    if (Buffer.byteLength(JSON.stringify(digest), 'utf8') <= DIGEST_MAX_BYTES) break;
    digest = buildDigestOnce(date, records, limit);
  }
  return digest;
}
