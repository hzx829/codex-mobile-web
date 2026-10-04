import {BridgeError,type Json} from '../shared/types.js';

type Runtime={rpc:(method:string,params:Json)=>Promise<any>;legacyRuntime?:()=>LegacyRuntime|undefined};
type LegacyRuntime=Runtime&{start:()=>Promise<void>;close:()=>void};

export async function revertThread(runtime:Runtime,raw:Json,turnId:string,numTurns:number):Promise<void> {
  const threadId=raw.id;
  if(raw.historyMode==='paginated') {
    await runtime.rpc('thread/revert',{threadId,beforeTurnId:turnId});return;
  }
  try {await runtime.rpc('thread/rollback',{threadId,numTurns});return;}
  catch(error) {
    // Only a rejected method is safe to fall back from; an unconfirmed rollback must never be repeated.
    if(!(error instanceof BridgeError)||error.code!=='runtime_error'||!/unknown variant [`'"]thread\/rollback[`'"]|unknown method.*thread\/rollback|method not found/i.test(error.message))throw error;
  }
  const legacy=runtime.legacyRuntime?.();
  if(!legacy)throw new BridgeError('unsupported','旧会话编辑需要配置 legacyCodexBin；新版执行端已移除 thread/rollback');
  let released=false,attempted=false;
  const current=await runtime.rpc('thread/resume',{threadId});
  const resume:Json={threadId,model:current.model,modelProvider:current.modelProvider,approvalPolicy:current.approvalPolicy};
  const effort=current.reasoningEffort??current.thread?.reasoningEffort;
  if(effort)resume.config={model_reasoning_effort:effort};
  try {
    await legacy.start();
    await runtime.rpc('thread/unsubscribe',{threadId});released=true;
    await legacy.rpc('thread/resume',{threadId});
    attempted=true;
    await legacy.rpc('thread/rollback',{threadId,numTurns});
    await legacy.rpc('thread/unsubscribe',{threadId});
    await runtime.rpc('thread/resume',resume);released=false;
  } catch(error) {
    legacy.close();
    if(released)await runtime.rpc('thread/resume',resume).catch(()=>{});
    if(attempted)throw new BridgeError('partial','旧会话回退或重新接入未获确认，请刷新会话核实后再发送。',true);
    throw error;
  } finally {legacy.close();}
}
