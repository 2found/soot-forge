import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute, approve as approveOperation } from '../tools/ledger.mjs';

async function approve(host,input) {const row=JSON.parse(await readFile(join(host.directory,input.id+'.json'),'utf8'));return approveOperation(host,{plan_revision:row.plan_revision,...input});}

async function fixture(t) {
 const directory=await mkdtemp(join(tmpdir(),'marketing-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const team=[{id:'blog',channels:['blog']},{id:'x',channels:['x']}];
 const host=soot=>({soot,directory,channels:{[soot]:{endpoint:'http://127.0.0.1:9999',destination:soot,token:'synthetic-fixture-only'}}});
 const call=async(soot,action,input,fetcher)=>{if(action==='plan'&&input.expected_plan_revision===undefined){const row=JSON.parse(await readFile(join(directory,input.id+'.json'),'utf8'));input={...input,expected_plan_revision:row.plan_revision};}return execute(host(soot),{api_version:'soot/v1',hook:'tool.call',operation:'marketing_'+action,soot,team},action,input,fetcher);};
 const draft=await call('creator','draft',{id:'launch',expected_revision:0,title:'Source-supported launch',body:'A verified update. [Source](https://example.com/release)',sources:[{pool:'sources',document:'release',revision:2,url:'https://example.com/release'}]});
 const entries=team.map(m=>({publisher:m.id,channel:m.channels[0],at:'2026-01-01T00:00:00Z',timezone:'Asia/Ho_Chi_Minh'}));
 return {directory,team,host,call,draft,entries};
}
test('zero, one and multiple publishers; roster is host-owned',async t=>{
 const f=await fixture(t);
 for(const n of [0,1,2]) {const record=await f.call('editor','plan',{id:'launch',expected_revision:1,entries:f.entries.slice(0,n)});assert.equal(record.plan.length,n);assert.ok(record.plan.every(r=>r.scheduled===false));}
 await assert.rejects(f.call('editor','plan',{id:'launch',expected_revision:1,entries:[{...f.entries[0],publisher:'hidden-admin'}]}),/outside/);
 await assert.rejects(f.call('editor','plan',{id:'launch',expected_revision:0,entries:[]}),/revision/);
});
test('exact approval, lost response reconciliation, per-channel receipts and no repost',async t=>{
 const f=await fixture(t);await f.call('editor','plan',{id:'launch',expected_revision:1,entries:f.entries});let posts=0;
 const input={id:'launch',expected_revision:1,channel:'blog'};
 await assert.rejects(f.call('blog','publish',input),/approval/);
 for(const channel of ['blog','x'])await approve(f.host(channel),{id:'launch',revision:1,hash:f.draft.hash,channel});
 const gateway=async(_url,opts)=>{posts++;const body=JSON.parse(opts.body);return Response.json({idempotency_key:body.idempotency_key,status:'published',url:'https://example.com/'+body.channel,receipt:'remote-'+body.channel});};
 const blog=await f.call('blog','publish',input,gateway);assert.equal(blog.status,'published');assert.equal(posts,1);
 await f.call('blog','publish',input,gateway);assert.equal(posts,1);
 const xInput={...input,channel:'x'};
 const x=await f.call('x','publish',xInput,async()=>{posts++;throw new Error('response lost after remote commit');});assert.equal(x.status,'uncertain');assert.equal(posts,2);
 await assert.rejects(f.call('x','publish',xInput,gateway),/uncertain/);assert.equal(posts,2);
 const record=await f.call('editor','inspect',{id:'launch'});assert.equal(Object.values(record.publications).filter(x=>x.status==='published').length,1);
 await assert.rejects(f.call('editor','plan',{id:'launch',expected_revision:1,entries:[]}),/uncertain/);
 await assert.rejects(f.call('x','reconcile',xInput,async()=>Response.json({idempotency_key:'wrong',status:'published',url:'https://example.com/x',receipt:'r'})),/proven/);
 const reconciled=await f.call('x','reconcile',xInput,async(url,opts)=>{assert.match(url.pathname,new RegExp(x.key+'$'));assert.equal(opts.method,undefined);return Response.json({idempotency_key:x.key,status:'published',url:'https://example.com/x',receipt:'remote-x'});});
 assert.equal(reconciled.status,'published');assert.equal(posts,2);
 await f.call('x','publish',xInput,gateway);assert.equal(posts,2);
});
test('content or plan changes invalidate approval; missing binding stays blocked',async t=>{
 const f=await fixture(t);await f.call('editor','plan',{id:'launch',expected_revision:1,entries:[f.entries[0]]});await approve(f.host('blog'),{id:'launch',revision:1,hash:f.draft.hash,channel:'blog'});
 await f.call('editor','plan',{id:'launch',expected_revision:1,entries:[{...f.entries[0],at:'2026-01-02T00:00:00Z'}]});
 await assert.rejects(f.call('blog','publish',{id:'launch',expected_revision:1,channel:'blog'}),/approval/);
 const revised=await f.call('creator','draft',{id:'launch',expected_revision:1,title:'Revised',body:'New copy',sources:f.draft.sources});assert.equal(revised.revision,2);assert.deepEqual(revised.approvals,{});assert.deepEqual(revised.plan,[]);
 await assert.rejects(approve(f.host('blog'),{id:'launch',revision:2,hash:f.draft.hash,channel:'blog'}),/hash/);
 await f.call('editor','plan',{id:'launch',expected_revision:2,entries:[f.entries[0]]});
 await assert.rejects(execute({soot:'blog',directory:f.directory},{api_version:'soot/v1',hook:'tool.call',operation:'marketing_publish',soot:'blog',team:f.team},'publish',{id:'launch',expected_revision:2,channel:'blog'}),/setup/);
});

test('changed gateway binding cannot bypass an uncertain publication',async t=>{
 const f=await fixture(t);await f.call('editor','plan',{id:'launch',expected_revision:1,entries:[f.entries[0]]});
 await approve(f.host('blog'),{id:'launch',revision:1,hash:f.draft.hash,channel:'blog'});
 const input={id:'launch',expected_revision:1,channel:'blog'};let posts=0;
 const original=await f.call('blog','publish',input,async()=>{posts++;throw Error('committed response lost');});
 for(const change of [{destination:'another-blog'},{endpoint:'http://127.0.0.1:8888'}]) {
  const host=f.host('blog');Object.assign(host.channels.blog,change,{automatic:true});
  for(const action of ['publish','reconcile'])await assert.rejects(execute(host,{api_version:'soot/v1',hook:'tool.call',operation:'marketing_'+action,soot:'blog',team:f.team},action,input,async()=>{posts++;throw Error('must not contact changed binding');}),/binding changed/);
 }
 assert.equal(posts,1);
 const recovered=await f.call('blog','reconcile',input,async()=>Response.json({idempotency_key:original.key,status:'published',url:'https://example.com/old',receipt:'original'}));
 assert.equal(recovered.status,'published');assert.equal(posts,1);
});
test('stale editor writes and approvals cannot accept an unreviewed plan',async t=>{
 const f=await fixture(t);const first=await f.call('editor','plan',{id:'launch',expected_revision:1,expected_plan_revision:0,entries:[f.entries[0]]});
 const approval={id:'launch',revision:1,plan_revision:first.plan_revision,hash:f.draft.hash,channel:'blog'};
 const next=await f.call('editor','plan',{id:'launch',expected_revision:1,expected_plan_revision:first.plan_revision,entries:[{...f.entries[0],at:'2026-01-02T00:00:00Z'}]});
 assert.equal(next.plan_revision,first.plan_revision+1);
 await assert.rejects(approveOperation(f.host('blog'),approval),/plan revision/);
 await assert.rejects(f.call('editor','plan',{id:'launch',expected_revision:1,expected_plan_revision:first.plan_revision,entries:[]}),/Plan revision/);
 await approveOperation(f.host('blog'),{...approval,plan_revision:next.plan_revision});
});
