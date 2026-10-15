// Entry for the single-file soot-browser that `soot browser install` downloads
// (`bun build --compile`). The published archive puts the same pinned
// agent-browser binary next to it; there is no node_modules at run time.
import {dirname,join} from 'node:path';
import {useBundledAgent} from './agent.mjs';
import {run} from './browser.mjs';

useBundledAgent(join(dirname(process.execPath),`agent-browser${process.platform==='win32'?'.exe':''}`));
run();
