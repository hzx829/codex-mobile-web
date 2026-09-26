import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {removeTestTemp} from '../scripts/test-temp.js';
// @ts-expect-error This helper is also distributed as a standalone Node script in the skill.
import {checkConnection} from '../skills/codex-mobile-web-setup/scripts/status.mjs';

test('skill status authenticates, waits for its own connector and only reads info',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cmw-skill-status-'));
  const server=new WebSocketServer({port:0,host:'127.0.0.1'});await once(server,'listening');
  const port=(server.address() as {port:number}).port,token='status-test-token-with-enough-characters',requests:any[]=[];
  try {
    await mkdir(join(dir,'.local'));
    await writeFile(join(dir,'.local','config.json'),JSON.stringify({relayUrl:`http://127.0.0.1:${port}`,token,machineId:'new-pc',machineName:'Second PC'}));
    server.on('connection',ws=>ws.on('message',raw=>{
      const m=JSON.parse(raw.toString());requests.push(m);
      if(m.type==='hello') {
        assert.equal(m.token,token);
        ws.send(JSON.stringify({type:'ready',machines:[{id:'other-pc'}]}));
        ws.send(JSON.stringify({type:'machines',data:[{id:'other-pc'},{id:'new-pc'}]}));
        ws.send(JSON.stringify({type:'machines',data:[{id:'new-pc'}]}));
      } else ws.send(JSON.stringify({type:'response',id:m.id,result:{model:'fixture',provider:'fixture',projects:[{path:'private-path'}],desktopOnline:false}}));
    }));
    const result=await checkConnection(dir,1000);
    assert.equal(result.online,true);assert.equal(result.desktopOnline,false);assert.equal(result.projectCount,1);
    assert.deepEqual(requests.map(m=>m.type),['hello','request']);
    assert.deepEqual(requests[1],{type:'request',id:'setup-info',machineId:'new-pc',action:'info',payload:{}});
    assert.ok(!JSON.stringify(result).includes(token));assert.ok(!JSON.stringify(result).includes('private-path'));
  } finally {for(const client of server.clients)client.terminate();await new Promise<void>(r=>server.close(()=>r()));await removeTestTemp(dir);}
});

test('skill status distinguishes rejected Tokens and missing connectors',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cmw-skill-status-'));
  const server=new WebSocketServer({port:0,host:'127.0.0.1'});await once(server,'listening');
  const port=(server.address() as {port:number}).port;let rejectToken=true;
  try {
    await mkdir(join(dir,'.local'));
    await writeFile(join(dir,'.local','config.json'),JSON.stringify({relayUrl:`http://127.0.0.1:${port}`,token:'status-test-token-with-enough-characters',machineId:'new-pc'}));
    server.on('connection',ws=>ws.on('message',()=>{
      if(rejectToken)ws.close(4401,'invalid_token');else ws.send(JSON.stringify({type:'ready',machines:[{id:'other-pc'}]}));
    }));
    await assert.rejects(checkConnection(dir,1000),/token_rejected/);
    rejectToken=false;
    await assert.rejects(checkConnection(dir,100),/connector_offline/);
  } finally {for(const client of server.clients)client.terminate();await new Promise<void>(r=>server.close(()=>r()));await removeTestTemp(dir);}
});
