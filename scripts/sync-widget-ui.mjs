// Explicit import from a built/installed 2ui package; no sibling path is assumed.
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--package') throw new Error('Usage: node scripts/sync-widget-ui.mjs --package /path/to/@tofound/ui');
const root = resolve(args[1]);
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (pkg.name !== '@tofound/ui') throw new Error('Expected @tofound/ui package');
const target = resolve('packs/live-chat/widget');
const existing = JSON.parse(await readFile(join(target,'ui-manifest.json'), 'utf8'));
const files = {};
for (const [name, source] of [['agent.css','dist/styles/agent.css'], ['agent-behavior.js','dist/components/agent/behavior.js']]) {
  const data = await readFile(join(root,source));
  files[name] = createHash('sha256').update(data).digest('hex');
  await copyFile(join(root,source),join(target,name));
}
await writeFile(join(target,'ui-manifest.json'),JSON.stringify({package:pkg.name,version:pkg.version,files,...(existing.composer?{composer:existing.composer}:{})},null,2)+'\n');
console.log('Imported shared agent styles and keyboard/scroll behavior.');
