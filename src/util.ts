// scrippo 共通ユーティリティ(純関数 + データディレクトリ管理)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DATA_DIR = path.join(os.homedir(), '.scrippo');
export const LOGS_DIR = path.join(DATA_DIR, 'logs');
export const REPORTS_DIR = path.join(DATA_DIR, 'reports');
export const DIGEST_CACHE_DIR = path.join(DATA_DIR, 'digest-cache');
export const LAST_CAPTURE_FILE = path.join(DATA_DIR, '.last-capture.json');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const ERROR_LOG_FILE = path.join(DATA_DIR, 'capture-error.log');

export interface DisplayText {
  id: number;
  ocr_text: string;
}

/** OCRテキストの正規化: 行内の連続空白を1つに圧縮、行頭行末trim、空行除去 */
export function normalizeOcrText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/** 行集合のJaccard係数。両方空(行なし)は同一とみなし1 */
export function jaccardLines(a: string, b: string): number {
  const setA = new Set(normalizeOcrText(a).split('\n').filter((l) => l !== ''));
  const setB = new Set(normalizeOcrText(b).split('\n').filter((l) => l !== ''));
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const line of setA) if (setB.has(line)) intersection++;
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

const DUPLICATE_THRESHOLD = 0.9;

/** 前回と今回の全ディスプレイテキストを比較し、全てが閾値以上ならduplicate */
export function isDuplicateCapture(prev: DisplayText[], curr: DisplayText[]): boolean {
  if (prev.length !== curr.length) return false;
  const prevById = new Map(prev.map((d) => [d.id, d.ocr_text]));
  for (const d of curr) {
    const prevText = prevById.get(d.id);
    if (prevText === undefined) return false;
    if (jaccardLines(prevText, d.ocr_text) < DUPLICATE_THRESHOLD) return false;
  }
  return true;
}

/** ログが maxBytes を超えていたら古い半分を行境界で切り捨てる */
export function truncateLogContent(content: string, maxBytes: number): string {
  const buf = Buffer.from(content, 'utf8');
  if (buf.byteLength <= maxBytes) return content;
  const half = buf.subarray(Math.floor(buf.byteLength / 2));
  const text = half.toString('utf8');
  const firstNewline = text.indexOf('\n');
  return firstNewline === -1 ? text : text.slice(firstNewline + 1);
}

/** テンプレートのフロントマター(`---` 区切り、key: value のみ)を解析 */
export function parseFrontmatter(md: string): { meta: Record<string, string>; body: string } {
  const match = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { meta: {}, body: md };
  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) meta[key] = value;
  }
  return { meta, body: md.slice(match[0].length) };
}

/** LLM出力からMarkdown本文を抽出(コードフェンスで包まれていたら剥がす) */
export function extractMarkdown(raw: string): string {
  const trimmed = raw.trim();
  // 全体がフェンスで包まれている場合
  const whole = trimmed.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (whole) return whole[1].trim();
  // 前置きの後にフェンスされたMarkdownがある場合
  const inner = trimmed.match(/```(?:markdown|md)\n([\s\S]*?)\n?```/);
  if (inner) return inner[1].trim();
  return trimmed;
}

/** ~/.scrippo 一式を 700/600 で用意する */
export function ensureDataDirs(): void {
  for (const dir of [DATA_DIR, LOGS_DIR, REPORTS_DIR, DIGEST_CACHE_DIR]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/** 600 でファイルを書く(既存でもパーミッションを揃える) */
export function writeFileSecure(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

/** 600 で追記する */
export function appendFileSecure(filePath: string, content: string): void {
  fs.appendFileSync(filePath, content, { mode: 0o600 });
}

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

/** capture-error.log に1行追記(1MB超なら古い半分を切り捨て) */
export function logCaptureError(message: string): void {
  try {
    ensureDataDirs();
    const line = `${new Date().toISOString()} ${message.replace(/\n/g, ' ')}\n`;
    let existing = '';
    try {
      existing = fs.readFileSync(ERROR_LOG_FILE, 'utf8');
    } catch {
      // 初回は無くてよい
    }
    const rotated = truncateLogContent(existing, 1024 * 1024);
    if (rotated !== existing) {
      writeFileSecure(ERROR_LOG_FILE, rotated);
    }
    appendFileSecure(ERROR_LOG_FILE, line);
  } catch {
    // エラーログ自体の失敗は握りつぶす(毎分実行のため)
  }
}

/** ローカルタイムゾーンで YYYY-MM-DD */
export function localDateString(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** ローカルタイムゾーンオフセット付き ISO 文字列 (例: 2026-07-09T10:23:00+09:00) */
export function localIsoString(d: Date = new Date()): string {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const offset = `${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`;
  return (
    `${localDateString(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${offset}`
  );
}
