import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export const MAX_RESPONSE_BYTES = 128 * 1024;
export const MAX_STDIN_BYTES = 512 * 1024;
const invalid = () => { throw new Error('Invalid CMS fields or scope'); };
function keys(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || !fields.every(k => Object.hasOwn(value,k))) invalid();
}
const unicode = value => typeof value === 'string' && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
function text(value, max, required=false) {
  if (!unicode(value) || Array.from(value).length > max || (required && !value.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) invalid();
}
function slug(value) { if (typeof value !== 'string' || value.length > 96 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) invalid(); }
function integer(value) { if (!Number.isSafeInteger(value) || value < 0) invalid(); }
function body(value) { text(value,40000,true); if (Buffer.byteLength(value,'utf8') > 40000) invalid(); }
function language(value) { if (value !== 'en' && value !== 'vi') invalid(); }
function status(value) { if (!['draft','published','archived'].includes(value)) invalid(); }
export function validateCredential(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 8192) invalid();
  let value; try { value=JSON.parse(raw); } catch { invalid(); }
  keys(value,['origin','site','token']);
  let url; try { url=new URL(value.origin); } catch { invalid(); }
  const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if (url.origin !== value.origin || url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) invalid();
  if (typeof value.site !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.site) || value.site.length > 64) invalid();
  if (typeof value.token !== 'string' || !value.token || value.token.length > 4096 || /[^\x21-\x7e]/.test(value.token)) invalid();
  return value;
}
export function validateInput(action, value) {
  if (action === 'inspect') { keys(value,['slug']); slug(value.slug); return value; }
  if (action !== 'save') invalid();
  keys(value,['slug','requestId','expectedRevision','title','summary','bodyMarkdown','status',...(Object.hasOwn(value ?? {},'language') ? ['language'] : [])]);
  if (Object.hasOwn(value,'language')) language(value.language);
  slug(value.slug);
  if (typeof value.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.requestId)) invalid();
  integer(value.expectedRevision); text(value.title,200,true); text(value.summary,500); body(value.bodyMarkdown); status(value.status);
  return value;
}
function validateResult(action, value, input) {
  keys(value,action === 'inspect' ? ['post'] : ['post','duplicate']);
  const post=value.post;
  keys(post,['slug','title','summary','author','revision','status','updatedAt','publishedAt',...(action === 'inspect' ? ['bodyMarkdown'] : []),...(Object.hasOwn(post ?? {},'language') ? ['language'] : [])]);
  if (Object.hasOwn(post,'language')) language(post.language);
  slug(post.slug); if (post.slug !== input.slug) invalid();
  text(post.title,200,true); text(post.summary,500); text(post.author,200,true);
  integer(post.revision); if (!post.revision) invalid(); status(post.status); integer(post.updatedAt);
  if (post.publishedAt !== null) integer(post.publishedAt);
  if (post.status === 'published' && post.publishedAt === null) invalid();
  if (action === 'inspect') body(post.bodyMarkdown);
  else {
    if (typeof value.duplicate !== 'boolean' || (post.language ?? 'en') !== (input.language ?? 'en')) invalid();
  }
  return value;
}
export async function readEnvelope(stream) {
  const chunks=[]; let bytes=0;
  for await (const chunk of stream) {
    const buffer=Buffer.from(chunk); bytes+=buffer.length;
    if (bytes > MAX_STDIN_BYTES) invalid();
    chunks.push(buffer);
  }
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
}
// Dependency overrides are fixture-only, never model input or executable argv.
export async function callCms(action, call, raw, {fetcher=fetch,timeoutMs=5000}={}) {
  if (!call || Array.isArray(call) || call.api_version !== 'soot/v1' || call.hook !== 'tool.call' || call.soot !== 'website-marketer' || call.operation !== `website_cms_${action}`) invalid();
  const input=validateInput(action,call.input), credential=validateCredential(raw);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) invalid();
  const url=`${credential.origin}/api/cms/v1/sites/${credential.site}/${action === 'inspect' ? 'drafts' : 'posts'}/${input.slug}`;
  const controller=new AbortController(); let reader, timer;
  const cancel=()=>{controller.abort(); void reader?.cancel().catch(()=>{});};
  const failure=action === 'save' ? 'CMS save outcome uncertain. Inspect latest revision; preserve the same requestId and exact payload. Never automatically retry.' : 'CMS inspect unavailable.';
  const load=async()=>{
    const {slug:ignored,...payload}=input;
    const response=await fetcher(url,{method:action === 'save' ? 'PUT' : 'GET',redirect:'error',credentials:'omit',cache:'no-store',signal:controller.signal,headers:{Accept:'application/json',Authorization:`Bearer ${credential.token}`,...(action === 'save' ? {'Content-Type':'application/json'} : {})},...(action === 'save' ? {body:JSON.stringify(payload)} : {})});
    const discard=()=>{void response.body?.cancel().catch(()=>{});};
    if (controller.signal.aborted || response.redirected || (response.url && response.url !== url)) {discard();throw new Error(failure);}
    if (response.status === 409) {discard();return {status:'conflict'};}
    if (response.status === 404 && action === 'inspect') {discard();return {post:null};}
    if (![200,201].includes(response.status) || !response.body) {discard();throw new Error(failure);}
    const length=response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {discard();throw new Error(failure);}
    reader=response.body.getReader(); const chunks=[]; let bytes=0;
    while (!controller.signal.aborted) {
      const chunk=await reader.read(); if (chunk.done) break;
      bytes+=chunk.value.byteLength; if (bytes > MAX_RESPONSE_BYTES) {cancel();throw new Error(failure);}
      chunks.push(chunk.value);
    }
    if (controller.signal.aborted) throw new Error(failure);
    return validateResult(action,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))),input);
  };
  try {
    return await Promise.race([load(),new Promise((_,reject)=>{timer=setTimeout(()=>{cancel();reject(new Error(failure));},timeoutMs);})]);
  } catch {throw new Error(failure);} finally {clearTimeout(timer);cancel();}
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const raw=process.env.WEBSITE_CMS; delete process.env.WEBSITE_CMS;
    console.log(JSON.stringify(await callCms(process.argv[2],await readEnvelope(process.stdin),raw)));
  } catch {console.error('CMS operation failed or save outcome uncertain. Inspect latest revision and host binding; retain the same requestId/payload before any explicit replay.');process.exitCode=1;}
}
