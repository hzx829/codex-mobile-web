import { AppServer, resolveCodex } from '../src/connector/app-server.js';
import { Desktop } from '../src/connector/desktop.js';
const runtime = new AppServer();
const desktop = new Desktop();
try {
  await runtime.start();
  const [config,models,threads] = await Promise.all([runtime.rpc('config/read',{includeLayers:false}),runtime.rpc('model/list',{}),runtime.rpc('thread/list',{limit:3})]);
  console.log(JSON.stringify({codexBin:resolveCodex(),model:config.config?.model,provider:config.config?.model_provider||'openai',modelCount:models.data?.length,threadCount:threads.data?.length,threadKeys:Object.keys(threads.data?.[0]||{})}));
  await desktop.connect();console.log('Desktop IPC initialized');
  if(process.env.PROBE_THREAD_ID) {
    const state=await desktop.follow(process.env.PROBE_THREAD_ID);
    const entities:any[]=Object.values(state.turnHistory?.history?.entitiesByKey||{});
    console.log(JSON.stringify({historyKind:state.turnHistory?.kind,entrySample:state.turnHistory?.history?.islands?.at(-1)?.entries?.at(-1),turnCount:entities.length,turnKeys:Object.keys(entities.at(-1)||{}),items:[...new Map(entities.flatMap(t=>t.items||[]).map(i=>[i.type,{type:i.type,keys:Object.keys(i)}])).values()],activeTurnStatus:entities.at(-1)?.status}));
    console.log(JSON.stringify({stateKeys:Object.keys(state),turnKeys:Object.keys(state.turns?.at(-1)||{}),items:state.turns?.at(-1)?.items?.slice(-2).map((i:any)=>({keys:Object.keys(i),type:i.type})),requestKeys:Object.keys(state.requests?.[0]||{}),primitiveTypes:Object.fromEntries(Object.entries(state).filter(([k,v])=>!['turns','requests'].includes(k)).map(([k,v])=>[k,typeof v]))}));
  }
} catch(e) {console.error((e as Error).message);process.exitCode=1;}
finally {runtime.close();desktop.close();}
