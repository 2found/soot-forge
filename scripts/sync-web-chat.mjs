// Builds the browser-mode website chat widget (packs/website-chat/widget/):
//  - copies the shared chat frame from packs/live-chat/widget/ byte for byte
//    (frame.html with its asset paths made relative), so both widgets show
//    the same UI; scripts/widget-assets.test.mjs proves the copies are equal;
//  - with --package, vendors the SDK's browser-mode channel
//    (`@tofound/soot-sdk/channel/browser`) into channel-browser.js as one ES
//    module, from a built or installed SDK package. Deterministic and dependency-free: each
// relative module the entry imports is inlined once, with its `export`
// keywords dropped; a module that itself imports is refused, so the bundle
// never silently loses code. The sha256 is pinned in scripts/widget-assets.test.mjs.
//   node scripts/sync-web-chat.mjs [--package /path/to/@tofound/soot-sdk]
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

export async function bundle(root) {
  const entry = join(root, 'dist/channel/browser/index.js');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== '@tofound/soot-sdk') throw new Error('Expected the @tofound/soot-sdk package');
  const strip = text => text.replace(/^\/\/# sourceMappingURL=.*$/gm, '').trimEnd();
  let main = strip(await readFile(entry, 'utf8'));
  const deps = [], reexports = [];
  main = main.replace(/^export \{([^}]+)\} from '(\.\.?\/[^']+)';$/gm, (_, names, from) => { reexports.push(names.trim()); deps.push(from); return ''; });
  main = main.replace(/^import \{[^}]+\} from '(\.\.?\/[^']+)';$/gm, (_, from) => { deps.push(from); return ''; });
  if (/^\s*import\b/m.test(main)) throw new Error('channel/browser has an import form this bundler does not inline');
  const parts = [];
  for (const from of [...new Set(deps)]) {
    let code = strip(await readFile(resolve(dirname(entry), from), 'utf8'));
    if (/^\s*(import|export \{|export \*)/m.test(code)) throw new Error(`${from}: nested imports or re-exports are not inlined`);
    code = code.replace(/^export (async function\*?|function|class|const|let)/gm, '$1');
    parts.push(`// ---- ${from} ----\n${code}`);
  }
  const text = `// @tofound/soot-sdk@${pkg.version} channel/browser, vendored by scripts/sync-web-chat.mjs; do not edit.\n${parts.join('\n\n')}\n\n// ---- channel/browser/index.js ----\n${main.trim()}\n${reexports.length ? `export { ${reexports.join(', ')} };\n` : ''}${deps.includes('../timing.js') ? '// Test seam, as the SDK\'s own tests shrink dist/channel/timing.js; a page never sets it.\nexport { timing };\n' : ''}`;
  return { text, version: pkg.version, sha256: createHash('sha256').update(text).digest('hex') };
}

/** The shared frame files, copied unchanged. */
export const SHARED_FRAME = ['frame.js', 'widget-composer.js', 'agent-behavior.js', 'agent.css', 'widget.css', 'theme.css'];
/** live-chat's frame.html loads its assets from the host's /public/widget/; this copy loads them beside itself. */
export const relativeFrame = html => html.replaceAll('/public/widget/', './');

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (!(args.length === 0 || (args.length === 2 && args[0] === '--package'))) throw new Error('Usage: node scripts/sync-web-chat.mjs [--package /path/to/@tofound/soot-sdk]');
  const source = resolve('packs/live-chat/widget');
  const target = resolve('packs/website-chat/widget');
  for (const file of SHARED_FRAME) await copyFile(join(source, file), join(target, file));
  await writeFile(join(target, 'frame.html'), relativeFrame(await readFile(join(source, 'frame.html'), 'utf8')));
  console.log(`Copied the shared chat frame (${SHARED_FRAME.length + 1} files).`);
  if (args.length === 0) process.exit(0);
  const out = await bundle(resolve(args[1]));
  await writeFile(join(target, 'channel-browser.js'), out.text);
  await writeFile(join(target, 'sdk-manifest.json'), JSON.stringify({ package: '@tofound/soot-sdk', version: out.version, export: './channel/browser', sha256: out.sha256 }, null, 2) + '\n');
  console.log(`Vendored @tofound/soot-sdk@${out.version} channel/browser (${out.sha256}); pin it in scripts/widget-assets.test.mjs.`);
}
