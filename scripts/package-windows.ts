import {mkdir,cp,copyFile,readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
if(process.platform!=='win32')throw new Error('Windows 便携包请在 Windows 构建');
const pkg=JSON.parse(await readFile('package.json','utf8'));
const target=resolve('release',`codex-mobile-web-${pkg.version}-${Date.now()}`);await mkdir(join(target,'runtime'),{recursive:true});
for(const name of ['build','dist','scripts/windows'])await cp(resolve(name),join(target,name),{recursive:true});
for(const name of ['start.cmd','stop.cmd','configure.cmd','connector-only.cmd','QUICKSTART.md','ACCEPTANCE.md','SOURCES.md'])await copyFile(name,join(target,name));
await copyFile(process.execPath,join(target,'runtime','node.exe'));
const licenseCache=resolve('.local','licenses',`node-${process.version}-LICENSE.txt`);
let nodeLicense='';
try {nodeLicense=await readFile(process.env.NODE_LICENSE_FILE||licenseCache,'utf8');}catch{}
if(!nodeLicense)for(let attempt=0;attempt<2;attempt++) {
  try {const response=await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`,{signal:AbortSignal.timeout(10000)});if(response.ok){nodeLicense=await response.text();break;}}catch{}
}
if(!nodeLicense.includes('Node.js is licensed for use as follows')||nodeLicense.length<10000)throw new Error('无法获取该版本 Node 的完整许可证，未生成 ZIP；可设置 NODE_LICENSE_FILE 指向同版本官方 LICENSE 后重试。');
await mkdir(dirname(licenseCache),{recursive:true});await writeFile(licenseCache,nodeLicense);
await writeFile(join(target,'runtime','NODE-LICENSE.txt'),nodeLicense);
// Include licenses of installed packages used in the bundle without shipping credentials or research copies.
const licenses:string[]=[];
async function scan(folder:string){for(const name of await readdir(folder)){if(name.startsWith('.'))continue;const path=join(folder,name);if(!(await stat(path)).isDirectory())continue;if(name.startsWith('@')){await scan(path);continue;}try{const pkg=JSON.parse(await readFile(join(path,'package.json'),'utf8'));const entries=await readdir(path);const file=entries.find(n=>/^licen[cs]e(\.|$)/i.test(n));if(file)licenses.push(`===== ${pkg.name}@${pkg.version} =====\n${await readFile(join(path,file),'utf8')}`);}catch{}}}
await scan(resolve('node_modules'));await writeFile(join(target,'THIRD-PARTY-LICENSES.txt'),licenses.join('\n\n'));
let revision='untracked';try{revision=execFileSync('git',['rev-parse','--short','HEAD'],{encoding:'utf8'}).trim();if(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim())revision+=' (uncommitted changes)';}catch{}
await writeFile(join(target,'VERSION.txt'),`Codex Mobile Web ${pkg.version}\nSource ${revision}\nNode ${process.version}\nWindows ${process.arch}\nProtocol checked: Codex CLI 0.146.0 / Desktop 26.901.6511.0\nDesktop writes, phone UX and live third-party models require manual acceptance.\n`);
const quote=(value:string)=>"'"+value.replace(/'/g,"''")+"'",archive=target+'.zip';
execFileSync('powershell.exe',['-NoProfile','-Command',`Compress-Archive -LiteralPath ${quote(target)} -DestinationPath ${quote(archive)} -CompressionLevel Optimal`],{windowsHide:true,stdio:'pipe',timeout:180000});
const digest=createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(archive+'.sha256',`${digest}  ${archive.slice(dirname(archive).length+1)}\n`);
console.log(`便携包：${archive}\nSHA256：${digest}`);
