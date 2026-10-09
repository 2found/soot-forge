import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {callOwner, MAX_RESPONSE_BYTES} from '../tools/gateway.mjs';

const call = (pack, mode, input) => ({api_version:'soot/v1',hook:'tool.call',soot:'owner',operation:`${pack}_${mode}`,input});
const endpoint='http://127.0.0.1:1234/admin/control', token='synthetic-owner-fixture';
const save={action:'save',site_id:'site',request_id:'stable-fixture',expected_revision:1,config:{title:'Xin chào'}};
const read={action:'get',site_id:'site'};

test('standalone owner packs bind exact operation, fixed origin and read/write action', async () => {
 let requests=0;
 const fetcher=async (url,options) => { requests++; assert.equal(url.href,endpoint);assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer '+token);return Response.json({site:{revision:2}}); };
 assert.deepEqual(await callOwner('nest-no-code','action',call('nest-no-code','action',save),endpoint,token,{fetcher}),{site:{revision:2}});
 for (const [pack,mode,input] of [['nest-no-code','view',save],['nest-no-code','action',read],['nest-no-code','action',{...save,request_id:undefined}],['nest-no-code','action',{...save,action:'delete-everything'}],['live-chat-sheets','action',{...save,action:'save'}]]) {
  await assert.rejects(callOwner(pack,mode,call(pack,mode,input),endpoint,token,{fetcher}));
 }
 for (const target of ['http://example.com/admin/control','https://user:pass@example.com/admin/control','https://example.com/admin/control?token=override','file:///admin/control']) await assert.rejects(callOwner('nest-no-code','view',call('nest-no-code','view',read),target,token,{fetcher}));
 await assert.rejects(callOwner('nest-no-code','action',call('other','action',save),endpoint,token,{fetcher}));
 assert.deepEqual(await callOwner('live-chat-sheets','action',call('live-chat-sheets','action',{action:'sheets.status',site_id:'site'}),endpoint,token,{fetcher}),{site:{revision:2}});
 assert.equal(requests,2);
});

test('body and declared byte caps, invalid UTF-8 and malformed success stay uncertain for writes', async () => {
 for(const response of [new Response('x',{headers:{'content-length':String(MAX_RESPONSE_BYTES+1)}}),new Response('x'.repeat(MAX_RESPONSE_BYTES+1)),new Response(new Uint8Array([255])),new Response('not-json'),Response.json([])]) {
  let requests=0;
  await assert.rejects(callOwner('nest-no-code','action',call('nest-no-code','action',save),endpoint,token,{fetcher:async()=>{requests++;return response;}}),error=>error.uncertain===true&&!error.message.includes('not-json'));
  assert.equal(requests,1);
 }
});

test('server errors and lost responses never retry or echo vendor secrets', async () => {
 for (const status of [408,500,503]) await assert.rejects(callOwner('live-chat-sheets','action',call('live-chat-sheets','action',{action:'sheets.retry',site_id:'site',request_id:'same'}),endpoint,token,{fetcher:async()=>new Response('PRIVATE_VENDOR_TOKEN',{status})}),error=>error.uncertain===true&&!error.message.includes('PRIVATE'));
 const denied=await callOwner('nest-no-code','view',call('nest-no-code','view',read),endpoint,token,{fetcher:async()=>new Response('PRIVATE_VENDOR_TOKEN',{status:403})});
 assert.deepEqual(denied,{error:{code:'request_rejected',status:403}});
 await assert.rejects(callOwner('nest-no-code','view',call('nest-no-code','view',read),endpoint,token,{fetcher:async()=>{throw Error('PRIVATE');}}),error=>!error.uncertain&&!error.message.includes('PRIVATE'));
});

test('one deadline covers stalled headers and body and cancels without replay', async () => {
 for (const body of [false,true]) {
  let cancelled=false,signal,requests=0;
  const fetcher=async(_url,options)=>{signal=options.signal;requests++;return body?new Response(new ReadableStream({cancel(){cancelled=true;}})):new Promise(()=>{});};
  await assert.rejects(callOwner('nest-no-code','action',call('nest-no-code','action',save),endpoint,token,{fetcher,timeoutMs:30}),error=>error.uncertain);
  assert.equal(requests,1);assert.equal(signal.aborted,true);if(body)assert.equal(cancelled,true);
 }
});

test('public executable emits exit 2 for an uncertain write and never follows a redirect', async t => {
 let redirected=0,requests=0;
 const server=createServer((req,res)=>{requests++;if(req.url==='/secret'){redirected++;res.end('{}');return;}res.writeHead(307,{Location:'/secret'});res.end();});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 for (const pack of ['nest-no-code','live-chat-sheets']) {
  const input=pack==='nest-no-code'?save:{action:'sheets.retry',site_id:'site',request_id:'same'};
  const wire={...call(pack,'action',input),root:'owner',event:{id:'1',source:'conversation',subject:'fixture',text:'fixture'}};
  const executable=new URL(`../../${pack}/tools/control.mjs`,import.meta.url);
  const child=spawn(process.execPath,[executable.pathname,'action'],{env:{SOOT_NO_CODE_URL:`http://127.0.0.1:${server.address().port}/admin/control`,SOOT_NO_CODE_TOKEN:token},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.stdin.end(JSON.stringify(wire));
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  assert.equal(code,2);assert.equal(stdout,'');assert.equal(stderr,'Soot tool invocation failed\n');
 }
 assert.equal(requests,2);assert.equal(redirected,0);
});
