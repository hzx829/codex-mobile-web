import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {removeTestTemp} from './test-temp.js';

const candidates=(await readdir('release')).filter(n=>/^codex-mobile-relay-.*\.tar\.gz$/.test(n)).sort();
const archive=resolve(process.argv[2]||join('release',candidates.at(-1)||'missing'));
const expected=(await readFile(archive+'.sha256','utf8')).split(/\s/)[0];
assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'),expected);
const temp=await mkdtemp(join(tmpdir(),'cmw-relay-package-')),peers:WebSocket[]=[];
let child:ReturnType<typeof spawn>|undefined,logs='';
const token=randomBytes(32).toString('hex');
function frame(ws:WebSocket,predicate:(value:any)=>boolean):Promise<any>{return new Promise((ok,no)=>{
  const timer=setTimeout(()=>{ws.off('message',listen);no(Error('WebSocket frame timeout'));},5000);
  const listen=(bytes:any)=>{const value=JSON.parse(bytes.toString());if(predicate(value)){clearTimeout(timer);ws.off('message',listen);ok(value);}};
  ws.on('message',listen);
});}
try {
  execFileSync('tar',['-xzf',archive,'-C',temp],{windowsHide:true});
  const roots=await readdir(temp);assert.equal(roots.length,1);const target=join(temp,roots[0]);
  for(const line of (await readFile(join(target,'SHA256SUMS'),'utf8')).trim().split('\n')){
    const [hash,relative]=line.split('  '),file=resolve(target,relative);assert.ok(file.startsWith(target+sep));
    assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),hash,relative);
  }
  async function inventory(dir:string):Promise<string[]> {const found:string[]=[];for(const e of await readdir(dir,{withFileTypes:true})){
    assert.ok(!['.local','.env','.git','.research','node_modules','connector.mjs','setup.mjs'].includes(e.name),`Unwanted package entry: ${e.name}`);
    found.push(e.name);if(e.isDirectory())found.push(...await inventory(join(dir,e.name)));
  }return found;}
  const before=await inventory(target);
  const reservation=createServer().listen(0,'127.0.0.1');await once(reservation,'listening');const port=(reservation.address() as any).port;await new Promise<void>(r=>reservation.close(()=>r()));
  const env={...process.env,BRIDGE_TOKEN:token,HOST:'127.0.0.1',PORT:String(port)};
  // No source node_modules, local config, Codex, or native model process in this directory.
  child=spawn(process.execPath,[join(target,'build/relay.mjs')],{cwd:target,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout!.on('data',b=>logs+=b);child.stderr!.on('data',b=>logs+=b);
  let ready=false;
  for(let n=0;n<50;n++){
    if(child.exitCode!==null)throw Error('Packaged relay exited before listening');
    try{ready=(await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(300)})).ok;}catch{}
    if(ready)break;await delay(100);
  }
  assert.ok(ready,'Packaged relay did not become healthy');
  const html=await fetch(`http://127.0.0.1:${port}/`).then(r=>r.text());assert.ok(html.includes('id="root"'));
  const asset=html.match(/src="([^"]+\.js)"/)?.[1];assert.ok(asset);assert.equal((await fetch(`http://127.0.0.1:${port}${asset}`)).status,200);
  async function peer(role:string,auth=token){const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`,{handshakeTimeout:5000});peers.push(ws);await once(ws,'open');
    const result=auth===token?frame(ws,m=>m.type==='ready'):once(ws,'close');ws.send(JSON.stringify({type:'hello',role,token:auth,machineId:'package-test',name:'Package test'}));return {ws,result:await result};}
  assert.equal((await peer('phone','wrong-token')).result[0],4401);
  const {ws:connector}=await peer('connector'),{ws:phone,result:hello}=await peer('phone');assert.equal(hello.machines.length,1);
  const incoming=frame(connector,m=>m.type==='request');phone.send(JSON.stringify({type:'request',id:'check',machineId:'package-test',action:'sessions.list',payload:{}}));
  const request=await incoming,response=frame(phone,m=>m.type==='response'&&m.id==='check');
  connector.send(JSON.stringify({type:'response',id:request.id,result:{data:[{id:'test',title:'package-only-fixture'}]}}));
  assert.equal((await response).result.data[0].id,'test');
  assert.deepEqual(await inventory(target),before);assert.ok(!logs.includes(token)&&!logs.includes('package-only-fixture'));
  console.log(JSON.stringify({archive,checksums:'passed',standaloneBundle:'passed',httpAndAssets:'passed',webSocketAuthAndRouting:'passed',noBusinessFilesWritten:true,containerAndPublicHttps:'not tested'}));
} finally {
  for(const ws of peers)ws.terminate();
  if(child&&child.exitCode===null){const stopped=once(child,'exit');child.kill();await stopped;}
  await removeTestTemp(temp);
}
