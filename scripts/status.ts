import {WebSocket} from 'ws';
import {randomUUID} from 'node:crypto';
import {readConfig} from '../src/shared/config.js';
const c=readConfig(),url=new URL('/ws',c.relayUrl);url.protocol=url.protocol==='https:'?'wss:':'ws:';
const ws=new WebSocket(url),pending=new Map<string,{resolve:(v:any)=>void;reject:(e:any)=>void}>();
const deadline=setTimeout(()=>{console.error('电脑连接检查超时');ws.terminate();process.exitCode=1;},20_000);
function rpc(action:string,payload:any={}){return new Promise<any>((resolve,reject)=>{const id=randomUUID();pending.set(id,{resolve,reject});ws.send(JSON.stringify({type:'request',id,machineId:c.machineId,action,payload}));});}
ws.on('open',()=>ws.send(JSON.stringify({type:'hello',role:'phone',token:c.token})));
ws.on('message',async b=>{
  const m=JSON.parse(b.toString());
  if(m.type==='response'){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p?.reject(m.error);else p?.resolve(m.result);return;}
  if(m.type!=='ready')return;
  try{
    if(!m.machines.some((machine:any)=>machine.id===c.machineId))throw new Error('连接器尚未上线');
    const [info,list]=await Promise.all([rpc('info'),rpc('sessions.list')]);
    const output:any={relay:'ok',connector:'online',provider:info.provider,model:info.model,desktopOnline:info.desktopOnline,visibleSessions:list.data.length};
    if(process.env.PROBE_SEARCH){const found=await rpc('sessions.list',{search:process.env.PROBE_SEARCH});output.searchMatches=found.data.length;}
    if(process.argv[2]){const session=await rpc('session.read',{threadId:process.argv[2],limit:5});output.session={source:session.source,turnCount:session.turns.length,active:Boolean(session.activeTurnId),canControl:session.canControl,itemCount:session.turns.flatMap((t:any)=>t.items).length};}
    console.log(JSON.stringify(output));
  }catch(e:any){console.error(e.message||'连接检查失败');process.exitCode=1;}
  finally{clearTimeout(deadline);ws.close();}
});
ws.on('error',()=>{console.error('中继无法连接');clearTimeout(deadline);process.exitCode=1;});
ws.on('close',code=>{clearTimeout(deadline);if(code===4401){console.error('Token 不匹配');process.exitCode=1;}});
