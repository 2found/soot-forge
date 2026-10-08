import { runTool } from '../sdk/tool.mjs';

// The host binds this URL and owner credential to the operation. Neither the
// target URL nor credential can be supplied by the model or website visitor.
await runTool(async call=>{
  const endpoint=process.env.SOOT_NO_CODE_URL,token=process.env.SOOT_NO_CODE_TOKEN;
  if(!endpoint||!token)throw new Error('No-code binding unavailable');
  const url=new URL(endpoint);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/admin/control')throw new Error('Invalid binding');
  const mode=process.argv[2],input=call.input;
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid operation');
  if(mode==='view'&&!['list','get','audit','sheets.status'].includes(input.action))throw new Error('Read-only operation');
  if(mode==='action'&&['list','get','audit'].includes(input.action))throw new Error('Use read-only operation');
  const response=await fetch(new URL('/admin/control',url),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(input),redirect:'error',signal:AbortSignal.timeout(12000)});
  if(!response.ok){const e=await response.json().catch(()=>({}));return {error:{code:typeof e.error==='string'?e.error:'request_rejected',status:response.status}};}
  return await response.json();
});
