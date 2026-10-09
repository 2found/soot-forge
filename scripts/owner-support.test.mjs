import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('standalone owner gateway copies match reviewed canonical source', async () => {
  const source = await readFile(new URL('support/owner_gateway.mjs', import.meta.url));
  for (const pack of ['nest-no-code', 'live-chat-sheets']) {
    assert.deepEqual(await readFile(new URL(`../packs/${pack}/tools/gateway.mjs`, import.meta.url)), source, pack);
  }
});

test('artifact writers share the same standalone process lock protocol', async () => {
  const source = await readFile(new URL('support/artifact_lock.go', import.meta.url));
  for (const pack of ['artifacts', 'writing']) {
    assert.deepEqual(await readFile(new URL(`../packs/${pack}/runner/artifact_lock.go`, import.meta.url)), source, pack);
  }
});
