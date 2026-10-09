import { readFile } from 'node:fs/promises';
import { approve, execute } from './ledger.mjs';
try {
  const host = JSON.parse(process.env.MARKETING_TEAM || '{}');
  let result;
  if (process.argv[2] === 'approve') {
    if (process.argv.length !== 4) throw new Error('Approval requires an operator-owned JSON file');
    const raw = await readFile(process.argv[3]); if (raw.length > 4096) throw new Error('Approval too large');
    result = await approve(host, JSON.parse(raw));
  } else {
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; if (size > 65536) throw new Error('Envelope too large'); chunks.push(chunk); }
    const call = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    result = await execute(host, call, process.argv[2], call.input);
  }
  console.log(JSON.stringify(result));
} catch (error) { console.error(error.safe ? error.message : "Marketing operation failed; inspect the draft and original publication receipt before retrying."); process.exitCode = 1; }
