import { runTool } from '../sdk/tool.mjs';
import { callOwner } from './gateway.mjs';

await runTool(call => callOwner('soot-nest', process.argv[2], call,
  process.env.SOOT_NO_CODE_URL, process.env.SOOT_NO_CODE_TOKEN));
