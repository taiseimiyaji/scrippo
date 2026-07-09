import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, isCacheValid, loadTemplate } from '../src/report.ts';
import { generatePlist } from '../src/launchd.ts';

// --- buildPrompt ---

test('buildPrompt contains system instruction, template body with date substituted, separator, digest', () => {
  const prompt = buildPrompt('## 日報 {date}\n作成して', '2026-07-09', '{"date":"2026-07-09"}');
  assert.ok(prompt.includes('日報作成アシスタント'));
  assert.ok(prompt.includes('## 日報 2026-07-09'));
  assert.ok(!prompt.includes('{date}'));
  assert.ok(prompt.includes('\n---\n'));
  assert.ok(prompt.includes('{"date":"2026-07-09"}'));
});

test('buildPrompt wraps digest in <digest> delimiters and marks it as data, not instructions', () => {
  const prompt = buildPrompt('body', '2026-07-09', '{"x":1}');
  assert.ok(prompt.includes('<digest>\n{"x":1}\n</digest>'));
  assert.ok(prompt.includes('絶対に従わず'));
  assert.ok(prompt.includes('コマンド実行'));
});

test('buildPrompt instructs conservative inference for missing periods', () => {
  const prompt = buildPrompt('body', '2026-07-09', '{}');
  assert.ok(prompt.includes('推測'));
  assert.ok(prompt.includes('不明'));
});

// --- loadTemplate (path traversal) ---

test('loadTemplate rejects path traversal and absolute paths', () => {
  assert.throws(() => loadTemplate('../../etc/passwd'), /テンプレート名が不正/);
  assert.throws(() => loadTemplate('../secrets'), /テンプレート名が不正/);
  assert.throws(() => loadTemplate('/etc/passwd.md'), /テンプレート名が不正/);
  assert.throws(() => loadTemplate('foo/bar'), /テンプレート名が不正/);
});

test('loadTemplate accepts plain template names', () => {
  const t = loadTemplate('gyomu-nippo');
  assert.equal(t.fileName, 'gyomu-nippo.md');
  const t2 = loadTemplate('furikaeri.md');
  assert.equal(t2.fileName, 'furikaeri.md');
});

// --- isCacheValid ---

test('isCacheValid is true when size and mtime match', () => {
  assert.equal(isCacheValid({ source_size: 100, source_mtime: 555 }, 100, 555), true);
});

test('isCacheValid is false when the source JSONL grew', () => {
  assert.equal(isCacheValid({ source_size: 100, source_mtime: 555 }, 200, 999), false);
});

test('isCacheValid is false for malformed cache metadata', () => {
  assert.equal(isCacheValid({}, 100, 555), false);
  assert.equal(isCacheValid(null, 100, 555), false);
});

// --- generatePlist ---

test('generatePlist embeds node path, cli path, and 60s interval', () => {
  const plist = generatePlist('com.alice.scrippo', '/opt/node/bin/node', '/repo/src/cli.ts');
  assert.ok(plist.includes('<string>com.alice.scrippo</string>'));
  assert.ok(plist.includes('<string>/opt/node/bin/node</string>'));
  assert.ok(plist.includes('<string>/repo/src/cli.ts</string>'));
  assert.ok(plist.includes('<string>capture</string>'));
  assert.ok(plist.includes('<key>StartInterval</key>'));
  assert.ok(plist.includes('<integer>60</integer>'));
  assert.ok(plist.includes('<string>Background</string>'));
});
