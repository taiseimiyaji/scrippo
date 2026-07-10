#!/usr/bin/env node
// scrippo CLI エントリポイント
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { runCaptureOnce, captureMain } from './capture.ts';
import { runReport, listTemplates } from './report.ts';
import { loadAgent, unloadAgent, isAgentLoaded, launchdLabel } from './launchd.ts';
import {
  LOGS_DIR,
  REPORTS_DIR,
  DIGEST_CACHE_DIR,
  LAST_CAPTURE_FILE,
  ERROR_LOG_FILE,
  ensureDataDirs,
  localDateString,
  loadConfig,
} from './util.ts';

const OCR_BIN = path.join(import.meta.dirname, '..', 'bin', 'ocr');
const CLI_PATH = fileURLToPath(import.meta.url);

const USAGE = `使い方: scrippo <command>

  start                # テストキャプチャ→権限確認OK後に launchd 登録(毎分キャプチャ開始)
  stop                 # launchd 解除 + .last-capture.json 削除
  status               # 稼働状態 / 今日のレコード数 / logs容量 / purge待ち / エラー件数 / 権限診断
  report [--template gyomu-nippo] [--date YYYY-MM-DD] [--force]
  purge [--date YYYY-MM-DD | --all-reported]
  templates            # テンプレート一覧
`;

function listLogDates(): string[] {
  try {
    return fs
      .readdirSync(LOGS_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.replace(/\.jsonl$/, ''))
      .sort();
  } catch {
    return [];
  }
}

function countLines(filePath: string): number {
  try {
    return fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// --- commands ---

function cmdStart(): void {
  ensureDataDirs();
  if (!fs.existsSync(OCR_BIN)) {
    console.error(`bin/ocr がありません。先にビルドしてください: npm run build:ocr`);
    process.exit(1);
  }

  // launchd 登録の前にフォアグラウンドでテストキャプチャ(権限ダイアログを対話コンテキストで発火させる)
  console.log('テストキャプチャを実行しています...');
  let result;
  try {
    result = runCaptureOnce();
  } catch (err) {
    console.error(`テストキャプチャに失敗しました: ${(err as Error).message}`);
    console.error('');
    console.error('画面収録の権限が必要です:');
    console.error('  システム設定 > プライバシーとセキュリティ > 画面収録 で、');
    console.error('  このターミナル(または node)を許可してから再実行してください。');
    process.exit(1);
  }
  if (result.status === 'locked') {
    console.error('画面ロック状態が判定できないかロック中のため、キャプチャできませんでした。');
    console.error('capture-error.log を確認してください。');
    process.exit(1);
  }
  console.log(`テストキャプチャOK (${result.status})`);

  loadAgent(CLI_PATH);
  console.log(`launchd に登録しました: ${launchdLabel()}(毎分キャプチャします)`);
  console.log('停止するには: scrippo stop');
}

function cmdStop(): void {
  const wasLoaded = unloadAgent();
  fs.rmSync(LAST_CAPTURE_FILE, { force: true });
  console.log(wasLoaded ? 'キャプチャを停止しました。' : 'launchd には登録されていませんでした。');
  console.log('.last-capture.json を削除しました。');
}

function cmdStatus(): void {
  const today = localDateString();
  const loaded = isAgentLoaded();
  console.log(`稼働状態:        ${loaded ? '稼働中 (launchd ロード済み)' : '停止中'}`);

  console.log(`今日のレコード数: ${countLines(path.join(LOGS_DIR, `${today}.jsonl`))}`);

  let totalBytes = 0;
  for (const date of listLogDates()) {
    try {
      totalBytes += fs.statSync(path.join(LOGS_DIR, `${date}.jsonl`)).size;
    } catch {
      // 消えた直後は無視
    }
  }
  console.log(`logs 合計サイズ:  ${(totalBytes / 1024).toFixed(1)} KB`);

  const dates = listLogDates();
  console.log(`purge待ちの日:    ${dates.length > 0 ? dates.join(', ') : '(なし)'}`);

  const errorCount = countLines(ERROR_LOG_FILE);
  console.log(`エラーログ件数:   ${errorCount}${errorCount > 0 ? `(${ERROR_LOG_FILE})` : ''}`);

  // 画面収録権限の間接診断: session-info でウィンドウタイトルが取れるか
  let permission = '不明(bin/ocr 未ビルド?)';
  try {
    const info = JSON.parse(
      execFileSync(OCR_BIN, ['session-info'], { encoding: 'utf8', timeout: 10_000 }),
    );
    permission = info.window_title
      ? 'OK(ウィンドウタイトル取得可)'
      : '要確認(ウィンドウタイトルが取得できません。画面収録権限を確認してください)';
  } catch {
    // bin/ocr が無い・失敗
  }
  console.log(`画面収録権限:     ${permission}`);

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
}

async function cmdReport(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      template: { type: 'string', default: 'gyomu-nippo' },
      date: { type: 'string', default: localDateString() },
      force: { type: 'boolean', default: false },
    },
  });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
    console.error(`--date は YYYY-MM-DD 形式で指定してください: ${values.date}`);
    process.exit(1);
  }
  const outPath = await runReport({
    template: values.template,
    date: values.date,
    force: values.force,
  });
  if (outPath) {
    console.log(`日報を保存しました: ${outPath}`);
    console.log('確認したら scrippo purge でログを削除できます。');
  }
}

async function cmdPurge(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      date: { type: 'string' },
      'all-reported': { type: 'boolean', default: false },
    },
  });

  let targets: string[];
  if (values.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
      console.error(`--date は YYYY-MM-DD 形式で指定してください: ${values.date}`);
      process.exit(1);
    }
    targets = [values.date];
  } else if (values['all-reported']) {
    // 日報が生成済みの日だけを対象にする
    let reports: string[] = [];
    try {
      reports = fs.readdirSync(REPORTS_DIR);
    } catch {
      // reports 未作成
    }
    targets = listLogDates().filter((date) => reports.some((r) => r.startsWith(`${date}-`)));
  } else {
    console.error('scrippo purge --date YYYY-MM-DD または --all-reported を指定してください。');
    console.error(`purge待ちの日: ${listLogDates().join(', ') || '(なし)'}`);
    process.exit(1);
    return;
  }

  if (targets.length === 0) {
    console.log('purge 対象がありません。');
    return;
  }

  console.log(`削除対象: ${targets.join(', ')}`);
  console.log('(各日の JSONL ログ・digest-cache と .last-capture.json を削除します。日報は残ります)');
  if (!(await confirm('削除しますか?'))) {
    console.log('中止しました。');
    return;
  }

  for (const date of targets) {
    fs.rmSync(path.join(LOGS_DIR, `${date}.jsonl`), { force: true });
    fs.rmSync(path.join(DIGEST_CACHE_DIR, `${date}.json`), { force: true });
  }
  fs.rmSync(LAST_CAPTURE_FILE, { force: true });
  console.log(`削除しました: ${targets.join(', ')}`);
}

function cmdTemplates(): void {
  const templates = listTemplates();
  if (templates.length === 0) {
    console.log('テンプレートがありません(templates/ に .md を追加してください)。');
    return;
  }
  for (const t of templates) {
    console.log(`${t.fileName.replace(/\.md$/, '').padEnd(20)} ${t.name}`);
  }
}

// --- main ---

const [command, ...rest] = process.argv.slice(2);
try {
  await dispatch(command, rest);
} catch (err) {
  console.error((err as Error).message ?? String(err));
  process.exit(1);
}

async function dispatch(command: string | undefined, rest: string[]): Promise<void> {
  switch (command) {
  case 'capture': // launchd から毎分呼ばれる内部コマンド
    captureMain();
    break;
  case 'start':
    cmdStart();
    break;
  case 'stop':
    cmdStop();
    break;
  case 'status':
    cmdStatus();
    break;
  case 'report':
    await cmdReport(rest);
    break;
  case 'purge':
    await cmdPurge(rest);
    break;
  case 'templates':
    cmdTemplates();
    break;
  case undefined:
  case 'help':
  case '--help':
  case '-h':
    console.log(USAGE);
    break;
  default:
    console.error(`不明なコマンド: ${command}\n`);
    console.error(USAGE);
    process.exit(1);
  }
}
