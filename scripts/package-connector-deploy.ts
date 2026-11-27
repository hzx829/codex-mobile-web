// Updates the connector of an installed Windows package in place. Only <package>/build/connector.mjs changes.
// Use this when the running connector is the installed package (started by "Codex Mobile Web.exe") rather than this
// repository: update:deploy checks the repository's own installation and Codex, so it refuses for the package.
//   npm run build && npm run deploy:package-connector -- <package folder> [connector.mjs, default build/connector.mjs]
// Refuses while Claude Code or Codex is busy (the connector's own reload guard). Keeps the old build as
// .local/connector-before-<hash>.mjs in the package, reconnects the Codex sessions it was running, and puts the old
// build back if the new one does not come up. The package keeps its own settings (relay, token, Codex binary).
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access,copyFile,readFile,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {bridgeRequest} from './bridge-client.js';
import {BridgeError,type Json} from '../src/shared/types.js';

const execute=promisify(execFile);
const digest=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const [packageArg,sourceArg]=process.argv.slice(2);
if(!packageArg){console.error('用法：npm run deploy:package-connector -- <安装包文件夹> [connector.mjs]');process.exit(2);}
const source=resolve(sourceArg||'build/connector.mjs');
const repoStartScript=resolve('scripts/windows/start.ps1');
const repoSessionCli=resolve('build/session-cli.mjs');
await access(resolve(packageArg,'.local/config.json')).catch(()=>{console.error('这个文件夹不是已配置的安装包（缺少 .local/config.json）');process.exit(2);});
// bridgeRequest and the start/stop scripts work on the current folder, so everything below runs inside the package.
process.chdir(resolve(packageArg));
const target=resolve('build/connector.mjs');
const ps=(script:string,args:string[])=>execute('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',resolve('scripts/windows',script),...args],{windowsHide:true,timeout:60000});
async function pid(){const value=Number((await readFile('.local/connector.pid','utf8')).trim());if(!Number.isInteger(value)||value<=0)throw Error('连接器进程记录无效');return value;}
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function info(){for(let i=0;i<30;i++){try{return await bridgeRequest('info');}catch{await wait(2000);}}throw Error('连接器重启后没有上线');}
async function restore(ids:string[]){
  for(const id of ids){
    let view=await bridgeRequest('session.read',{threadId:id,limit:5});
    if(view.source==='history'){
      if(view.running||view.activeTurnId||view.requests?.length||view.resumeUnavailable)throw Error('会话不能安全恢复');
      const result=await bridgeRequest('session.resume',{threadId:id,confirmIdle:true,opId:`${Date.now()}:${randomUUID()}`});
      if(result.state!=='accepted')throw Error('会话接入回执未确认');
      view=await bridgeRequest('session.read',{threadId:id,limit:5});
    }
    if(!['connector','desktop'].includes(view.source))throw Error('会话未恢复');
  }
}
let receipt:Json={at:new Date().toISOString(),status:'failed',package:process.cwd()};
try{
  const next=await readFile(source),nextHash=digest(next);
  const before=await info();
  if(before.runtime?.bundleHash===nextHash){
    await copyFile(repoStartScript,resolve('scripts/windows/start.ps1')).catch(()=>{});
    await copyFile(repoSessionCli,resolve('build/session-cli.mjs')).catch(()=>{});
    receipt={...receipt,status:'unchanged',runtime:before.runtime};
  }
  else{
    const current=await readFile(target),currentHash=digest(current);
    if(currentHash!==before.runtime?.bundleHash)throw Error('包里的 connector.mjs 和正在运行的构建不一致');
    const previousPid=await pid();
    const prepared=await bridgeRequest('runtime.reload',{generation:before.generation,expectedBin:before.runtime.bin,prepareOnly:true});
    if(prepared.prepared!==true||!Array.isArray(prepared.threadIds))throw Error('连接器没有确认可以重启');
    const backup=resolve(`.local/connector-before-${currentHash.slice(0,12)}.mjs`);
    await writeFile(backup,current);
    await ps('stop.ps1',['-Mode','connector','-ExpectedPid',String(previousPid)]);
    try{
      await copyFile(source,target);
      await copyFile(repoStartScript,resolve('scripts/windows/start.ps1')).catch(()=>{});
      await copyFile(repoSessionCli,resolve('build/session-cli.mjs')).catch(()=>{});
      await ps('start.ps1',['-Mode','connector','-NoOpen']);
      const after=await info();
      if(after.runtime?.bundleHash!==nextHash)throw Error('新连接器构建未生效');
      if(after.runtime?.bin!==before.runtime.bin)throw Error('重启后 Codex 执行文件变了');
      await restore(prepared.threadIds);
      receipt={...receipt,status:'deployed',previousPid,connectorPid:await pid(),backup,restored:prepared.threadIds.length,runtime:after.runtime};
    }catch(error){
      try{await ps('stop.ps1',['-Mode','connector','-ExpectedPid',String(await pid())]);}catch{}
      await writeFile(target,current);await ps('start.ps1',['-Mode','connector','-NoOpen']);
      const recovered=await info();await restore(prepared.threadIds);
      if(recovered.runtime?.bundleHash!==before.runtime.bundleHash)throw Error('部署和回退都未确认，需要核实');
      throw Error(`部署失败，已恢复原构建：${(error as Error).message}`);
    }
  }
}catch(error){receipt={...receipt,status:error instanceof BridgeError&&error.code==='active'?'waiting-idle':'failed',error:(error as Error).message};process.exitCode=receipt.status==='failed'?1:0;}
console.log(JSON.stringify(receipt));
await writeFile('.local/connector-update-receipt.json',JSON.stringify(receipt,null,2)+'\n');
