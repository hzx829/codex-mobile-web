import {mkdir,cp,copyFile,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {writeBundleLicenses} from './bundle-licenses.js';
import {copyWindowsRuntime} from './windows-package-runtime.js';
if(process.platform!=='win32')throw new Error('Windows 便携包请在 Windows 构建');
const pkg=JSON.parse(await readFile('package.json','utf8'));
// Compiled with the C# 5 compiler that ships with .NET Framework 4, so no SDK is needed to build the package.
async function buildTray(output:string) {
  const framework=join(process.env.WINDIR||String.raw`C:\Windows`,'Microsoft.NET');
  const csc=[join(framework,'Framework64','v4.0.30319','csc.exe'),join(framework,'Framework','v4.0.30319','csc.exe')];
  const compiler=csc.find(path=>{try{execFileSync(path,['-help'],{stdio:'ignore',windowsHide:true});return true;}catch{return false;}});
  if(!compiler)throw new Error('找不到 .NET Framework 4 的 csc.exe，无法生成托盘程序');
  const work=resolve('.local','tray-build');await rm(work,{recursive:true,force:true});await mkdir(work,{recursive:true});
  const version=String(pkg.version).replace(/[^0-9.].*$/,'').split('.').concat('0','0','0').slice(0,4).join('.');
  await writeFile(join(work,'AssemblyInfo.cs'),`using System.Reflection;\n[assembly: AssemblyTitle("Codex Mobile Web")]\n[assembly: AssemblyProduct("Codex Mobile Web")]\n[assembly: AssemblyDescription("Codex Mobile Web tray")]\n[assembly: AssemblyVersion("${version}")]\n[assembly: AssemblyFileVersion("${version}")]\n`);
  const sources=[resolve('scripts/windows/tray/Tray.cs'),join(work,'AssemblyInfo.cs')];
  const compile=(out:string,extra:string[])=>execFileSync(compiler,['-nologo','-codepage:65001','-target:winexe','-optimize+','-r:System.Windows.Forms.dll','-r:System.Drawing.dll',`-win32manifest:${resolve('scripts/windows/tray/app.manifest')}`,`-out:${out}`,...extra,...sources],{stdio:'pipe',windowsHide:true,timeout:60000});
  // The icon is drawn by the tray code itself, so build once without it, export it, then build the final exe.
  const bootstrap=join(work,'icon-writer.exe'),icon=join(work,'app.ico');
  compile(bootstrap,[]);execFileSync(bootstrap,['--write-icon',icon],{windowsHide:true,timeout:30000});
  compile(output,[`-win32icon:${icon}`]);
}
const target=resolve('release',`codex-mobile-web-${pkg.version}-${Date.now()}`);await mkdir(join(target,'runtime'),{recursive:true});
for(const name of ['build','dist','scripts/windows'])await cp(resolve(name),join(target,name),{recursive:true,filter:source=>!source.startsWith(resolve('scripts/windows/tray'))});
// The tray app replaces the .cmd launchers in the package; source checkouts keep using them.
await buildTray(join(target,'Codex Mobile Web.exe'));
for(const name of ['README.md','README.zh-CN.md','PRIVACY.md','LICENSE','QUICKSTART.md','DEPLOY.md','ACCEPTANCE.md','SOURCES.md'])await copyFile(name,join(target,name));
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
