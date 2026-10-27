import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Codex } from '@openai/codex-sdk';

test('the SDK resolves an updated bundled CLI, independent of the global codex command', () => {
  const sdkRequire = createRequire(import.meta.resolve('@openai/codex-sdk'));
  const cliManifestPath = sdkRequire.resolve('@openai/codex/package.json');
  const cliManifest = JSON.parse(fs.readFileSync(cliManifestPath, 'utf8'));
  const [major, minor] = cliManifest.version.split('.').map(Number);
  // 0.144.x cannot run the configured GPT-6 Astra model. Keep the tested
  // stable release floor in the installed dependency graph, not only package.json.
  assert.ok(major > 0 || minor >= 164, `Outdated bundled CLI: ${cliManifest.version}`);
  const cliPath = path.resolve(path.dirname(cliManifestPath), cliManifest.bin.codex);
  const version = execFileSync(process.execPath, [cliPath, '--version'], { encoding: 'utf8' });
  assert.equal(version.trim(), `codex-cli ${cliManifest.version}`);
});

test('updated SDK preserves report sandbox options and returns Markdown from JSONL events', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrippo-sdk-test-'));
  try {
    const executable = path.join(dir, 'fake-codex');
    const argsPath = path.join(dir, 'args.json');
    const inputPath = path.join(dir, 'input.txt');
    fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(inputPath)}, input);
  for (const event of [
    {type: 'thread.started', thread_id: 'test-thread'},
    {type: 'turn.started'},
    {type: 'item.completed', item: {id: 'message', type: 'agent_message', text: '## Work\\n- Synthetic report'}},
    {type: 'turn.completed', usage: {input_tokens: 1, cached_input_tokens: 0, output_tokens: 1}}
  ]) console.log(JSON.stringify(event));
});
`, { mode: 0o700 });
    const codex = new Codex({ codexPathOverride: executable });
    const result = await codex.startThread({
      skipGitRepoCheck: true,
      sandboxMode: 'read-only',
      webSearchMode: 'disabled',
      networkAccessEnabled: false,
      workingDirectory: dir,
    }).run('Generate a synthetic report.');
    assert.equal(result.finalResponse, '## Work\n- Synthetic report');
    assert.equal(fs.readFileSync(inputPath, 'utf8'), 'Generate a synthetic report.');
    const args: string[] = JSON.parse(fs.readFileSync(argsPath, 'utf8'));
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    assert.equal(args[args.indexOf('--cd') + 1], dir);
    assert.ok(args.includes('--skip-git-repo-check'));
    assert.ok(args.includes('web_search="disabled"'));
    assert.ok(args.includes('sandbox_workspace_write.network_access=false'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
