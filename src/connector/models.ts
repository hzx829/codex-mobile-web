import {BridgeError,textRequired,type Json} from '../shared/types.js';

type Runtime={rpc:(method:string,params:Json)=>Promise<any>};

export async function readModels(runtime:Runtime):Promise<Json> {
  return runtime.rpc('model/list',{});
}

export async function reasoningEffort(runtime:Runtime,value:unknown,model:string):Promise<string> {
  const effort=textRequired(value,'推理档位',100);
  const catalog=await readModels(runtime);
  const entry=catalog.data?.find((m:Json)=>m.model===model);
  if(entry&&!entry.supportedReasoningEfforts?.some((r:Json)=>r.reasoningEffort===effort))throw new BridgeError('invalid','当前模型不支持所选推理档位');
  return effort;
}
