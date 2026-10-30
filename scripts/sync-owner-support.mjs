import {readFile, writeFile} from 'node:fs/promises';
const check = process.argv.slice(2);
if (check.length > 1 || check.length === 1 && check[0] !== '--check') throw new Error('Usage: node scripts/sync-owner-support.mjs [--check]');
const source = await readFile(new URL('support/owner_gateway.mjs', import.meta.url));
for (const pack of ['website-chat', 'live-chat-sheets']) {
  const target = new URL(`../packs/${pack}/tools/gateway.mjs`, import.meta.url);
  if (check.length) {
    if (!source.equals(await readFile(target))) throw new Error(`Owner support drift: ${pack}`);
  } else await writeFile(target, source);
}
