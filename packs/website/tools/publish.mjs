import { isAbsolute } from 'node:path';
import { readPublication, publishPublication, publicationLanguage } from './content.mjs';

async function main() {
  const action = process.argv[2];
  let size = 0; const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 65536) throw new Error('Envelope exceeds limit');
    chunks.push(chunk);
  }
  const call = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!call || typeof call !== 'object' || Array.isArray(call) || !['publish', 'inspect'].includes(action) || call.api_version !== 'soot/v1' || call.hook !== 'tool.call' || call.soot !== 'website-marketer' || call.operation !== `website_${action}`) throw new Error('Invalid tool scope');
  const directory = process.env.WEBSITE_DATA;
  if (!directory || !isAbsolute(directory)) throw new Error('Host must bind an absolute WEBSITE_DATA directory');
  if (action === 'inspect') {
    if (!call.input || typeof call.input !== 'object' || Array.isArray(call.input) || Object.keys(call.input).some(key => key !== 'language')) throw new Error('Inspect expects optional language only');
    const language = publicationLanguage(call.input.language);
    console.log(JSON.stringify({content: readPublication(directory, language), language})); return;
  }
  console.log(JSON.stringify(publishPublication(directory, call.input)));
}
try {await main();} catch {console.error('Website publication failed. Inspect the intended locale and reconcile the uncertain effect before an explicit identical replay; never automatically retry.'); process.exitCode = 1;}
