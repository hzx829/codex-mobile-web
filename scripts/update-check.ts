// Invoked on demand. Changed installations receive real compatibility checks.
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream,existsSync,openSync,closeSync} from 'node:fs';
import {mkdir,readFile,readdir,writeFile,rename,open,unlink,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {resolveWindowsCodex} from '../src/connector/app-server.js';
import {BridgeError,type Json} from '../src/shared/types.js';
import {verifyRuntime} from './runtime-check.js';
import {bridgeRequest} from './bridge-client.js';

type Installation={bin:string;version:string;binaryHash:string;desktop:string;desktopHash:string;sourceHash:string};
type Candidate={fingerprint:string;installation:Installation;checkedAt:string;checks:'passed'|'failed';bundleHash:string;webHash:string};
type State={candidate?:Candidate;accepted?:{fingerprint:string;at:string};last?:Json};
const statePath='.local/update-check.json',logPath='.local/update-check.log';
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export const fingerprint=(installation:Installation)=>digest(JSON.stringify(installation));
async function fileHash(path:string){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
async function sourceHash(){
  const hash=createHash('sha256');
  async function walk(path:string):Promise<void>{
    for(const entry of (await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      const name=join(path,entry.name);if(entry.isDirectory())await walk(name);else if(entry.isFile()){hash.update(name);hash.update(await readFile(name));}
    }
  }
  for(const dir of ['src','web','scripts','test'])await walk(dir);
  for(const path of ['package.json','package-lock.json','tsconfig.json','vite.config.ts']){hash.update(path);hash.update(await readFile(path));}
  return hash.digest('hex');
}
export async function installation():Promise<Installation>{
  if(process.platform!=='win32')throw Error('此桌面更新检测器只支持 Windows');
  const bin=resolveWindowsCodex(process.env.PATH||'',process.env.LOCALAPPDATA||'');
  const version=execFileSync(bin,['--version'],{encoding:'utf8',windowsHide:true,timeout:10000,stdio:['ignore','pipe','ignore']}).trim().replace(/^codex(?:-cli)?\s+/,'');
  const root=join(process.env.ProgramFiles||'C:\\Program Files','WindowsApps');
  const packages=(await readdir(root)).filter(name=>/^OpenAI\.Codex_\d+(?:\.\d+)+_/.test(name)&&existsSync(join(root,name,'app','resources','app.asar')))
    .sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
  const desktop=packages[0];if(!desktop)throw Error('未找到 Codex 桌面安装，不能确认更新状态');
  const [binaryHash,desktopHash,codeHash]=await Promise.all([fileHash(bin),fileHash(join(root,desktop,'app','resources','app.asar')),sourceHash()]);
  return {bin,version,binaryHash,desktop,desktopHash,sourceHash:codeHash};
}
export function updateAction(candidate:Candidate,accepted:State['accepted'],info:Json,webHash?:string):string {
  if(candidate.checks!=='passed')return 'fix-compatibility';
  if(!info.runtime?.bundleHash||info.runtime.bundleHash!==candidate.bundleHash)return 'deploy-connector';
  if(webHash!==undefined&&webHash!==candidate.webHash)return 'deploy-web';
  try{verifyRuntime(info,candidate.installation.bin,candidate.installation.version);}catch{return 'reload-runtime';}
  return accepted?.fingerprint===candidate.fingerprint?'none':'reload-runtime';
}
async function checks(bin:string):Promise<boolean>{
  const fd=openSync(logPath,'w'),env={...process.env,CODEX_BIN:bin};
  async function run(args:string[]):Promise<boolean>{
    return new Promise(resolveRun=>{
      const child=spawn(process.execPath,args,{env,windowsHide:true,stdio:['ignore',fd,fd]});
      const timer=setTimeout(()=>child.kill(),180000);
      child.on('error',()=>{clearTimeout(timer);resolveRun(false);});child.on('exit',code=>{clearTimeout(timer);resolveRun(code===0);});
    });
  }
  try{
    const tsx='node_modules/tsx/dist/cli.mjs',tsc='node_modules/typescript/bin/tsc';
    const tests=(await readdir('test')).filter(name=>name.endsWith('.test.ts')).sort().map(name=>join('test',name));
    return await run([tsc,'--noEmit'])&&await run([tsx,'--test',...tests])&&await run([tsx,'scripts/native-check.ts'])&&await run(['node_modules/vite/bin/vite.js','build'])&&await run([tsx,'scripts/build-node.ts']);
  }finally{closeSync(fd);}
}
async function save(state:State){await writeFile(statePath+'.next',JSON.stringify(state,null,2)+'\n');await rename(statePath+'.next',statePath);}
export async function checkUpdate(apply=false,retry=false):Promise<Json>{
  await mkdir('.local',{recursive:true});
  let state:State;try{state=JSON.parse(await readFile(statePath,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;state={};}
  const current=await installation(),key=fingerprint(current);
  if(!state.candidate||state.candidate.fingerprint!==key||retry){
    const passed=await checks(current.bin);
    state.candidate={fingerprint:key,installation:current,checkedAt:new Date().toISOString(),checks:passed?'passed':'failed',bundleHash:passed?await fileHash('build/connector.mjs'):'',webHash:passed?await fileHash('dist/index.html'):''};
    await save(state);
  }
  const candidate=state.candidate!;
  let result:Json={status:'needs-adaptation',action:'fix-compatibility',installation:current,checks:candidate.checks,log:resolve(logPath),liveChatGPT:false,uiAcceptance:false};
  if(candidate.checks==='passed'){
    if(await fileHash('build/connector.mjs')!==candidate.bundleHash)throw Error('本地构建与检查记录不符，请使用 --retry 重新检查构建');
    const config=JSON.parse(await readFile('.local/config.json','utf8'));
    const [info,response]=await Promise.all([bridgeRequest('info'),fetch(new URL(config.relayUrl).origin+'/',{signal:AbortSignal.timeout(10000)})]);
    if(!response.ok)throw Error('中继网页检查失败');
    const webHash=createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
    result.action=updateAction(candidate,state.accepted,info,webHash);result.runtime=info.runtime;result.web={status:webHash===candidate.webHash?'passed':'mismatch',expectedHash:candidate.webHash,actualHash:webHash};
    if(result.action==='reload-runtime'&&apply){
      // Recheck the complete installation after tests and before switching it.
      if(fingerprint(await installation())!==key)throw Error('检查期间安装或代码有变化，请重新检查');
      try{
        result.reload=await bridgeRequest('runtime.reload',{generation:info.generation,expectedBin:current.bin});
        const after=await bridgeRequest('info');verifyRuntime(after,current.bin,current.version);
        if(after.runtime.bundleHash!==candidate.bundleHash)throw Error('部署的连接器构建不符');
        result.runtime=after.runtime;result.action='none';
      }catch(error){if(error instanceof BridgeError&&error.code==='active'){result.status='waiting-idle';result.reason=error.message;}else throw error;}
    }
    if(result.action==='none'){
      const first=state.accepted?.fingerprint!==key;
      await copyFile('build/connector.mjs','.local/connector-accepted.mjs');
      state.accepted={fingerprint:key,at:first?new Date().toISOString():state.accepted!.at};
      result.status=first?'adapted':'unchanged';
    }
  }else result.status='failed';
  state.last={at:new Date().toISOString(),...result};await save(state);return state.last;
}
async function acquireLock(){
  const path='.local/update-check.lock';
  try{return await open(path,'wx');}catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    const pid=Number(await readFile(path,'utf8'));if(!Number.isInteger(pid)||pid<=0)throw Error('更新检测锁无效，请核实');
    try{process.kill(pid,0);throw Error('更新检测已在运行');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
    await unlink(path);return open(path,'wx');
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  await mkdir('.local',{recursive:true});let lock;
  try{
    lock=await acquireLock();await lock.writeFile(String(process.pid));
    const result=await checkUpdate(process.argv.includes('--apply'),process.argv.includes('--retry'));await writeFile('.local/update-check-last.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));if(result.status==='failed')process.exitCode=1;
  }catch(error){const result={at:new Date().toISOString(),status:'failed',error:(error as Error).message,liveChatGPT:false,uiAcceptance:false};await writeFile('.local/update-check-last.json',JSON.stringify(result,null,2)+'\n');console.error(JSON.stringify(result));process.exitCode=1;}
  finally{if(lock){await lock.close();await unlink('.local/update-check.lock');}}
}
