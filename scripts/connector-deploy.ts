// Called only after update:check has built and checked this exact installation.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {bridgeRequest} from './bridge-client.js';
import {fingerprint,installation} from './update-check.js';
import {verifyRuntime} from './runtime-check.js';
import {BridgeError,type Json} from '../src/shared/types.js';

const digest=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const execute=promisify(execFile);
const settings=await readFile('.local/config.json'),configHash=digest(settings);
const state=JSON.parse(await readFile('.local/update-check.json','utf8')),candidate=state.candidate;
let receipt:Json={at:new Date().toISOString(),status:'failed',liveChatGPT:false,uiAcceptance:false};
async function pid(){const value=Number((await readFile('.local/connector.pid','utf8')).trim());if(!Number.isInteger(value)||value<=0)throw Error('连接器进程记录无效');return value;}
async function stop(expectedPid:number){await execute('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',resolve('scripts/windows/stop.ps1'),'-Mode','connector','-ExpectedPid',String(expectedPid)],{windowsHide:true,timeout:30000});}
async function start(bin?:string){await execute('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',resolve('scripts/windows/start.ps1'),'-Mode','connector','-NoOpen'],{windowsHide:true,timeout:30000,env:{...process.env,...(bin?{CODEX_BIN:bin}:{})}});}
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
try{
  if(candidate?.checks!=='passed'||candidate.fingerprint!==fingerprint(await installation()))throw Error('当前安装和代码未通过适配检查');
  if(digest(await readFile('build/connector.mjs'))!==candidate.bundleHash)throw Error('待部署构建与检查记录不符');
  const info=await bridgeRequest('info');
  if(info.runtime?.bundleHash===candidate.bundleHash){receipt={...receipt,status:'unchanged'};}
  else{
    const backup=await readFile('.local/connector-accepted.mjs');
    if(digest(backup)!==info.runtime?.bundleHash)throw Error('缺少与当前运行构建相符的回退文件，不能自动部署');
    const previousPid=await pid();
    const prepared=await bridgeRequest('runtime.reload',{generation:info.generation,expectedBin:candidate.installation.bin,prepareOnly:true});
    if(prepared.prepared!==true||!Array.isArray(prepared.threadIds))throw Error('运行中的连接器不支持部署保护，不能自动重启');
    const before={at:new Date().toISOString(),connectorPid:previousPid,configHash,...prepared};
    await writeFile('.local/connector-update-before.json',JSON.stringify(before,null,2)+'\n');
    if(digest(await readFile('.local/config.json'))!==configHash)throw Error('部署准备期间配置发生变化');
    await stop(previousPid);
    try{
      await start();
      const after=await bridgeRequest('info');verifyRuntime(after,candidate.installation.bin,candidate.installation.version);
      if(after.runtime?.bundleHash!==candidate.bundleHash)throw Error('新连接器构建未生效');
      await restore(prepared.threadIds);
      receipt={...receipt,status:'deployed',connectorPid:await pid(),restored:prepared.threadIds.length,runtime:after.runtime};
    }catch(error){
      await stop(await pid());await writeFile('build/connector.mjs',backup);await start(info.runtime.bin);await restore(prepared.threadIds);
      const recovered=await bridgeRequest('info');
      if(recovered.runtime?.bundleHash!==info.runtime.bundleHash)throw Error('连接器部署和回退未确认，需要核实');
      throw Error(`连接器部署失败，已恢复原构建与会话：${(error as Error).message}`);
    }
  }
  console.log(JSON.stringify(receipt));
}catch(error){receipt={...receipt,status:error instanceof BridgeError&&error.code==='active'?'waiting-idle':'failed',error:(error as Error).message};console.error(JSON.stringify(receipt));if(receipt.status==='failed')process.exitCode=1;}
finally{await writeFile('.local/connector-update-receipt.json',JSON.stringify(receipt,null,2)+'\n');}
