import { execute } from './world.mjs';
try {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 192 * 1024) throw Object.assign(new Error('Envelope too large; send fewer personas per call'), { safe: true }); chunks.push(chunk); }
  const call = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  console.log(JSON.stringify(await execute(call, process.argv[2])));
} catch (error) { console.error(error.safe ? error.message : 'Micro Fish operation failed; call micro-fish_status to see what was recorded before retrying.'); process.exitCode = 1; }
