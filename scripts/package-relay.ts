import {mkdir,cp,copyFile,readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,join,dirname,basename} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {writeBundleLicenses} from './bundle-licenses.js';

const pkg=JSON.parse(await readFile('package.json','utf8'));
const target=resolve('release',`codex-mobile-relay-${pkg.version}-${Date.now()}`);
await mkdir(join(target,'build'),{recursive:true});
await copyFile('build/relay.mjs',join(target,'build/relay.mjs'));
await cp('dist',join(target,'dist'),{recursive:true});
for(const name of ['compose.yaml','compose.https.yaml','Caddyfile','.env.example','README.md','README.zh-CN.md','PRIVACY.md','DEPLOY.md','SOURCES.md'])await copyFile(name,join(target,name));
await copyFile('deploy/Dockerfile',join(target,'Dockerfile'));
await copyFile('deploy/.dockerignore',join(target,'.dockerignore'));
await writeBundleLicenses(target);
const revision=execFileSync('git',['rev-parse','--short','HEAD'],{encoding:'utf8'}).trim();
const dirty=execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim();
await writeFile(join(target,'VERSION.txt'),`Codex Mobile Web relay ${pkg.version}\nSource ${revision}${dirty?' (uncommitted changes)':''}\nPrebuilt JavaScript; Node 24 Linux container\nPublic DNS, HTTPS issuance and remote phone access require deployment verification.\n`);
const sums:string[]=[];
async function digest(dir:string,prefix=''){for(const entry of await readdir(dir,{withFileTypes:true})){
  const relative=prefix+entry.name,path=join(dir,entry.name);
  if(entry.isDirectory())await digest(path,relative+'/');
  else sums.push(`${createHash('sha256').update(await readFile(path)).digest('hex')}  ${relative}`);
}}
await digest(target);await writeFile(join(target,'SHA256SUMS'),sums.sort().join('\n')+'\n');
const archive=target+'.tar.gz';
execFileSync('tar',['-czf',archive,'-C',dirname(target),basename(target)],{windowsHide:true,stdio:'pipe',timeout:60000});
const hash=createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(archive+'.sha256',`${hash}  ${basename(archive)}\n`);
console.log(`中继部署包：${archive}\nSHA256：${hash}`);
