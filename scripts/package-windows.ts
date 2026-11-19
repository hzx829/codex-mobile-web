import {mkdir,cp,copyFile,readFile,writeFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {writeBundleLicenses} from './bundle-licenses.js';
import {copyWindowsRuntime} from './windows-package-runtime.js';
if(process.platform!=='win32')throw new Error('Windows 便携包请在 Windows 构建');
const pkg=JSON.parse(await readFile('package.json','utf8'));
const target=resolve('release',`codex-mobile-web-${pkg.version}-${Date.now()}`);await mkdir(join(target,'runtime'),{recursive:true});
for(const name of ['build','dist','scripts/windows'])await cp(resolve(name),join(target,name),{recursive:true});
for(const name of ['start.cmd','stop.cmd','configure.cmd','connector-only.cmd','README.md','README.zh-CN.md','PRIVACY.md','LICENSE','QUICKSTART.md','DEPLOY.md','ACCEPTANCE.md','SOURCES.md'])await copyFile(name,join(target,name));
await copyWindowsRuntime(target);
// Include licenses of installed packages used in the bundle without shipping credentials or research copies.
await writeBundleLicenses(target);
let revision='untracked';try{revision=execFileSync('git',['rev-parse','--short','HEAD'],{encoding:'utf8'}).trim();if(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim())revision+=' (uncommitted changes)';}catch{}
await writeFile(join(target,'VERSION.txt'),`Codex Mobile Web ${pkg.version}\nSource ${revision}\nNode ${process.version}\nWindows ${process.arch}\nProtocol checked: Codex CLI 0.146.0 / Desktop 26.901.6511.0\nDesktop writes, phone UX and live third-party models require manual acceptance.\n`);
const quote=(value:string)=>"'"+value.replace(/'/g,"''")+"'",archive=target+'.zip';
execFileSync('powershell.exe',['-NoProfile','-Command',`Compress-Archive -LiteralPath ${quote(target)} -DestinationPath ${quote(archive)} -CompressionLevel Optimal`],{windowsHide:true,stdio:'pipe',timeout:180000});
const digest=createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(archive+'.sha256',`${digest}  ${archive.slice(dirname(archive).length+1)}\n`);
console.log(`便携包：${archive}\nSHA256：${digest}`);
