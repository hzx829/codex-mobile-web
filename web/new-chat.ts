import type {Json,RequestAction} from '../src/shared/types';
type Call=(action:RequestAction,payload:Json)=>Promise<any>;
export async function createFirstTurn(call:Call,input:Json,onCreated:(threadId:string)=>void) {
  let stage:'create'|'send'='create',threadId:string|undefined,sent=false;
  try {
    const created=await call('session.create',{cwd:input.cwd,model:input.model||undefined,opId:input.createId});
    if(created.state!=='accepted')return {stage,result:created};
    threadId=created.threadId;stage='send';onCreated(threadId!);
    const session=await call('session.read',{threadId});
    if(!session.canControl||session.activeTurnId)return {stage,threadId,result:{state:'failed',error:{message:'会话已建立，请确认当前状态后发送。'}}};
    sent=true;
    const result=await call('turn.send',{threadId,source:session.source,generation:session.generation,expectedTurnId:null,text:input.text,images:input.images,model:input.model||undefined,effort:input.effort||undefined,opId:input.sendId});
    return {stage,threadId,result};
  }catch(e:any){
    return {stage,threadId,result:{state:(stage==='create'||sent)&&e.uncertain?'uncertain':'failed',error:{message:e.message||'连接失败，输入已保留'}}};
  }
}
