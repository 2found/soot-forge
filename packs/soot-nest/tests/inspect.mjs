// Exercise the bundled public wire codec as a real child process.
import { runTool } from '../sdk/tool.mjs';
import { decodeInput } from '../sdk/contract.mjs';
await runTool(call => {
  const input = decodeInput(call, value => {
    if (!value || typeof value !== 'object' || typeof value.query !== 'string') throw new Error('Invalid query');
    return value;
  });
  return { characters: [...input.query].length, note: 'Inspection only; subject is not an authenticated identity.' };
});
