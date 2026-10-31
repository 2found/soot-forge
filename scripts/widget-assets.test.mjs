import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { shouldSubmitAgentMessage, isAgentTranscriptAtEnd } from '../packs/live-chat/widget/agent-behavior.js';

test('the widget ships the exact shared 2ui assets recorded at import', async () => {
  const root = new URL('../packs/live-chat/widget/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('ui-manifest.json', root), 'utf8'));
  assert.equal(manifest.package, '@tofound/ui');
  assert.ok(manifest.version);
  assert.deepEqual(Object.keys(manifest.files).sort(), ['agent-behavior.js', 'agent.css']);
  const sourcePackage = JSON.parse(await readFile(new URL('../packs/live-chat/widget-src/package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, sourcePackage.dependencies['@tofound/ui']);
  assert.equal(manifest.composer.version, sourcePackage.dependencies['@tofound/ui']);
  assert.equal(createHash('sha256').update(await readFile(new URL('widget-composer.js', root))).digest('hex'), manifest.composer.sha256);
  for (const [file, hash] of Object.entries(manifest.files)) {
    assert.equal(createHash('sha256').update(await readFile(new URL(file, root))).digest('hex'), hash, file);
  }
});

test('the shipped keyboard contract preserves IME, modifiers and touch newlines', () => {
  for (const event of [{key:'Enter',isComposing:true},{key:'Enter',keyCode:229},{key:'Enter',shiftKey:true},{key:'Enter',ctrlKey:true}]) {
    assert.equal(shouldSubmitAgentMessage(event), false);
  }
  assert.equal(shouldSubmitAgentMessage({key:'Enter'}, false), false);
  assert.equal(shouldSubmitAgentMessage({key:'Enter'}), true);
  assert.equal(isAgentTranscriptAtEnd({scrollHeight:2000,scrollTop:0,clientHeight:600}), false);
});

// The widget's SDK is the published @tofound/soot-sdk@0.4.0 dist/browser.js,
// byte for byte (live-chat-attention v1: cards, pointers, durable answers).
const SDK_0_4_0_BROWSER_SHA256 = '6890a08a3eda3a302603810f398c2f31473b1898000020e0045fa7bd2055b80b';
test('the widget ships the published SDK 0.4.0 browser module and the question island', async () => {
  const root = new URL('../packs/live-chat/widget/', import.meta.url);
  assert.equal(createHash('sha256').update(await readFile(new URL('browser.js', root))).digest('hex'), SDK_0_4_0_BROWSER_SHA256);
  const sdk = await import(new URL('browser.js', root));
  assert.equal(sdk.LIVE_CHAT_ATTENTION_V1, 'live-chat-attention-v1');
  // A team item (any kind but question) never becomes a card.
  assert.equal(sdk.questionOf({ kind: 'approval', item: 'a', prompt: 'p', multi: false, options: [{ label: 'x' }] }), undefined);
  const composer = await readFile(new URL('widget-composer.js', root), 'utf8');
  assert.match(composer, /createWidgetQuestion/);
  assert.match(composer, /ui-agent-question/);
});
