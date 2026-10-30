// Opt-in real-provider test of installed Go packs. All writes stay in a NEW
// temporary fixture directory; no email, publication or external mutation.
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, readFile, writeFile, readdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {createServer} from 'node:net';
import {randomBytes, createHash} from 'node:crypto';
import {archivePack} from './archive.mjs';
import {materialize, readCatalog} from './catalog.mjs';

const args={};
for(let i=2;i<process.argv.length;i+=2){if(!['--soot','--output','--provider','--model'].includes(process.argv[i])||!process.argv[i+1])throw Error('Usage: node scripts/live-core-review.mjs --soot BINARY --output NEW_DIRECTORY --provider ID --model NAME');args[process.argv[i].slice(2)]=process.argv[i+1];}
if(!args.soot||!args.output||!args.provider||!args.model)throw Error('All arguments required');
const root=resolve(import.meta.dirname,'..'), output=resolve(args.output), binary=resolve(args.soot), execute=promisify(execFile);
await mkdir(output);
const store=join(output,'store');await mkdir(store);
const exports=join(output,'exports');await mkdir(exports);
const listen=createServer();await new Promise(r=>listen.listen(0,'127.0.0.1',r));const port=listen.address().port;await new Promise(r=>listen.close(r));
const env={...process.env,FORGE_REVIEW_TOKEN:randomBytes(32).toString('hex'),FORGE_REVIEW_STORE:store,FORGE_REVIEW_EXPORT:exports};
const config=join(output,'deployment.json');
await writeFile(join(output,'SOUL.md'),'You are a Soot. Exercise authorized local fixtures with real tools. Preserve exact bytes and report observed tool results. Do not invent success.\n');
await writeFile(join(output,'MISSION.md'),'Verify installed artifact/writing/casework tools. No external writes or messages.\n');
await writeFile(join(output,'review.json'),JSON.stringify({id:'review',soul:'SOUL.md',mission:'MISSION.md',packs:['artifacts','writing','casework'],model:{provider:args.provider,name:args.model,fallbacks:[]}}));
await writeFile(config,JSON.stringify({listen:`127.0.0.1:${port}`,token_env:'FORGE_REVIEW_TOKEN',packs_dir:'packs',data_dir:'data',default_soot:'review',soots:['review.json'],credentials:{review:{ARTIFACT_STORE:{env:'FORGE_REVIEW_STORE',operations:['artifacts_read','artifacts_create','artifacts_remove','writing_export']},ARTIFACT_EXPORT:{env:'FORGE_REVIEW_EXPORT',operations:['artifacts_remove']}}},execution:{max_turns:16,max_tool_calls:24,tool_timeout:'30s',subagents:0,advisor:false,memory_consolidation:false,todo_nudges:0}}));
const invoke=(program,argv)=>execute(program,argv,{cwd:output,env,timeout:420000,maxBuffer:2*1024*1024});
const catalog=await readCatalog(root);
for(const [id,name] of [['artifacts','soot-artifacts'],['writing','soot-writing'],['casework','soot-case']]){
  const source=await materialize(catalog.packs.find(p=>p.id===id),root,join(output,'materialized'));
  const archive=join(output,`${id}.tar.gz`);await archivePack(source,archive,id);
  await writeFile(join(output,`${id}-install.json`),(await invoke(binary,['add',archive,'--config',config,'--json'])).stdout);
  const installed=join(output,'packs',id);await mkdir(join(installed,'bin'),{recursive:true});
  // Explicit operator preparation after installation, never shipped binaries.
  await execute('go',['build','-o',join(installed,'bin',name),'.'],{cwd:join(installed,'runner'),env,timeout:120000,maxBuffer:1024*1024});
  console.log(`Installed and operator-built ${id}`);
}
await writeFile(join(output,'check.json'),(await invoke(binary,['check','--config',config,'--show','--secrets','--json'])).stdout);
const runtime=spawn(binary,['serve','--config',config],{cwd:output,env,stdio:['ignore','pipe','pipe']});
let logs='';for(const pipe of [runtime.stdout,runtime.stderr])pipe.on('data',chunk=>logs+=chunk);
const headers={Authorization:`Bearer ${env.FORGE_REVIEW_TOKEN}`},api=`http://127.0.0.1:${port}`;
try{
  for(let i=0;i<100;i++){if(runtime.exitCode!==null)throw Error('Soot runtime exited');try{if((await fetch(`${api}/v1/conversations/soots`,{headers})).ok)break;}catch{}if(i===99)throw Error('Runtime not ready');await new Promise(r=>setTimeout(r,200));}
  const started=Date.now();
  const prompt='Use real tools, in this exact fixture journey: artifacts_create a text/plain artifact with data_b64 "UmV2aWV3" and name original.txt (these bytes spell Review). writing_export format markdown, text exactly "Review", name kept.md. They should share the same content hash but have different refs. artifacts_read both. artifacts_remove ONLY the first artifact ref, then artifacts_read the writing ref again to prove it is preserved. Then casework_upsert title "Pack review", summary "Local artifact and writing tool journey", status "resolved"; casework_read the record. Report the actual refs/hashes and case state. All actions are authorized solely in this temporary fixture; do not send messages.';
  const result=JSON.parse((await invoke(binary,['run','--config',config,'--soot','review','--json','--timeout','6m',prompt])).stdout);
  await writeFile(join(output,'run.json'),JSON.stringify(result,null,2));
  if(result.state!=='completed')throw Error('Core journey did not complete');
  const events=[];let after=0;
  for(let page=0;page<20;page++){const response=await fetch(`${api}/v1/conversations/${result.conversation_id}/events?after=${after}&limit=100`,{headers});if(!response.ok)throw Error('History unavailable');const data=await response.json();const rows=data.events??data.items??(Array.isArray(data)?data:[]);events.push(...rows);const next=data.next_after??data.nextAfter;if(!next||next===after||!rows.length)break;after=next;}
  await writeFile(join(output,'events.json'),JSON.stringify(events,null,2));
  for(const tool of ['artifacts_create','writing_export','artifacts_read','artifacts_remove','casework_upsert','casework_read'])if(!events.some(e=>e.type==='tool.completed'&&e.text===tool))throw Error(`No completion evidence: ${tool}`);
  const refs=await readdir(join(store,'meta'));if(refs.length!==1)throw Error('Expected exactly one preserved artifact');
  const meta=JSON.parse(await readFile(join(store,'meta',refs[0])));
  const content=await readFile(join(store,'objects',meta.sha256.slice(0,2),meta.sha256));
  if(content.toString()!=='Review'||createHash('sha256').update(content).digest('hex')!==meta.sha256||meta.provenance.operation!=='writing_export')throw Error('Preserved artifact content/provenance mismatch');
  const summary={status:'completed',provider:args.provider,model:args.model,seconds:(Date.now()-started)/1000,conversation:result.conversation_id,required_tools:['artifacts_create','writing_export','artifacts_read','artifacts_remove','casework_upsert','casework_read'],preserved_ref:meta.id,preserved_sha256:meta.sha256,scope:'Real Soot/provider and local Go runners; no external service calls'};
  await writeFile(join(output,'summary.json'),JSON.stringify(summary,null,2));console.log('Core journey passed with independent filesystem verification');
}finally{
  runtime.kill('SIGTERM');await Promise.race([new Promise(r=>runtime.once('exit',r)),new Promise(r=>setTimeout(r,10000))]);if(runtime.exitCode===null&&runtime.signalCode===null)runtime.kill('SIGKILL');await writeFile(join(output,'runtime.log'),logs,{mode:0o600});
}
