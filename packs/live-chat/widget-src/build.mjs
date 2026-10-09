import {build} from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
await build({entryPoints:['composer.jsx'],outfile:'../widget/widget-composer.js',bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,define:{'process.env.NODE_ENV':'"production"'},legalComments:'eof'});
const manifest=JSON.parse(await readFile('../widget/ui-manifest.json','utf8'));
manifest.composer={package:'@tofound/ui',version:JSON.parse(await readFile('node_modules/@tofound/ui/package.json','utf8')).version,sha256:createHash('sha256').update(await readFile('../widget/widget-composer.js')).digest('hex')};
await writeFile('../widget/ui-manifest.json',JSON.stringify(manifest,null,2)+'\n');
