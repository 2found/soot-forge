// Builds page/app.js, one classic script, from the ES modules in page/src/.
// A sandboxed (opaque-origin) frame fetches module scripts in CORS mode, which
// the bundle route does not answer, so the page ships a classic script. Each
// module keeps its own function scope; imports become destructuring of the
// module objects. Deterministic and dependency-free: node tests/build.mjs
// [--check]. The page tests fail when app.js is stale.
import { readFile, writeFile } from 'node:fs/promises';

const src = new URL('../src/', import.meta.url);
const out = new URL('../app.js', import.meta.url);
const order = ['bridge', 'model', 'text', 'app'];

export async function build() {
  const parts = [];
  for (const name of order) {
    let code = await readFile(new URL(`${name}.js`, src), 'utf8');
    const exports = [];
    code = code.replace(/^\/\/ @ts-check\n/, '');
    code = code.replace(/^import \* as (\w+) from '\.\/(\w+)\.js';$/gm, (_, local, mod) => `const ${local} = __${mod};`);
    code = code.replace(/^import \{([^}]+)\} from '\.\/(\w+)\.js';$/gm, (_, names, mod) => `const {${names}} = __${mod};`);
    code = code.replace(/^export (async function|function|const|let) (\w+)/gm, (_, kind, id) => { exports.push(id); return `${kind} ${id}`; });
    if (/^\s*(import|export)\b/m.test(code)) throw new Error(`${name}.js: an import/export form the page build does not handle`);
    parts.push(`// ---- src/${name}.js ----\nconst __${name} = (() => {\n${code.trimEnd()}\n${exports.length ? `return { ${exports.join(', ')} };` : ''}\n})();`);
  }
  return `// Built from src/ by tests/build.mjs; do not edit.\n'use strict';\n(() => {\n${parts.join('\n\n')}\n})();\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = await build();
  if (process.argv.includes('--check')) {
    if ((await readFile(out, 'utf8').catch(() => '')) !== text) { console.error('page/app.js is stale: run node tests/build.mjs'); process.exit(1); }
  } else { await writeFile(out, text); console.log('wrote page/app.js'); }
}
