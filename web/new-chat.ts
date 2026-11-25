import type {Json,RequestAction} from '../src/shared/types';
import {uploadAttachments,type UploadProgress} from './file-upload';
import {operationId} from './client';
type Call=(action:RequestAction,payload:Json)=>Promise<any>;
export async function createFirstTurn(call:Call,input:Json,onCreated:(threadId:string)=>void,progress?:(value:UploadProgress)=>void,onSending?:(opId:string)=>void) {
  let stage:'create'|'send'='create',threadId:string|undefined,sent=false;
  try {
    const created=await call('session.create',{cwd:input.cwd,model:input.model||undefined,approvalPolicy:input.approvalPolicy||undefined,opId:input.createId});
    if(created.state!=='accepted')return {stage,result:created};
    threadId=created.threadId;stage='send';onCreated(threadId!);
    const session=typeof created.generation==='string'&&created.generation
      ?{source:'connector',generation:created.generation,canControl:true,activeTurnId:null}
      :await call('session.read',{threadId});
    if(!session.canControl||session.activeTurnId)return {stage,threadId,result:{state:'failed',error:{message:'会话已建立，请确认当前状态后发送。'}}};
    const files=await uploadAttachments(call,threadId!,input.files||[],progress);
    // Large uploads may outlive the operation's five-minute acceptance window.
    const sendId=input.files?.some((file:any)=>file.file)?operationId():input.sendId;onSending?.(sendId);
    sent=true;
    const result=await call('turn.send',{threadId,source:session.source,generation:session.generation,expectedTurnId:null,text:input.text,images:input.images,files,model:input.model||undefined,effort:input.effort||undefined,approvalPolicy:input.approvalPolicy||undefined,serviceTier:input.serviceTier,opId:sendId});
    return {stage,threadId,result};
  }catch(e:any){
    return {stage,threadId,result:{state:(stage==='create'||sent)&&e.uncertain?'uncertain':'failed',error:{message:e.message||'连接失败，输入已保留'}}};
  }
}
