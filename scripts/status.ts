import {resolve} from 'node:path';
import {WebSocket} from 'ws';
import {randomUUID} from 'node:crypto';
import {readConfig} from '../src/shared/config.js';
import {fetchLocalStatus, localBridgeRequest} from '../src/connector/local-control.js';

const c=readConfig();
const local=await fetchLocalStatus(resolve('.local'),4000);
if(local){
  try{
    const output:any={...local};
    if(local.services.includes('codex')){
      const [info,list]=await Promise.all([
        localBridgeRequest(resolve('.local'),'info',{},10_000).catch(()=>null),
        localBridgeRequest(resolve('.local'),'sessions.list',{},10_000).catch(()=>null),
      ]);
      if(info){output.provider=info.provider;output.model=info.model;output.desktopOnline=info.desktopOnline;}
      if(list?.data)output.visibleSessions=list.data.length;
    }
    console.log(JSON.stringify(output));
    process.exit(0);
  }catch(e:any){console.error(e.message||'连接检查失败');process.exit(1);}
}
const url=new URL('/ws',c.relayUrl);url.protocol=url.protocol==='https:'?'wss:':'ws:';
const ws=new WebSocket(url),pending=new Map<string,{resolve:(v:any)=>void;reject:(e:any)=>void}>();
const deadline=setTimeout(()=>{console.error('电脑连接检查超时');ws.terminate();process.exitCode=1;},20_000);
function rpc(action:string,payload:any={}){return new Promise<any>((resolveResult,reject)=>{const id=randomUUID();pending.set(id,{resolve:resolveResult,reject});ws.send(JSON.stringify({type:'request',id,machineId:c.machineId,action,payload}));});}
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
ws.on('close',code=>{clearTimeout(deadline);if(code===4401){console.error('Token 不匹配（或中继已启用团队模式且连接器未开启本机状态通道）');process.exitCode=1;}});
