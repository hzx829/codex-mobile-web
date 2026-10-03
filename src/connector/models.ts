import {BridgeError,textRequired,type Json} from '../shared/types.js';
import {AppServer,resolveWindowsCodex} from './app-server.js';

type Runtime={bin?:string;rpc:(method:string,params:Json)=>Promise<any>};
type CatalogRuntime=Runtime&{start:()=>Promise<void>;close:()=>void};

// A pinned execution runtime can preserve old history APIs while the desktop catalog advances.
export async function readModels(runtime:Runtime,resolveBin=()=>process.platform==='win32'?resolveWindowsCodex(process.env.PATH||'',process.env.LOCALAPPDATA||''):runtime.bin,createRuntime:(bin:string)=>CatalogRuntime=bin=>new AppServer(bin)):Promise<Json> {
  const bin=runtime.bin?resolveBin():undefined;
  if(!bin||bin===runtime.bin)return runtime.rpc('model/list',{});
  const catalog=createRuntime(bin);
  try{await catalog.start();return await catalog.rpc('model/list',{});}
  finally{catalog.close();}
}

export async function reasoningEffort(runtime:Runtime,value:unknown,model:string):Promise<string> {
  const effort=textRequired(value,'推理档位',100);
  const catalog=await readModels(runtime);
  const entry=catalog.data?.find((m:Json)=>m.model===model);
  if(entry&&!entry.supportedReasoningEfforts?.some((r:Json)=>r.reasoningEffort===effort))throw new BridgeError('invalid','当前模型不支持所选推理档位');
  return effort;
}
