// Checks packaged processes and protocol only; interactive Windows and phone UI remain human checks.
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,cp,readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import {resolveCodex} from '../src/connector/app-server.js';
import {removeTestTemp} from './test-temp.js';

if(process.platform!=='win32')throw new Error('Windows only');
const run=promisify(execFile),quote=(value:string)=>"'"+value.replace(/'/g,"''")+"'";
let artifact=process.argv[2];
if(!artifact) {
  const candidates=[];
  for(const name of await readdir('release')) {const path=resolve('release',name),entry=await stat(path);if(entry.isDirectory())candidates.push({path,time:entry.mtimeMs});}
  artifact=candidates.sort((a,b)=>b.time-a.time)[0]?.path;
}
if(!artifact)throw new Error('Build the Windows package first');
const temp=await mkdtemp(join(tmpdir(),'cmw-portable-')),install=join(temp,'便携 验证'),project=join(temp,'中文 项目'),codexHome=join(temp,'codex-home');
const env:NodeJS.ProcessEnv={...process.env,CODEX_PROFILE:''};
for(const name of ['BRIDGE_CONFIG','BRIDGE_TOKEN','BRIDGE_DATA','PORT','HOST','RELAY_URL','CODEX_BIN','CODEX_HOME'])delete env[name];
const ps=(file:string,args:string[]=[])=>new Promise<void>((resolve,reject)=>{
  // Background Windows processes can inherit pipe handles; wait for the launcher itself.
  const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(install,'scripts','windows',file),...args],{cwd:install,env,windowsHide:true,stdio:'ignore'});
  const timer=setTimeout(()=>{child.kill();reject(Error(`${file} timed out`));},30000);
  child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error(`${file} failed (${code})`));});
});
async function setup(input:any) {
  const child=spawn(join(install,'runtime','node.exe'),[join(install,'build','setup.mjs'),'--settings-stdin'],{cwd:install,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let output='',error='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>error+=b);
  const done=once(child,'exit');child.stdin.end(JSON.stringify(input));const [code]=await done;
  assert.equal(code,0,error);return output;
}
async function info(config:any,token=config.token):Promise<any> {
  const ws=new WebSocket(config.relayUrl.replace(/^http/,'ws')+'/ws');
  return new Promise((resolve,reject)=>{
    const finish=(error:any,result?:any)=>{clearTimeout(timer);ws.removeAllListeners();ws.on('error',()=>{});ws.close();error?reject(error):resolve(result);};
    const timer=setTimeout(()=>finish(Error('status timeout')),2000);
    ws.on('open',()=>ws.send(JSON.stringify({type:'hello',role:'phone',token})));
    ws.on('error',e=>finish(e));ws.on('close',code=>finish(Error(`closed ${code}`)));
    ws.on('message',raw=>{
      const m=JSON.parse(raw.toString());
      if(m.type==='ready') {
        if(!m.machines.some((p:any)=>p.id===config.machineId)){finish(Error('connector offline'));return;}
        ws.send(JSON.stringify({type:'request',id:'info',machineId:config.machineId,action:'info',payload:{}}));
      }
      if(m.type==='response')finish(m.error,m.result);
    });
  });
}
async function online(config:any) {const until=Date.now()+20000;let last:any;while(Date.now()<until){try{return await info(config);}catch(e){last=e;await new Promise(r=>setTimeout(r,300));}}throw last;}
const configPath=join(install,'.local','config.json');
let cleanup:any={status:'removed'};
try {
  await cp(resolve(artifact),install,{recursive:true});await mkdir(project);await mkdir(codexHome);
  await assert.rejects(stat(join(install,'node_modules')));
  const bind=createServer();bind.listen(0,'127.0.0.1');await once(bind,'listening');const port=(bind.address() as any).port;await new Promise<void>(r=>bind.close(()=>r()));
  await writeFile(join(codexHome,'config.toml'),'model = "portable-fixture"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "No external model calls"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\n');
  const token=randomUUID()+randomUUID();
  const output=await setup({roots:[project],relayUrl:`http://127.0.0.1:${port}`,token,mode:'all',codexBin:resolveCodex(),codexHome});
  assert.ok(!output.includes(token));
  const config=JSON.parse(await readFile(configPath,'utf8'));assert.deepEqual(config.roots,[project]);assert.equal(config.codexHome,codexHome);
  console.log('Checking packaged startup...');await ps('start.ps1',['-NoOpen']);const initial=await online(config);
  assert.equal(initial.provider,'fixture');assert.equal(initial.model,'portable-fixture');
  assert.equal((await fetch(config.relayUrl)).status,200);
  const connectorPid=Number((await readFile(join(install,'.local','connector.pid'),'utf8')).trim());
  const relayPid=Number((await readFile(join(install,'.local','relay.pid'),'utf8')).trim());
  assert.ok(connectorPid>0&&relayPid>0);
  console.log('Checking repeated launch...');await ps('start.ps1',['-NoOpen']);assert.equal(Number(await readFile(join(install,'.local','connector.pid'),'utf8')),connectorPid);
  const pidQuery=`Get-CimInstance Win32_Process -Filter 'ParentProcessId=${connectorPid}' | Where-Object {$_.Name -eq 'codex.exe'} | Select-Object -ExpandProperty ProcessId`;
  const before=(await run('powershell.exe',['-NoProfile','-Command',pidQuery],{windowsHide:true})).stdout.trim();assert.match(before,/^\d+$/);
  const stopRelay=`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${relayPid}'; if($p.CommandLine.Contains(${quote(join(install,'build','relay.mjs'))})){Stop-Process -Id ${relayPid}}else{throw 'Process owner mismatch'}`;
  await run('powershell.exe',['-NoProfile','-Command',stopRelay],{windowsHide:true});
  console.log('Checking relay reconnect...');await ps('start.ps1',['-Mode','relay','-NoOpen']);assert.equal((await online(config)).model,'portable-fixture');
  const after=(await run('powershell.exe',['-NoProfile','-Command',pidQuery],{windowsHide:true})).stdout.trim();assert.equal(after,before,'Relay restart must not replace the Codex process');
  console.log('Checking token rotation...');await ps('stop.ps1');await setup({rotate:true});
  const rotated=JSON.parse(await readFile(configPath,'utf8'));assert.notEqual(rotated.token,config.token);assert.equal(rotated.machineId,config.machineId);
  await ps('start.ps1',['-NoOpen']);await online(rotated);await assert.rejects(info(rotated,config.token),/closed 4401/);
  await ps('stop.ps1');await assert.rejects(stat(join(install,'.local','connector.pid')));
  for(const name of ['relay.log','relay.error.log','connector.log','connector.error.log']){const content=await readFile(join(install,'.local',name),'utf8');assert.ok(!content.includes(token)&&!content.includes(rotated.token));}
} finally {
  try{await ps('stop.ps1');}catch{}
  for(let i=0;i<10;i++) {
    try{await removeTestTemp(temp);break;}
    catch(e:any){if(!['EBUSY','EPERM','EACCES'].includes(e.code))throw e;if(i===9){cleanup={status:'retained',path:temp,reason:e.code};break;}await new Promise(r=>setTimeout(r,250));}
  }
}
console.log(JSON.stringify({result:'passed',checks:['bundled Node without node_modules','Chinese project and installation paths','configured Codex and provider inherited','background startup and duplicate launch','relay restart preserves native process','rotated token rejects old clients','owned processes stop','no token in logs'],cleanup,interactiveUiTest:false,liveModelTest:false}));
