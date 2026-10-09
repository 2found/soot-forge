// Real Chromium, alternating warm snapshot calls. No Soot/provider latency.
// Dependencies must already be installed beside both trusted adapter paths.
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,symlink,readFile,rm} from 'node:fs/promises';
import {join,dirname,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
const [before,after,report]=process.argv.slice(2);
if(![before,after,report].every(p=>p&&isAbsolute(p)))throw Error('Usage: node scripts/benchmark-browser-agent.mjs ABS_BASELINE_ADAPTER ABS_CURRENT_ADAPTER ABS_REPORT');
const exec=promisify(execFile),root=await mkdtemp(join(tmpdir(),'soot-agent-bench-')),samples={before:[],after:[]};
const env={...process.env,PATH:dirname(process.execPath)+':'+process.env.PATH,npm_config_offline:'true'};
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<h1>Browser benchmark</h1><label>Name <input></label><button>Confirm</button>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
async function call(mode,input){
 const start=performance.now(),child=exec(mode==='before'?'npx':process.execPath,mode==='before'?['--no-install','soot-browser','control']:[after,'control'],{cwd:join(root,mode),env,timeout:90000,maxBuffer:1024*1024});
 child.child.stdin.end(JSON.stringify({api_version:'soot/v1',hook:'tool.call',operation:'browser-use_control',soot:'benchmark',event:{source:'conversation',subject:'benchmark'},input}));
 const result=JSON.parse((await child).stdout);return {ms:performance.now()-start,result};
}
const stats=rows=>{const ordered=[...rows].sort((a,b)=>a-b);return {median_ms:(ordered[9]+ordered[10])/2,p95_ms:ordered[18],min_ms:ordered[0],max_ms:ordered[19]};};
try {
 for(const mode of ['before','after'])await mkdir(join(root,mode),{recursive:true});
 await mkdir(join(root,'before/node_modules/.bin'),{recursive:true});await symlink(before,join(root,'before/node_modules/.bin/soot-browser'));
 await writeFile(join(root,'before/package.json'),'{"name":"fixture","private":true}');
 for(const mode of ['before','after'])await call(mode,{action:'navigate',url:`http://127.0.0.1:${server.address().port}`});
 for(let i=0;i<22;i++)for(const mode of i%2?['after','before']:['before','after']){
  const {ms,result}=await call(mode,{action:'command',args:['snapshot','-i']});
  if(!JSON.stringify(result).includes('Confirm'))throw Error('Actual DOM snapshot missing');if(i>=2)samples[mode].push(ms);
 }
 const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
 const result={timestamp:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,iterations:20,warmups:2,scope:'Actual pinned Chromium and DOM snapshots. Before: npx local adapter + JS CLI wrapper + per-call Cloak import/session list. After: direct Node + pinned native CLI + verified launch cache. Independent conversation profiles, alternating order, same static fixture. Excludes Soot/provider and viewer.',before_sha256:await hash(before),after_sha256:await hash(after),before:stats(samples.before),after:stats(samples.after),samples};
 await writeFile(report,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...result,samples:undefined},null,2));
}finally{
 let cleaned=true;for(const mode of ['before','after'])try{await call(mode,{action:'close'});}catch(error){cleaned=false;console.error('Owned session close failed:',mode,error.message);process.exitCode=1;}
 await new Promise(r=>server.close(r));if(cleaned)await rm(root,{recursive:true,force:true});
}
