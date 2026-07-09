import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOcrText,
  jaccardLines,
  isDuplicateCapture,
  truncateLogContent,
  parseFrontmatter,
  extractMarkdown,
  parseConfig,
} from '../src/util.ts';

// --- normalizeOcrText ---

test('normalizeOcrText collapses consecutive spaces/tabs into one', () => {
  assert.equal(normalizeOcrText('foo   bar\t\tbaz'), 'foo bar baz');
});

test('normalizeOcrText keeps line breaks but collapses blank runs and trims line edges', () => {
  assert.equal(normalizeOcrText('  a  \n\n\n  b  '), 'a\nb');
});

test('normalizeOcrText returns empty string for whitespace-only input', () => {
  assert.equal(normalizeOcrText(' \n \t '), '');
});

// --- jaccardLines ---

test('jaccardLines returns 1 for identical texts', () => {
  assert.equal(jaccardLines('a\nb\nc', 'a\nb\nc'), 1);
});

test('jaccardLines returns 0 for disjoint texts', () => {
  assert.equal(jaccardLines('a\nb', 'c\nd'), 0);
});

test('jaccardLines computes intersection over union of line sets', () => {
  // {a,b,c} vs {b,c,d}: |∩|=2, |∪|=4
  assert.equal(jaccardLines('a\nb\nc', 'b\nc\nd'), 0.5);
});

test('jaccardLines treats two empty texts as identical', () => {
  assert.equal(jaccardLines('', ''), 1);
});

test('jaccardLines returns 0 when only one side is empty', () => {
  assert.equal(jaccardLines('', 'a'), 0);
});

// --- isDuplicateCapture ---

test('isDuplicateCapture is true when all display texts are >= 0.9 similar', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  const prev = [{ id: 1, ocr_text: lines }];
  const curr = [{ id: 1, ocr_text: lines }];
  assert.equal(isDuplicateCapture(prev, curr), true);
});

test('isDuplicateCapture is false when a display changed substantially', () => {
  const a = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  const b = Array.from({ length: 20 }, (_, i) => `other ${i}`).join('\n');
  assert.equal(
    isDuplicateCapture([{ id: 1, ocr_text: a }], [{ id: 1, ocr_text: b }]),
    false,
  );
});

test('isDuplicateCapture is false when display count differs', () => {
  const a = 'x\ny';
  assert.equal(
    isDuplicateCapture(
      [{ id: 1, ocr_text: a }],
      [{ id: 1, ocr_text: a }, { id: 2, ocr_text: a }],
    ),
    false,
  );
});

test('isDuplicateCapture is true at exactly 0.9 similarity', () => {
  // 9 shared lines + 1 unique to prev, 9 shared + ... build |∩|=9, |∪|=10 → 0.9
  const shared = Array.from({ length: 9 }, (_, i) => `s${i}`);
  const prev = [...shared, 'only-prev'].join('\n');
  const curr = shared.join('\n');
  assert.equal(
    isDuplicateCapture([{ id: 1, ocr_text: prev }], [{ id: 1, ocr_text: curr }]),
    true,
  );
});

// --- truncateLogContent ---

test('truncateLogContent returns content unchanged when under limit', () => {
  assert.equal(truncateLogContent('a\nb\n', 1024), 'a\nb\n');
});

test('truncateLogContent drops the older half at a line boundary', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `entry-${i}`).join('\n') + '\n';
  const max = Buffer.byteLength(lines) - 1; // just over the limit
  const out = truncateLogContent(lines, max);
  assert.ok(Buffer.byteLength(out) <= Math.ceil(Buffer.byteLength(lines) / 2) + 20);
  assert.ok(out.endsWith('entry-99\n'), 'keeps the newest entries');
  assert.ok(!out.includes('entry-0\n'), 'drops the oldest entries');
  assert.ok(out.startsWith('entry-'), 'starts at a line boundary');
});

// --- parseFrontmatter ---

test('parseFrontmatter extracts name and body', () => {
  const md = '---\nname: 業務日報\n---\n本文です\n# 出力\n';
  const { meta, body } = parseFrontmatter(md);
  assert.equal(meta.name, '業務日報');
  assert.equal(body, '本文です\n# 出力\n');
});

test('parseFrontmatter returns whole text as body when no frontmatter', () => {
  const { meta, body } = parseFrontmatter('こんにちは\n');
  assert.deepEqual(meta, {});
  assert.equal(body, 'こんにちは\n');
});

// --- extractMarkdown ---

test('extractMarkdown unwraps a fenced markdown block', () => {
  const raw = '```markdown\n## 日報 2026-07-09\n本文\n```';
  assert.equal(extractMarkdown(raw), '## 日報 2026-07-09\n本文');
});

test('extractMarkdown unwraps a plain fence', () => {
  const raw = '```\n## 日報\n```\n';
  assert.equal(extractMarkdown(raw), '## 日報');
});

test('extractMarkdown returns trimmed text when not fenced', () => {
  assert.equal(extractMarkdown('  ## 日報\n本文\n'), '## 日報\n本文');
});

test('extractMarkdown keeps inner fences when there is leading prose before the fence', () => {
  const raw = 'こちらが日報です:\n```markdown\n## 日報\n```';
  assert.equal(extractMarkdown(raw), '## 日報');
});

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
