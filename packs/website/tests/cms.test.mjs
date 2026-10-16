import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';
import {callCms,readEnvelope,validateCredential,validateInput,MAX_STDIN_BYTES,MAX_RESPONSE_BYTES} from '../tools/cms.mjs';
import {validatePublication} from '../tools/content.mjs';
const credential=JSON.stringify({origin:'https://2found.dev',site:'soot',token:'synthetic-secret'});
const input={slug:'real-post',requestId:'d46a7f8c-4246-4bdd-a79d-42fb0bc91d51',expectedRevision:0,title:'Real post',summary:'',bodyMarkdown:'Evidence-backed content.',status:'draft'};
const call=(action='save',value=input)=>({api_version:'soot/v1',hook:'tool.call',soot:'website-marketer',operation:`website_cms_${action}`,input:value,event:{text:'untrusted'},futureField:true});
const metadata={slug:input.slug,title:input.title,summary:'',author:'website-marketer',revision:1,status:'draft',updatedAt:123,publishedAt:null};
const result=(action='save')=>action==='save'?{post:metadata,duplicate:false}:{post:{...metadata,bodyMarkdown:input.bodyMarkdown}};
const json=value=>new Response(JSON.stringify(value));

test('strict request/credential/envelope scope; host targets never come from model fields',async()=>{
  for(const extra of ['site','origin','token','url','author','revision'])assert.throws(()=>validateInput('save',{...input,[extra]:'other'}));
  for(const bad of [{...input,slug:'../escape'},{...input,requestId:'not-uuid'},{...input,expectedRevision:-1},{...input,title:''},{...input,title:'x'.repeat(201)},{...input,summary:'x'.repeat(501)},{...input,bodyMarkdown:'é'.repeat(20001)},{...input,bodyMarkdown:'\ud800'},{...input,status:'deleted'}])assert.throws(()=>validateInput('save',bad));
  assert.doesNotThrow(()=>validateInput('save',{...input,title:'😀'.repeat(200),summary:'😀'.repeat(500),bodyMarkdown:'é'.repeat(20000)}));
  for(const bad of ['bad','{}',JSON.stringify({origin:'http://remote.test',site:'soot',token:'synthetic'}),JSON.stringify({origin:'https://user:pass@2found.dev',site:'soot',token:'synthetic'}),JSON.stringify({origin:'https://2found.dev/path',site:'soot',token:'synthetic'}),JSON.stringify({origin:'https://2found.dev',site:'soot',token:'bad\nheader'}),JSON.stringify({origin:'https://2found.dev',site:'soot',token:'synthetic',extra:true})])assert.throws(()=>validateCredential(bad));
  for(const bad of [{...call(),soot:''},{...call(),soot:7},{...call(),soot:undefined},{...call(),operation:'website_publish'},{...call(),api_version:'soot/v2'},{...call(),hook:'other'}])await assert.rejects(callCms('save',bad,credential));
  assert.throws(()=>validateInput('inspect',{slug:input.slug,site:'other'}));
  // Any Soot the host granted website/cms may call it; the host pins the site in the credential.
  await assert.doesNotReject(callCms('inspect',{...call('inspect',{slug:input.slug}),soot:'acme-editor'},credential,{fetcher:async()=>new Response(null,{status:404})}));
  await assert.rejects(readEnvelope(Readable.from([Buffer.from([0xff])])));
  await assert.rejects(readEnvelope(Readable.from([Buffer.alloc(MAX_STDIN_BYTES+1)])));
  await assert.rejects(readEnvelope(Readable.from([Buffer.from('{} trailing')])));
  assert.deepEqual(await readEnvelope(Readable.from([Buffer.from(JSON.stringify(call()))])),call());
});
test('fixed authenticated URL/method, request fields and validated responses',async()=>{
  for(const action of ['save','inspect']) {
    const value=action==='save'?input:{slug:input.slug};
    const received=await callCms(action,call(action,value),credential,{fetcher:async(url,options)=>{
      assert.equal(url,`https://2found.dev/api/cms/v1/sites/soot/${action==='save'?'posts':'drafts'}/real-post`);
      assert.equal(options.method,action==='save'?'PUT':'GET');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer synthetic-secret');
      if(action==='save') {const {slug,...payload}=input;assert.deepEqual(JSON.parse(options.body),payload);} else assert.equal(options.body,undefined);
      return json(result(action));
    }});
    assert.deepEqual(received,result(action));
  }
  assert.deepEqual(await callCms('inspect',call('inspect',{slug:input.slug}),credential,{fetcher:async()=>new Response('',{status:404})}),{post:null});
  assert.deepEqual(await callCms('save',call(),credential,{fetcher:async()=>new Response('',{status:409})}),{status:'conflict'});
  for(const value of [{...result(),extra:true},{post:{...metadata,bodyMarkdown:'must not leak'},duplicate:false},{post:{...metadata,slug:'wrong-slug'},duplicate:false},{post:metadata,duplicate:'yes'}])await assert.rejects(callCms('save',call(),credential,{fetcher:async()=>json(value)}),/uncertain/);
});
test('redirects, UTF-8, declared and actual byte caps fail closed without retries',async()=>{
  for(const response of [new Response('',{status:302,headers:{location:'https://attacker.test'}}),new Response(Buffer.from([0xff])),new Response('{}',{headers:{'content-length':String(MAX_RESPONSE_BYTES+1)}}),new Response('x'.repeat(MAX_RESPONSE_BYTES+1)),new Response('x'.repeat(MAX_RESPONSE_BYTES+1),{headers:{'content-length':'1'}})]) {
    let calls=0;
    await assert.rejects(callCms('save',call(),credential,{fetcher:async()=>{calls++;return response;}}),/uncertain/);assert.equal(calls,1);
  }
  await assert.rejects(callCms('inspect',call('inspect',{slug:input.slug}),credential,{fetcher:async()=>({redirected:true,body:new ReadableStream(),url:'https://attacker.test'})}),/unavailable/);
});
test('one total deadline covers stalled/late headers and body; abort/cancel and no replay',async()=>{
  for(const phase of ['headers','body','late']) {
    let calls=0,signal,cancelled=false;
    const started=Date.now();
    await assert.rejects(callCms('save',call(),credential,{timeoutMs:30,fetcher:async(_url,options)=>{
      calls++;signal=options.signal;
      if(phase==='headers')return new Promise(()=>{});
      const response=new Response(new ReadableStream({start(c){if(phase==='body')c.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled=true;}}));
      if(phase==='late')await new Promise(r=>setTimeout(r,60));
      return response;
    }}),/uncertain/);
    assert.ok(Date.now()-started<250);assert.equal(calls,1);assert.equal(signal.aborted,true);
    await new Promise(r=>setTimeout(r,70));if(phase!=='headers')assert.equal(cancelled,true);
  }
});
test('local HTTP fixture: lost PUT is not replayed; inspect, explicit identical replay, conflict and archive',async()=>{
  let writes=0,post=null,receipt=null,drop=true;const sockets=new Set();
  const server=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer synthetic-secret');
    assert.ok(req.url.startsWith('/api/cms/v1/sites/soot/'));
    if(req.method==='GET') {res.writeHead(post?200:404,{'Content-Type':'application/json'});res.end(JSON.stringify({post}));return;}
    writes++;let raw='';for await(const part of req)raw+=part;
    const payload=JSON.parse(raw);
    if(receipt?.requestId===payload.requestId) {
      if(receipt.raw!==raw){res.writeHead(409);res.end();return;}
      const {bodyMarkdown,...metadata}=post;res.end(JSON.stringify({post:metadata,duplicate:true}));return;
    }
    if(payload.expectedRevision!==(post?.revision??0)){res.writeHead(409);res.end();return;}
    post={...metadata,...payload,slug:input.slug,revision:(post?.revision??0)+1};delete post.requestId;delete post.expectedRevision;
    receipt={requestId:payload.requestId,raw};
    if(drop){drop=false;req.socket.destroy();return;}
    const {bodyMarkdown,...saved}=post;res.end(JSON.stringify({post:saved,duplicate:false}));
  });
  server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const local=JSON.stringify({origin:`http://127.0.0.1:${server.address().port}`,site:'soot',token:'synthetic-secret'});
  try {
    await assert.rejects(callCms('save',call(),local),/uncertain/);assert.equal(writes,1);
    const inspected=await callCms('inspect',call('inspect',{slug:input.slug}),local);assert.equal(inspected.post.revision,1);assert.equal(writes,1);
    assert.equal((await callCms('save',call(),local)).duplicate,true);assert.equal(writes,2);
    assert.deepEqual(await callCms('save',call('save',{...input,title:'changed'}),local),{status:'conflict'});
    assert.deepEqual(await callCms('save',call('save',{...input,requestId:'aa6a7f8c-4246-4bdd-a79d-42fb0bc91d51'}),local),{status:'conflict'});
    const archive={...input,expectedRevision:1,status:'archived',requestId:'bb6a7f8c-4246-4bdd-a79d-42fb0bc91d51'};
    assert.equal((await callCms('save',call('save',archive),local)).post.status,'archived');
  } finally {for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}
});
test('real executable rejects an unnamed Soot/malformed stdin without leaking credential',async()=>{
  for(const data of [JSON.stringify({...call(),soot:''}),Buffer.from([0xff])]) {
    const child=spawn(process.execPath,['tools/cms.mjs','save'],{cwd:new URL('..',import.meta.url),env:{WEBSITE_CMS:credential}});
    let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);child.stdin.end(data);
    const code=await new Promise(r=>child.on('close',r));assert.equal(code,1);assert.ok(!output.includes('synthetic-secret'));assert.match(output,/uncertain/);
  }
});
test('blog CTA allowlist extends only the fixed archive path',()=>{
  const publication={id:'fixture',title:'Posts',intro:'Read evidence-backed posts',blocks:[{type:'cta',label:'Blog',href:'/blog'}]};
  assert.doesNotThrow(()=>validatePublication(publication));
  for(const href of ['/blog/other','//attacker.test','https://2found.dev','/blog?redirect=bad'])assert.throws(()=>validatePublication({...publication,blocks:[{type:'cta',label:'Blog',href}]}));
});

test('optional language is validated without changing legacy payloads or replay receipts', async()=>{
  assert.deepEqual(validateInput('save',input),input);
  for (const language of ['en','vi']) assert.deepEqual(validateInput('save',{...input,language}),{...input,language});
  for (const language of [null,undefined,'EN','fr','',1]) assert.throws(()=>validateInput('save',{...input,language}));
  for (const language of ['en','vi']) {
    const value={...input,language,title:'Bài viết: '+'ắ'.repeat(190),summary:'ộ'.repeat(500)};
    const response={post:{...metadata,language},duplicate:true};
    assert.deepEqual(await callCms('save',call('save',value),credential,{fetcher:async(_url,options)=>{
      const {slug,...payload}=value; assert.equal(options.body,JSON.stringify(payload)); return json(response);
    }}),response);
    const inspected={post:{...metadata,language,bodyMarkdown:input.bodyMarkdown}};
    assert.deepEqual(await callCms('inspect',call('inspect',{slug:input.slug}),credential,{fetcher:async()=>json(inspected)}),inspected);
    // Archive uses inspected fields and language, not an implicit English rewrite.
    const archive={...input,requestId:'cc6a7f8c-4246-4bdd-a79d-42fb0bc91d51',expectedRevision:inspected.post.revision,status:'archived',language:inspected.post.language};
    await callCms('save',call('save',archive),credential,{fetcher:async(_url,options)=>{
      assert.equal(JSON.parse(options.body).language,language);return json({post:{...metadata,status:'archived',language},duplicate:false});
    }});
  }
  for(const post of [{...metadata,language:'fr'},metadata,{...metadata,language:'en'}])await assert.rejects(callCms('save',call('save',{...input,language:'vi'}),credential,{fetcher:async()=>json({post,duplicate:false})}),/uncertain/);
  await assert.rejects(callCms('inspect',call('inspect',{slug:input.slug}),credential,{fetcher:async()=>json({post:{...metadata,language:null,bodyMarkdown:input.bodyMarkdown}})}),/unavailable/);
});

test('Vietnamese lost-save recovery keeps exact language payload; changing it under a receipt conflicts', async()=>{
  let writes=0,receipt,post;
  const value={...input,language:'vi',title:'Nguồn tiếng Việt 😀',summary:'Bằng chứng',bodyMarkdown:'[Nguồn](https://example.org)'};
  const fetcher=async(_url,options)=>{
    if(options.method==='GET') return json({post:{...post,bodyMarkdown:value.bodyMarkdown}});
    writes++;
    const raw=options.body,payload=JSON.parse(raw);
    if(receipt) return raw===receipt ? json({post,duplicate:true}) : new Response(null,{status:409});
    receipt=raw;post={...metadata,title:payload.title,summary:payload.summary,language:payload.language};
    throw new Error('synthetic response loss after commit');
  };
  await assert.rejects(callCms('save',call('save',value),credential,{fetcher}),/uncertain/);assert.equal(writes,1);
  const inspected=await callCms('inspect',call('inspect',{slug:input.slug}),credential,{fetcher});assert.equal(inspected.post.language,'vi');assert.equal(writes,1);
  assert.equal((await callCms('save',call('save',value),credential,{fetcher})).duplicate,true);
  const {language,...omitted}=value;
  for(const changed of [omitted,{...value,language:'en'}]) assert.deepEqual(await callCms('save',call('save',changed),credential,{fetcher}),{status:'conflict'});
});
