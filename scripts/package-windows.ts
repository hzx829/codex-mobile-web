import {mkdir,cp,copyFile,readFile,writeFile,rm,readdir,stat} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {writeBundleLicenses} from './bundle-licenses.js';
import {copyWindowsRuntime} from './windows-package-runtime.js';
if(process.platform!=='win32')throw new Error('Windows 便携包请在 Windows 构建');
const pkg=JSON.parse(await readFile('package.json','utf8'));
// WebView2 SDK for the tray window: pinned version, verified against the SHA512 that nuget.org publishes for it.
const webView2={version:'1.0.4314.35',sha512:'cOaiVqP3BmQHMnxGpZzANM22tUXgycrisyJHjIGNzIaMsm8iXj7Kx+ceYg+RbYwJtzT009qfcFTocvVLY+ekMw=='};
async function webView2Sdk() {
  const dir=resolve('.local','vendor','webview2',webView2.version),nupkg=join(dir,'package.nupkg'),pkgDir=join(dir,'pkg');
  const verified=async()=>{try{return createHash('sha512').update(await readFile(nupkg)).digest('base64')===webView2.sha512;}catch{return false;}};
  if(!await verified()) {
    await mkdir(dir,{recursive:true});
    const url=`https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${webView2.version}/microsoft.web.webview2.${webView2.version}.nupkg`;
    execFileSync('curl.exe',['-fsSL','--retry','2','-o',nupkg,url],{windowsHide:true,stdio:'pipe',timeout:180000});
    if(!await verified()){await rm(nupkg,{force:true});throw new Error('WebView2 SDK 校验失败，未生成 ZIP');}
    await rm(pkgDir,{recursive:true,force:true});
  }
  const core=join(pkgDir,'lib','net462','Microsoft.Web.WebView2.Core.dll');
  try{await stat(core);}catch{
    await mkdir(pkgDir,{recursive:true});
    execFileSync(join(process.env.WINDIR||String.raw`C:\Windows`,'System32','tar.exe'),['-xf',nupkg,'-C',pkgDir],{windowsHide:true,stdio:'pipe',timeout:60000});
  }
  return {core,loader:join(pkgDir,'runtimes','win-x64','native','WebView2Loader.dll'),license:join(pkgDir,'LICENSE.txt'),notice:join(pkgDir,'NOTICE.txt')};
}
// Compiled with the C# 5 compiler that ships with .NET Framework 4, so no SDK is needed to build the package.
async function buildTray(output:string) {
  const sdk=await webView2Sdk(),runtime=join(dirname(output),'runtime');
  await mkdir(runtime,{recursive:true});
  await copyFile(sdk.core,join(runtime,'Microsoft.Web.WebView2.Core.dll'));
  await copyFile(sdk.loader,join(runtime,'WebView2Loader.dll'));
  await writeFile(join(runtime,'WEBVIEW2-LICENSE.txt'),`Microsoft.Web.WebView2 ${webView2.version} (Microsoft.Web.WebView2.Core.dll, WebView2Loader.dll)

${await readFile(sdk.license,'utf8')}

${await readFile(sdk.notice,'utf8')}`);
  const framework=join(process.env.WINDIR||String.raw`C:\Windows`,'Microsoft.NET');
  const csc=[join(framework,'Framework64','v4.0.30319','csc.exe'),join(framework,'Framework','v4.0.30319','csc.exe')];
  const compiler=csc.find(path=>{try{execFileSync(path,['-help'],{stdio:'ignore',windowsHide:true});return true;}catch{return false;}});
  if(!compiler)throw new Error('找不到 .NET Framework 4 的 csc.exe，无法生成托盘程序');
  const work=resolve('.local','tray-build');await rm(work,{recursive:true,force:true});await mkdir(work,{recursive:true});
  const version=String(pkg.version).replace(/[^0-9.].*$/,'').split('.').concat('0','0','0').slice(0,4).join('.');
  await writeFile(join(work,'AssemblyInfo.cs'),`using System.Reflection;\n[assembly: AssemblyTitle("Codex Mobile Web")]\n[assembly: AssemblyProduct("Codex Mobile Web")]\n[assembly: AssemblyDescription("Codex Mobile Web tray")]\n[assembly: AssemblyVersion("${version}")]\n[assembly: AssemblyFileVersion("${version}")]\n`);
  const trayDir=resolve('scripts/windows/tray'),sources=[...(await readdir(trayDir)).filter(name=>name.endsWith('.cs')).map(name=>join(trayDir,name)),join(work,'AssemblyInfo.cs')];
  const compile=(out:string,extra:string[])=>execFileSync(compiler,['-nologo','-codepage:65001','-target:winexe','-optimize+','-platform:x64','-r:System.Windows.Forms.dll','-r:System.Drawing.dll','-r:System.Web.Extensions.dll',`-r:${join(runtime,'Microsoft.Web.WebView2.Core.dll')}`,`-win32manifest:${resolve('scripts/windows/tray/app.manifest')}`,`-out:${out}`,...extra,...sources],{stdio:'pipe',windowsHide:true,timeout:60000});
  // The icon is drawn by the tray code itself, so build once without it, export it, then build the final exe.
  const bootstrap=join(work,'icon-writer.exe'),icon=join(work,'app.ico');
  await copyFile(join(runtime,'Microsoft.Web.WebView2.Core.dll'),join(work,'Microsoft.Web.WebView2.Core.dll'));
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
