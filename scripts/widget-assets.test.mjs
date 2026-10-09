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
  assert.equal(manifest.composer.version, '0.4.0');
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
