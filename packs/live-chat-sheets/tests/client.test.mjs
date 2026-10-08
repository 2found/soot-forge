import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SheetsClient } from '../tools/client.mjs';
test('fixed Google endpoint, host authorization, bounded requests and RAW writes',async()=>{
 const calls=[];const client=new SheetsClient({oauth:{getAccessToken:async()=>({token:'ephemeral-test-token'})},fetch:async(url,options)=>{calls.push({url,options});return Response.json({spreadsheetId:'file',sheets:[{properties:{title:'Messages',gridProperties:{rowCount:100}}}]});}});
 assert.deepEqual(await client.validate('file','Messages'),{spreadsheet_id:'file',tab:'Messages',rows:100});await client.write('file',"'Messages'!A2:H2",[['=bad']]);assert.ok(calls.every(c=>c.url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/')));assert.match(calls[1].url,/valueInputOption=RAW/);assert.equal(calls[1].options.redirect,'error');assert.equal(calls[1].options.headers.Authorization,'Bearer ephemeral-test-token');assert.ok(calls[1].options.signal);assert.match(calls[1].options.body,/=bad/);
});
test('sanitized permission/quota/unknown outcomes never disclose vendor responses',async()=>{
 for(const status of [401,403,404,429,503]){const client=new SheetsClient({oauth:{getAccessToken:async()=>'test'},fetch:async()=>new Response('SECRET_VENDOR_BODY',{status})});await assert.rejects(client.write('file','A2',[['hello']]),e=>e.status===status&&!e.message.includes('SECRET')&&e.uncertain===(status>=500));}
 const client=new SheetsClient({oauth:{getAccessToken:async()=>'test'},fetch:async()=>{throw new Error('SECRET');}});await assert.rejects(client.write('file','A2',[['hello']]),e=>e.uncertain);await assert.rejects(client.read('file','A2'),e=>!e.uncertain);
});
