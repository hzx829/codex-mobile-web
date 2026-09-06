import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {randomUUID} from 'node:crypto';
import {createRelay} from '../src/server/relay.js';
import {Ledger} from '../src/connector/ledger.js';

function waitFrame(ws:WebSocket,predicate:(v:any)=>boolean):Promise<any>{return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{ws.off('message',listen);reject(Error('frame timeout'));},3000);
  const listen=(b:any)=>{const value=JSON.parse(b.toString());if(predicate(value)){clearTimeout(timer);ws.off('message',listen);resolve(value);}};ws.on('message',listen);
});}
test('token gate, machine routing and receipt recovery after phone disconnect',async()=>{
  const token='test-token-not-a-real-secret-123456789';const relay=createRelay(token);relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
  const port=(relay.server.address() as any).port,url=`ws://127.0.0.1:${port}/ws`,ledger=new Ledger(':memory:');let executions=0;
  async function peer(role:string,auth=token){const ws=new WebSocket(url);await once(ws,'open');const result=auth===token?waitFrame(ws,m=>m.type==='ready'):once(ws,'close');ws.send(JSON.stringify({type:'hello',role,token:auth,machineId:'pc',name:'Test PC'}));await result;return ws;}
  try{
    const bad=await peer('phone','wrong');assert.equal(bad.readyState,WebSocket.CLOSED);
    const connector=await peer('connector');
    connector.on('message',async raw=>{
      const m=JSON.parse(raw.toString());if(m.type!=='request')return;
      const result=await ledger.run(m.payload.opId,{action:m.action},async()=>{executions++;await new Promise(r=>setTimeout(r,35));return {threadId:'s',turnId:'t'};});
      connector.send(JSON.stringify({type:'response',id:m.id,result}));
    });
    const first=await peer('phone');const opId=`${Date.now()}:${randomUUID()}`;
    const request={type:'request',id:'original',machineId:'pc',action:'turn.send',payload:{opId}};
    first.send(JSON.stringify(request));await new Promise(r=>setTimeout(r,10));first.terminate();
    await new Promise(r=>setTimeout(r,60));assert.equal(connector.readyState,WebSocket.OPEN);
    const second=await peer('phone');const response=waitFrame(second,m=>m.id==='retry');second.send(JSON.stringify({...request,id:'retry'}));
    assert.equal((await response).result.state,'accepted');assert.equal(executions,1);
    const offline=waitFrame(second,m=>m.id==='no-pc');second.send(JSON.stringify({...request,id:'no-pc',machineId:'missing'}));assert.equal((await offline).error.code,'offline');
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status,200);
  }finally{await relay.close();ledger.close();}
});
