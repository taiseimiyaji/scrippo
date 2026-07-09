// 1回分のキャプチャ処理(launchdから毎分起動される使い捨てプロセス)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LOGS_DIR,
  LAST_CAPTURE_FILE,
  ensureDataDirs,
  appendFileSecure,
  writeFileSecure,
  loadConfig,
  logCaptureError,
  normalizeOcrText,
  isDuplicateCapture,
  localDateString,
  localIsoString,
  type DisplayText,
} from './util.ts';

const OCR_BIN = path.join(import.meta.dirname, '..', 'bin', 'ocr');

interface SessionInfo {
  locked: boolean;
  lock_state_unknown: boolean;
  frontmost_app: string;
  window_title: string;
  on_screen_apps: string[];
  display_count: number;
}

function runOcrBin(args: string[]): unknown {
  const stdout = execFileSync(OCR_BIN, args, { encoding: 'utf8', timeout: 30_000 });
  return JSON.parse(stdout);
}

function appendRecord(record: Record<string, unknown>): void {
  ensureDataDirs();
  const logFile = path.join(LOGS_DIR, `${localDateString()}.jsonl`);
  appendFileSecure(logFile, JSON.stringify(record) + '\n');
}

function readLastCapture(): DisplayText[] | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(LAST_CAPTURE_FILE, 'utf8'));
    if (!Array.isArray(parsed?.displays)) return null;
    return parsed.displays;
  } catch {
    return null;
  }
}

export interface CaptureResult {
  status: 'captured' | 'duplicate' | 'excluded' | 'locked';
}

/**
 * 1回分のキャプチャを実行する。
 * プライバシー境界(ロック・除外アプリ)はフェイルセーフ: 判定に失敗したらキャプチャしない。
 */
export function runCaptureOnce(): CaptureResult {
  // 1. ロック判定(取得失敗・判定不能は「キャプチャしない」側に倒す)
  let info: SessionInfo;
  try {
    info = runOcrBin(['session-info']) as SessionInfo;
  } catch (err) {
    logCaptureError(`session-info failed: ${(err as Error).message}`);
    return { status: 'locked' };
  }
  if (info.lock_state_unknown) {
    logCaptureError('lock state unknown; skipping capture (fail-safe)');
    return { status: 'locked' };
  }
  if (info.locked) {
    return { status: 'locked' };
  }

  // 2. 除外アプリ判定(画面上の全ウィンドウが対象。判定に失敗したらキャプチャしない)
  const config = loadConfig();
  const onScreen = Array.isArray(info.on_screen_apps) ? info.on_screen_apps : null;
  if (onScreen === null) {
    logCaptureError('on_screen_apps unavailable; skipping capture (fail-safe)');
    return { status: 'locked' };
  }
  const excludedOnScreen = onScreen.some((app) => config.excluded_apps.includes(app));
  if (excludedOnScreen) {
    // window_title は記録しない(パスワードマネージャーのタイトルはアイテム名を含み得る)
    appendRecord({
      ts: localIsoString(),
      app: info.frontmost_app,
      skip_reason: 'excluded',
    });
    return { status: 'excluded' };
  }

  // 3. スクショ → OCR(画像は finally で必ず削除)
  const displayCount = Math.max(1, info.display_count || 1);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrippo-'));
  const displays: { id: number; ocr_text: string; confidence: number }[] = [];
  try {
    for (let d = 1; d <= displayCount; d++) {
      const imagePath = path.join(tmpDir, `d${d}.png`);
      execFileSync('/usr/sbin/screencapture', ['-x', '-D', String(d), imagePath], {
        timeout: 30_000,
      });
      const result = runOcrBin(['recognize', imagePath]) as { text: string; confidence: number };
      displays.push({
        id: d,
        ocr_text: normalizeOcrText(result.text),
        confidence: result.confidence,
      });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 4. 重複判定(書き込み時排除でディスク上の平文テキストを最小化)
  const prev = readLastCapture();
  const currTexts: DisplayText[] = displays.map((d) => ({ id: d.id, ocr_text: d.ocr_text }));
  const duplicate = prev !== null && isDuplicateCapture(prev, currTexts);

  ensureDataDirs();
  writeFileSecure(LAST_CAPTURE_FILE, JSON.stringify({ displays: currTexts }));

  if (duplicate) {
    appendRecord({
      ts: localIsoString(),
      app: info.frontmost_app,
      window_title: info.window_title,
      skip_reason: 'duplicate',
    });
    return { status: 'duplicate' };
  }

  appendRecord({
    ts: localIsoString(),
    app: info.frontmost_app,
    window_title: info.window_title,
    displays,
    skip_reason: null,
  });
  return { status: 'captured' };
}

/** launchd から呼ばれるエントリポイント: エラーはログに書いて黙って終了 */
export function captureMain(): void {
  try {
    runCaptureOnce();
  } catch (err) {
    logCaptureError(`capture failed: ${(err as Error).stack ?? String(err)}`);
  }
}
