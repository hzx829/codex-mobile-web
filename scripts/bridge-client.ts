import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import {BridgeError,type Json,type RequestAction} from '../src/shared/types.js';

// One authenticated request to this installation. Credentials never enter output or receipts.
export async function bridgeRequest(action:RequestAction,payload:Json={},timeoutMs=30000):Promise<Json> {
  const config=JSON.parse(await readFile('.local/config.json','utf8'));
  const url=new URL('/ws',config.relayUrl);url.protocol=url.protocol==='https:'?'wss:':'ws:';
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(url,{handshakeTimeout:8000}),id=randomUUID();let done=false;
    const finish=(error?:Error,result?:Json)=>{if(done)return;done=true;clearTimeout(timer);ws.close();error?reject(error):resolve(result!);};
    const timer=setTimeout(()=>finish(new Error('连接器检查超时')),timeoutMs);
    ws.on('open',()=>ws.send(JSON.stringify({type:'hello',role:'phone',token:config.token})));
    ws.on('error',()=>finish(new Error('中继连接失败')));
    ws.on('close',()=>finish(new Error('连接器检查连接已断开')));
    ws.on('message',raw=>{
      let m:Json;try{m=JSON.parse(raw.toString());}catch{finish(new Error('中继返回无效消息'));return;}
      if(m.type==='ready'){
        if(!m.machines?.some((machine:Json)=>machine.id===config.machineId)){finish(new Error('连接器未在线'));return;}
        ws.send(JSON.stringify({type:'request',id,machineId:config.machineId,action,payload}));
      }
      if(m.type==='response'&&m.id===id)finish(m.error?new BridgeError(m.error.code,m.error.message,m.error.uncertain):undefined,m.result);
    });
  });
}
