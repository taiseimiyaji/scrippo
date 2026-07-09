import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePlist } from '../src/launchd.ts';

// --- generatePlist ---

test('generatePlist embeds label, node path and cli path', () => {
  const plist = generatePlist('com.user.scrippo', '/usr/local/bin/node', '/home/user/cli.ts');
  assert.ok(plist.includes('<string>com.user.scrippo</string>'));
  assert.ok(plist.includes('<string>/usr/local/bin/node</string>'));
  assert.ok(plist.includes('<string>/home/user/cli.ts</string>'));
});

test('generatePlist escapes XML special characters in embedded values', () => {
  const plist = generatePlist('com.a&b.scrippo', '/opt/<node>/bin/node', '/x/cli.ts');
  assert.ok(plist.includes('<string>com.a&amp;b.scrippo</string>'));
  assert.ok(plist.includes('<string>/opt/&lt;node&gt;/bin/node</string>'));
  assert.ok(!plist.includes('a&b'));
});
