#!/usr/bin/env node
// `soot-channel <telegram|discord>`: started by the Soot runtime with the
// channel-adapter.v1 environment. Also the entry for `bun build --compile`.
import {VERSION, runAdapter} from './core/main.mjs';

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  console.log(`soot-channel ${VERSION} (channel-adapter.v1)`);
  process.exit(0);
}
const stop = new AbortController();
for (const name of ['SIGTERM', 'SIGINT']) process.once(name, () => stop.abort());
const code = await runAdapter({argv, env: process.env, stop: stop.signal});
process.exit(code);
