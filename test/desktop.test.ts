import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Desktop} from '../src/connector/desktop.js';

test('desktop framing handles fragmented snapshots and rejects patch gaps',async()=>{
  const path=process.platform==='win32'?`\\\\.\\pipe\\cmw-${randomUUID()}`:join(tmpdir(),`cmw-${randomUUID()}.sock`);
  let remote:net.Socket|undefined,buffer=Buffer.alloc(0);const requests:any[]=[];
  function send(m:any,split=false){const data=Buffer.from(JSON.stringify(m)),head=Buffer.alloc(4);head.writeUInt32LE(data.length);const frame=Buffer.concat([head,data]);if(split){remote!.write(frame.subarray(0,2));remote!.write(frame.subarray(2,10));remote!.write(frame.subarray(10));}else remote!.write(frame);}
  const server=net.createServer(socket=>{remote=socket;socket.on('data',chunk=>{
    buffer=Buffer.concat([buffer,Buffer.from(chunk)]);
    while(buffer.length>=4&&buffer.length>=4+buffer.readUInt32LE(0)){
      const size=buffer.readUInt32LE(0),m=JSON.parse(buffer.subarray(4,4+size).toString());buffer=buffer.subarray(4+size);requests.push(m);
      if(m.type==='request'){
        if(m.method==='thread-follower-load-complete-history')send({type:'broadcast',sourceClientId:'owner',method:'thread-stream-state-changed',params:{conversationId:'s',hostId:'local',change:{type:'snapshot',revision:1,conversationState:{id:'s',turns:[],title:'fixture'}}}},true);
        send({type:'response',requestId:m.requestId,resultType:'success',result:m.method==='initialize'?{clientId:'reader'}:{}});
      }
    }
  });});
  server.listen(path);await once(server,'listening');const original=process.env.CODEX_IPC_PATH;process.env.CODEX_IPC_PATH=path;const desktop=new Desktop();
  try{
    const state=await desktop.follow('s');assert.equal(state.title,'fixture');assert.equal(desktop.clientId,'reader');
    const changed=once(desktop,'change');send({type:'broadcast',sourceClientId:'owner',method:'thread-stream-state-changed',params:{conversationId:'s',hostId:'local',change:{type:'patches',baseRevision:1,revision:2,patches:[{op:'replace',path:['title'],value:'updated'}]}}});await changed;assert.equal(desktop.states.get('s')?.state.title,'updated');
    const gap=once(desktop,'resync');send({type:'broadcast',sourceClientId:'owner',method:'thread-stream-state-changed',params:{conversationId:'s',change:{type:'patches',baseRevision:0,revision:3,patches:[]}}});await gap;assert.equal(desktop.states.has('s'),false);
    await desktop.request('thread-follower-interrupt-turn',{});assert.equal(requests.at(-1).version,4);
    await desktop.request('thread-follower-start-turn',{});assert.equal(requests.at(-1).version,2);
  }finally{desktop.close();remote?.destroy();await new Promise<void>(r=>server.close(()=>r()));if(original===undefined)delete process.env.CODEX_IPC_PATH;else process.env.CODEX_IPC_PATH=original;}
});
