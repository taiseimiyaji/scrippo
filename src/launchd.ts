// launchd plist の生成・ロード/アンロード
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function launchdLabel(): string {
  return `com.${os.userInfo().username}.scrippo`;
}

export function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${launchdLabel()}.plist`);
}

/** plist の <string> に埋め込む値の XML エスケープ */
function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** launchd plist を生成(node のフルパスを埋め込む: launchd の PATH は貧弱) */
export function generatePlist(rawLabel: string, rawNodePath: string, rawCliPath: string): string {
  const [label, nodePath, cliPath] = [rawLabel, rawNodePath, rawCliPath].map(xmlEscape);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${cliPath}</string>
    <string>capture</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`;
}

function uid(): number {
  return os.userInfo().uid;
}

export function loadAgent(cliPath: string): void {
  const plist = generatePlist(launchdLabel(), process.execPath, cliPath);
  fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
  fs.writeFileSync(plistPath(), plist, { mode: 0o600 });
  // 既にロード済みなら一旦外す(冪等にする)
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid()}/${launchdLabel()}`], { stdio: 'ignore' });
  } catch {
    // 未ロードなら失敗してよい
  }
  execFileSync('launchctl', ['bootstrap', `gui/${uid()}`, plistPath()], { stdio: 'inherit' });
}

export function unloadAgent(): boolean {
  let wasLoaded = true;
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid()}/${launchdLabel()}`], { stdio: 'ignore' });
  } catch {
    wasLoaded = false;
  }
  fs.rmSync(plistPath(), { force: true });
  return wasLoaded;
}

export function isAgentLoaded(): boolean {
  try {
    execFileSync('launchctl', ['print', `gui/${uid()}/${launchdLabel()}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
