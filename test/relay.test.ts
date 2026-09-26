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

test('browser preview frames and input stay with the phone that opened it',async()=>{
  const token='preview-test-token-123456789';const relay=createRelay(token);relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
  const url=`ws://127.0.0.1:${(relay.server.address() as any).port}/ws`;
  async function peer(role:'phone'|'connector'){
    const ws=new WebSocket(url);await once(ws,'open');const ready=waitFrame(ws,m=>m.type==='ready');
    ws.send(JSON.stringify({type:'hello',role,token,machineId:'pc',name:'Test PC'}));await ready;return ws;
  }
  try{
    const connector=await peer('connector'),owner=await peer('phone'),other=await peer('phone');
    const request=waitFrame(connector,m=>m.type==='request'&&m.action==='preview.start');
    owner.send(JSON.stringify({type:'request',id:'open',machineId:'pc',action:'preview.start',payload:{url:'http://127.0.0.1:5173'}}));
    const started=await request,response=waitFrame(owner,m=>m.type==='response'&&m.id==='open');
    connector.send(JSON.stringify({type:'response',id:started.id,result:{sessionId:'session-1',width:390,height:700}}));
    assert.equal((await response).result.sessionId,'session-1');
    const leaked:any[]=[];other.on('message',raw=>leaked.push(JSON.parse(raw.toString())));
    const frame=waitFrame(owner,m=>m.type==='preview.frame');
    connector.send(JSON.stringify({type:'preview.frame',sessionId:'session-1',data:'YWJj',width:390,height:700}));
    assert.equal((await frame).data,'YWJj');
    other.send(JSON.stringify({type:'preview.input',sessionId:'session-1',input:{type:'reload'}}));
    const input=waitFrame(connector,m=>m.type==='preview.input');
    owner.send(JSON.stringify({type:'preview.input',sessionId:'session-1',input:{type:'touchStart',x:1,y:2}}));
    assert.equal((await input).input.type,'touchStart');
    assert.equal(leaked.some(m=>m.type==='preview.frame'),false);
    const stop=waitFrame(connector,m=>m.type==='preview.stop');owner.close();assert.equal((await stop).sessionId,'session-1');
    const opening=waitFrame(connector,m=>m.type==='request'&&m.action==='preview.start');
    other.send(JSON.stringify({type:'request',id:'unfinished',machineId:'pc',action:'preview.start',payload:{url:'http://localhost:3000'}}));await opening;
    const cancel=waitFrame(connector,m=>m.type==='preview.stop'&&!m.sessionId);other.close();await cancel;
    connector.close();
  }finally{await relay.close();}
});
