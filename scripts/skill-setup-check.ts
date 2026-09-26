// Isolated script/protocol verification. No mobile UI or live model task is exercised.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,open,cp,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createRelay} from '../src/server/relay.js';
import {resolveCodex} from '../src/connector/app-server.js';
import {removeTestTemp} from './test-temp.js';

if(process.platform!=='win32'||!process.argv[2])throw Error('Usage: npm run test:skill-setup -- <fresh portable directory>');
const source=resolve(process.argv[2]);
assert.ok(!(await stat(join(source,'.local')).catch(()=>null)),'Use a fresh portable directory without local settings');
const temp=await mkdtemp(join(tmpdir(),'cmw-skill-check-')),install=join(temp,'安装 directory'),codexHome=join(temp,'codex-home');
const token=randomUUID()+randomUUID(),tokenFile=join(temp,'token.txt'),helper=resolve('skills/codex-mobile-web-setup/scripts/install.ps1');
const relay=createRelay(token,undefined,0);
const env={...process.env,CODEX_PROFILE:'',CODEX_IPC_PATH:`\\\\.\\pipe\\cmw-test-${randomUUID()}`};
for(const key of ['BRIDGE_CONFIG','BRIDGE_TOKEN','BRIDGE_DATA','PORT','HOST','RELAY_URL','CODEX_BIN','CODEX_HOME'])delete (env as NodeJS.ProcessEnv)[key];
let next=0;
async function run(file:string,args:string[]=[]) {
  const log=join(temp,`script-${next++}.log`),handle=await open(log,'w');
  try {
    const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',file,...args],{env,windowsHide:true,stdio:['ignore',handle.fd,handle.fd]});
    const code=await new Promise<number|null>((done,reject)=>{
      const timer=setTimeout(()=>{child.kill();reject(Error('Script timeout'));},45000);
      child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('exit',code=>{clearTimeout(timer);done(code);});
    });
    const output=await readFile(log,'utf8');assert.ok(!output.includes(token),'A script printed the Token');
    return {code,output};
  } finally {await handle.close();}
}
try {
  await cp(source,install,{recursive:true});await mkdir(codexHome);await writeFile(tokenFile,token);
  await writeFile(join(codexHome,'config.toml'),'model = "skill-fixture"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "No model calls"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\n');
  relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
  const relayUrl=`http://127.0.0.1:${(relay.server.address() as any).port}`;
  const first=await run(helper,['-InstallDir',install,'-RelayUrl',relayUrl,'-TokenFile',tokenFile,'-CodexBin',resolveCodex(),'-CodexHome',codexHome]);
  assert.equal(first.code,0,first.output);assert.match(first.output,/"online":true/);assert.match(first.output,/"model":"skill-fixture"/);
  const configPath=join(install,'.local','config.json'),original=await readFile(configPath,'utf8'),config=JSON.parse(original);
  assert.equal(config.mode,'connector');assert.equal(config.token,token);assert.equal(config.codexHome,codexHome);assert.ok(config.machineId);
  assert.ok(!(await stat(join(install,'.local','relay.pid')).catch(()=>null)),'Only the connector should start');
  const pidPath=join(install,'.local','connector.pid'),pid=await readFile(pidPath,'utf8');
  const again=await run(helper,['-InstallDir',install]);assert.equal(again.code,0,again.output);
  assert.equal(await readFile(configPath,'utf8'),original);assert.equal(await readFile(pidPath,'utf8'),pid);
  const conflict=await run(helper,['-InstallDir',install,'-RelayUrl','https://other.example']);assert.notEqual(conflict.code,0);
  assert.equal(await readFile(configPath,'utf8'),original);assert.equal(await readFile(pidPath,'utf8'),pid);
  for(const name of ['connector.log','connector.error.log'])assert.ok(!(await readFile(join(install,'.local',name),'utf8')).includes(token));
  console.log('Passed: Token file to stdin, fresh identity, connector-only startup, read-only status, repeat preserves PID/config, conflicting settings refused, no Token in logs.');
} finally {
  await run(join(install,'scripts','windows','stop.ps1')).catch(()=>{});
  await relay.close();
  await removeTestTemp(temp);
}
