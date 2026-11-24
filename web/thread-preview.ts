import type {PreviewSession} from './browser-preview';
import type {Json} from '../src/shared/types';

export const defaultPreviewUrl='http://127.0.0.1:5173';
export function previewUrlKey(machineId:string,threadId:string){return `browser-preview-url:${JSON.stringify([machineId,threadId])}`;}
export function previewWidthKey(machineId:string,threadId:string){return `browser-preview-width:${JSON.stringify([machineId,threadId])}`;}
/** Layout widths a page can be shown at instead of the pane's own; the app later hands the same numbers to a native web view. */
export const DESKTOP_WIDTHS=[1280,1440,1920];
/** A frame laid out `width` wide and shrunk to fill a box; null when the box is already that wide or has no size yet. */
export function desktopFrame(boxWidth:number,boxHeight:number,width:number):{width:number;height:number;scale:number}|null {
  if(!(width>0)||!(boxWidth>0)||!(boxHeight>0)||width<=boxWidth)return null;
  const scale=boxWidth/width;
  return {width,height:Math.ceil(boxHeight/scale),scale};
}
/** Whether this device gets any answer from a page. A page that forbids being read still answers; only a network failure or silence counts as no. */
export async function reachable(url:string,timeout=5000,request:typeof fetch=fetch):Promise<boolean> {
  const control=new AbortController(),timer=setTimeout(()=>control.abort(),timeout);
  try{await request(url,{mode:'no-cors',cache:'no-store',credentials:'omit',signal:control.signal});return true;}
  catch{return false;}
  finally{clearTimeout(timer);}
}
export function belongsToThread(session:PreviewSession|null,machineId:string,threadId:string){return Boolean(threadId&&session?.machineId===machineId&&session.threadId===threadId);}
type Request=(action:'preview.start'|'preview.stop',payload:Json,machineId:string)=>Promise<any>;
export async function openThreadPreview(request:Request,machineId:string,threadId:string,address:string|{filePath:string},isCurrent:()=>boolean):Promise<PreviewSession|null>{
  if(!threadId)throw Error('请先打开一个会话');
  const result=await request('preview.start',{threadId,...(typeof address==='string'?{url:address}:address)},machineId);
  const session:PreviewSession={...result,machineId};
  if(!belongsToThread(session,machineId,threadId)||!isCurrent()){
    await request('preview.stop',{sessionId:session.sessionId,threadId},machineId).catch(()=>{});
    if(result.threadId!==threadId)throw Error('网页预览的会话不匹配，请更新中继和电脑连接器。');
    return null;
  }
  return session;
}
