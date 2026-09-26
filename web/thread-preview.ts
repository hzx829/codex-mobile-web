import type {PreviewSession} from './browser-preview';
import type {Json} from '../src/shared/types';

export const defaultPreviewUrl='http://127.0.0.1:5173';
export function previewUrlKey(machineId:string,threadId:string){return `browser-preview-url:${JSON.stringify([machineId,threadId])}`;}
export function belongsToThread(session:PreviewSession|null,machineId:string,threadId:string){return Boolean(threadId&&session?.machineId===machineId&&session.threadId===threadId);}
type Request=(action:'preview.start'|'preview.stop',payload:Json,machineId:string)=>Promise<any>;
export async function openThreadPreview(request:Request,machineId:string,threadId:string,url:string,isCurrent:()=>boolean):Promise<PreviewSession|null>{
  if(!threadId)throw Error('请先打开一个会话');
  const result=await request('preview.start',{threadId,url},machineId);
  const session:PreviewSession={...result,machineId};
  if(!belongsToThread(session,machineId,threadId)||!isCurrent()){
    await request('preview.stop',{sessionId:session.sessionId,threadId},machineId).catch(()=>{});
    if(result.threadId!==threadId)throw Error('网页预览的会话不匹配，请更新中继和电脑连接器。');
    return null;
  }
  return session;
}
