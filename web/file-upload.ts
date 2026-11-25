import {fileAttachment,UPLOAD_CHUNK_BYTES,type FileAttachment} from '../src/shared/attachments';
import type {Json,RequestAction} from '../src/shared/types';
import type {DraftFileAttachment} from './attachments';
import {recordTransfer} from './trace';
import {blobSession,blobUploadTarget,putPart,resetBlobSession} from './blob';

/** Bytes per request on the data channel; the relay takes up to 8 MiB. */
const PART_BYTES=8*1024*1024;
/** Sends what is left of a file through the data channel; returns where it got to, or null to go on in chunks. */
async function streamParts(call:Call,prefix:string,scope:Json,ref:FileAttachment,file:File,offset:number,report:(loaded:number)=>void):Promise<number|null>{
  const target=blobUploadTarget();
  if(!target||!await blobSession(target.token))return null;
  let retries=0;
  while(offset<file.size){
    const part=file.slice(offset,Math.min(file.size,offset+PART_BYTES)),start=offset;
    const query=new URLSearchParams({action:`${prefix}file.uploadChunk`,id:ref.id,offset:String(start)});
    for(const [key,value] of Object.entries(scope))if(typeof value==='string')query.set(key,value);
    const answer=await putPart(`/blob/${encodeURIComponent(target.machine)}/upload?${query}`,part,sent=>report(start+sent));
    if(answer.status===200&&answer.result&&answer.result.id===ref.id&&Number.isSafeInteger(answer.result.offset)&&answer.result.offset===start+part.size){offset=answer.result.offset;retries=0;continue;}
    // Signed out (the relay restarted) or a relay without uploads: the rest goes in chunks.
    if(answer.status===401||answer.status===404||answer.status===413){if(answer.status===401)resetBlobSession();return offset;}
    if(answer.status>=400&&answer.status<500&&answer.status!==409)throw Error(answer.error?.message||'上传失败，请重试');
    // Interrupted, or the computer kept only part of it: ask where the file ends and go on from there.
    if(++retries>3)throw Error(answer.error?.message||'上传多次中断，请检查网络后重试');
    const started=await call(`${prefix}file.uploadStart` as RequestAction,{...scope,...ref});
    if(started.id!==ref.id||!Number.isSafeInteger(started.offset)||started.offset<0||started.offset>file.size)throw Error('上传位置无效，请重试');
    offset=started.offset;report(offset);
  }
  return offset;
}

type Call=(action:RequestAction,payload:Json)=>Promise<any>;
export type UploadProgress={name:string;index:number;count:number;loaded:number;size:number};
/** Where files go: Codex's `file.*` with a thread, or `claude.file.*` / `antigravity.file.*` with their conversation (or new project) fields. */
export type UploadTarget={prefix:''|'claude.'|'antigravity.';scope:Json};
export async function uploadAttachments(call:Call,target:string|UploadTarget,files:DraftFileAttachment[],progress?:(value:UploadProgress)=>void):Promise<FileAttachment[]> {
  const {prefix,scope}=typeof target==='string'?{prefix:'',scope:{threadId:target}}:target;
  const refs=files.map(fileAttachment);
  for(const [index,draft] of files.entries()){
    const ref=refs[index],file=draft.file;
    if(!file)continue; // Withdrawn queue entries already refer to complete uploads.
    if(file.size!==ref.size||file.name!==ref.name)throw Error('文件已变化，请重新选择');
    const startedAt=performance.now();
    const started=await call(`${prefix}file.uploadStart` as RequestAction,{...scope,...ref});
    let offset=started.offset;const resumedAt=offset;
    if(started.id!==ref.id||!Number.isSafeInteger(offset)||offset<0||offset>file.size)throw Error('上传位置无效，请重试');
    progress?.({name:ref.name,index:index+1,count:files.length,loaded:offset,size:file.size});
    // Through the data channel when it is there: whole parts, no base64, the browser's own upload progress.
    const streamed=await streamParts(call,prefix,scope,ref,file,offset,loaded=>progress?.({name:ref.name,index:index+1,count:files.length,loaded,size:file.size}));
    if(streamed!==null)offset=streamed;
    while(offset<file.size){
      const bytes=new Uint8Array(await file.slice(offset,offset+UPLOAD_CHUNK_BYTES).arrayBuffer());
      if(!bytes.length)throw Error('文件读取失败，请重新选择');
      let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
      const result=await call(`${prefix}file.uploadChunk` as RequestAction,{...scope,id:ref.id,offset,data:btoa(binary)});
      if(result.id!==ref.id||!Number.isSafeInteger(result.offset)||result.offset<offset+bytes.length||result.offset>file.size)throw Error('文件分块未获确认，请重试');
      offset=result.offset;
      progress?.({name:ref.name,index:index+1,count:files.length,loaded:offset,size:file.size});
    }
    if(file.size>resumedAt)recordTransfer('upload',file.size-resumedAt,performance.now()-startedAt);
  }
  return refs;
}
