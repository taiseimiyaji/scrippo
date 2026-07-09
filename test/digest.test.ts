import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest, selectHighlights, type CaptureRecord } from '../src/digest.ts';

function rec(hhmm: string, app: string, text: string | null, opts: Partial<CaptureRecord> = {}): CaptureRecord {
  const base: CaptureRecord = {
    ts: `2026-07-09T${hhmm}:00+09:00`,
    app,
    window_title: `${app} window`,
    skip_reason: null,
  };
  if (text !== null) {
    base.displays = [{ id: 1, ocr_text: text, confidence: 0.9 }];
  }
  return { ...base, ...opts };
}

// --- coverage ---

test('coverage reports first/last/captured/gap minutes', () => {
  const records = [
    rec('09:00', 'Chrome', 'a'),
    rec('09:01', 'Chrome', 'b'),
    rec('09:10', 'Chrome', 'c'), // 8分の空白 (09:02..09:09)
  ];
  const d = buildDigest('2026-07-09', records);
  assert.equal(d.coverage.first, '09:00');
  assert.equal(d.coverage.last, '09:10');
  assert.equal(d.coverage.captured_minutes, 3);
  assert.equal(d.coverage.gap_minutes, 8);
});

// --- app_summary ---

test('app_summary counts minutes per app, sorted descending', () => {
  const records = [
    rec('09:00', 'iTerm2', 'a'),
    rec('09:01', 'Chrome', 'b'),
    rec('09:02', 'Chrome', 'c'),
  ];
  const d = buildDigest('2026-07-09', records);
  assert.deepEqual(d.app_summary, [
    { app: 'Chrome', minutes: 2 },
    { app: 'iTerm2', minutes: 1 },
  ]);
});

test('app_summary includes skipped records (duplicate/excluded) in minutes', () => {
  const records = [
    rec('09:00', 'Chrome', 'a'),
    rec('09:01', 'Chrome', null, { skip_reason: 'duplicate' }),
    rec('09:02', '1Password', null, { skip_reason: 'excluded', window_title: undefined }),
  ];
  const d = buildDigest('2026-07-09', records);
  assert.deepEqual(d.app_summary, [
    { app: 'Chrome', minutes: 2 },
    { app: '1Password', minutes: 1 },
  ]);
});

// --- chunks ---

test('consecutive 10-min buckets with same dominant app merge up to 40 minutes', () => {
  // 09:00〜09:59 全てChrome → 40分チャンク + 20分チャンク
  const records = [];
  for (let m = 0; m < 60; m++) {
    records.push(rec(`09:${String(m).padStart(2, '0')}`, 'Chrome', `text ${m}`));
  }
  const d = buildDigest('2026-07-09', records);
  assert.equal(d.chunks.length, 2);
  assert.equal(d.chunks[0].start, '09:00');
  assert.equal(d.chunks[0].end, '09:40');
  assert.equal(d.chunks[1].start, '09:40');
  assert.equal(d.chunks[1].end, '10:00');
  assert.equal(d.chunks[0].dominant_app, 'Chrome');
});

test('buckets with different dominant apps stay separate chunks', () => {
  const records = [];
  for (let m = 0; m < 10; m++) records.push(rec(`09:0${m}`, 'Chrome', `c${m}`));
  for (let m = 10; m < 20; m++) records.push(rec(`09:${m}`, 'iTerm2', `t${m}`));
  const d = buildDigest('2026-07-09', records);
  assert.equal(d.chunks.length, 2);
  assert.equal(d.chunks[0].dominant_app, 'Chrome');
  assert.equal(d.chunks[1].dominant_app, 'iTerm2');
});

test('a gap of 5+ minutes splits chunks and is recorded as gap_before_minutes', () => {
  const records = [
    rec('09:00', 'Chrome', 'a'),
    rec('09:01', 'Chrome', 'b'),
    rec('09:20', 'Chrome', 'c'), // 18分後 = 17分gap
  ];
  const d = buildDigest('2026-07-09', records);
  assert.equal(d.chunks.length, 2);
  assert.equal(d.chunks[0].gap_before_minutes, 0);
  assert.equal(d.chunks[1].gap_before_minutes, 18);
});

test('chunk collects unique window titles, excluding excluded-app records', () => {
  const records = [
    rec('09:00', 'Chrome', 'a', { window_title: 'MR !412 - GitLab' }),
    rec('09:01', 'Chrome', 'b', { window_title: 'MR !412 - GitLab' }),
    rec('09:02', '1Password', null, { skip_reason: 'excluded', window_title: undefined }),
  ];
  const d = buildDigest('2026-07-09', records);
  assert.deepEqual(d.chunks[0].window_titles, ['MR !412 - GitLab']);
});

// --- selectHighlights ---

test('selectHighlights dedupes repeated lines', () => {
  const out = selectHighlights(['foo\nbar', 'foo\nbaz'], 1500);
  const lines = out.split('\n');
  assert.equal(lines.filter((l) => l === 'foo').length, 1);
  assert.ok(lines.includes('bar'));
  assert.ok(lines.includes('baz'));
});

test('selectHighlights keeps URL/ticket/MR lines preferentially under truncation', () => {
  const filler = Array.from({ length: 200 }, (_, i) => `filler line number ${i} with padding`);
  const texts = [...filler, 'see https://example.com/issue', 'Redmine #8821 対応', 'MR !412 レビュー'].join('\n');
  const out = selectHighlights([texts], 200);
  assert.ok(out.includes('https://example.com/issue'));
  assert.ok(out.includes('#8821'));
  assert.ok(out.includes('!412'));
  assert.ok(Buffer.byteLength(out, 'utf8') <= 200);
});

test('selectHighlights returns empty string for no input', () => {
  assert.equal(selectHighlights([], 1500), '');
});

// --- size cap ---

test('digest shrinks highlights to stay under the size cap', () => {
  // 大量のユニークテキスト + 10分ごとにアプリを切り替えてチャンクを増やし50KB超を誘発
  const apps = ['Chrome', 'iTerm2', 'Slack'];
  const records = [];
  for (let h = 9; h < 18; h++) {
    for (let m = 0; m < 60; m++) {
      const app = apps[Math.floor(m / 10) % apps.length];
      const lines = Array.from({ length: 20 }, (_, i) => `h${h} m${m} unique line ${i} ${'x'.repeat(30)}`).join('\n');
      records.push(rec(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, app, lines));
    }
  }
  const d = buildDigest('2026-07-09', records);
  const size = Buffer.byteLength(JSON.stringify(d), 'utf8');
  assert.ok(size <= 50 * 1024, `digest size ${size} should be <= 50KB`);
  assert.ok(d.chunks.length > 0);
});

test('buildDigest with empty records returns an empty-but-valid digest', () => {
  const d = buildDigest('2026-07-09', []);
  assert.equal(d.date, '2026-07-09');
  assert.equal(d.coverage.captured_minutes, 0);
  assert.deepEqual(d.chunks, []);
  assert.deepEqual(d.app_summary, []);
});
