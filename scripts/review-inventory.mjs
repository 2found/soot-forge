// Record the exact deterministic source archives reviewed, including external
// pins. No dependency installation, contributor runner or provider call.
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {readCatalog, materialize} from './catalog.mjs';
import {archivePack} from './archive.mjs';

if(process.argv.length!==4||process.argv[2]!=='--report')throw Error('Usage: node scripts/review-inventory.mjs --report FILE');
const root=resolve(import.meta.dirname,'..'),work=await mkdtemp(join(tmpdir(),'forge-review-inventory-'));
const catalog=await readCatalog(root),packs=[];
try{
  for(const entry of catalog.packs){
    const folder=await materialize(entry,root,work);
    const manifest=JSON.parse(await readFile(join(folder,'pack.json')));
    const archive=join(work,`${entry.id}.tar.gz`);await archivePack(folder,archive,entry.id);
    const capabilities=[];
    for(const [name,cap] of Object.entries(manifest.capabilities)){
      let bytes=0;for(const skill of cap.skills??[])bytes+=(await stat(join(folder,skill.file))).size;
      capabilities.push({name,skills:(cap.skills??[]).length,skill_bytes:bytes,tools:(cap.tools??[]).length});
    }
    const blob=await readFile(archive);
    packs.push({id:entry.id,source:entry.source,archive_sha256:createHash('sha256').update(blob).digest('hex'),archive_bytes:blob.length,use:manifest.use??null,capabilities});
  }
  await writeFile(resolve(process.argv[3]),JSON.stringify({scope:'Deterministic materialized source archives; excludes fixtures/bin/data/dependency caches exactly as release packaging does',packs},null,2)+'\n');
  console.log(`Recorded ${packs.length} validated source archives`);
}finally{await rm(work,{recursive:true,force:true});}
