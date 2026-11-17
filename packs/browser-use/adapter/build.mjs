// Bundles bundle.mjs into one JavaScript file for `bun build --compile`
// (run with bun: `bun build.mjs <outfile>`).
//
// The adapter only asks cloakbrowser for its binary and stealth flags; it
// never launches through Playwright. cloakbrowser's index still pulls in its
// humanize layer, which imports `playwright-core` at the top of a module, and a
// single-file bundle hoists that import to the top of the whole program: left
// external, every soot-browser call fails with "Cannot find package
// 'playwright-core'"; bundled, it adds Playwright's whole client. So
// `playwright-core` resolves to a stub that fails only if something uses it.
const outfile = process.argv[2];
if (!outfile) throw new Error('usage: bun build.mjs <outfile>');

const stub = {
  name: 'playwright-core-stub',
  setup(build) {
    build.onResolve({filter: /^playwright-core(\/.*)?$/}, args => ({path: args.path, namespace: 'playwright-stub'}));
    build.onLoad({filter: /.*/, namespace: 'playwright-stub'}, () => ({
      loader: 'js',
      contents: `const missing=()=>{throw new Error('soot-browser does not bundle playwright-core');};
export const errors={TimeoutError:class TimeoutError extends Error{}};
export const chromium=new Proxy({},{get:missing});
export default {errors,chromium};`,
    }));
  },
};

const result = await Bun.build({
  entrypoints: [new URL('./bundle.mjs', import.meta.url).pathname],
  target: 'bun',
  plugins: [stub],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
await Bun.write(outfile, result.outputs[0]);
