import {fileAttachment,UPLOAD_CHUNK_BYTES,type FileAttachment} from '../src/shared/attachments';
import type {Json,RequestAction} from '../src/shared/types';
import type {DraftFileAttachment} from './attachments';

type Call=(action:RequestAction,payload:Json)=>Promise<any>;
export type UploadProgress={name:string;index:number;count:number;loaded:number;size:number};
export async function uploadAttachments(call:Call,threadId:string,files:DraftFileAttachment[],progress?:(value:UploadProgress)=>void):Promise<FileAttachment[]> {
  const refs=files.map(fileAttachment);
  for(const [index,draft] of files.entries()){
    const ref=refs[index],file=draft.file;
    if(!file)continue; // Withdrawn queue entries already refer to complete uploads.
    if(file.size!==ref.size||file.name!==ref.name)throw Error('文件已变化，请重新选择');
    const started=await call('file.uploadStart',{threadId,...ref});
    let offset=started.offset;
    if(started.id!==ref.id||!Number.isSafeInteger(offset)||offset<0||offset>file.size)throw Error('上传位置无效，请重试');
    progress?.({name:ref.name,index:index+1,count:files.length,loaded:offset,size:file.size});
    while(offset<file.size){
      const bytes=new Uint8Array(await file.slice(offset,offset+UPLOAD_CHUNK_BYTES).arrayBuffer());
      if(!bytes.length)throw Error('文件读取失败，请重新选择');
      let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
      const result=await call('file.uploadChunk',{threadId,id:ref.id,offset,data:btoa(binary)});
      if(result.id!==ref.id||!Number.isSafeInteger(result.offset)||result.offset<offset+bytes.length||result.offset>file.size)throw Error('文件分块未获确认，请重试');
      offset=result.offset;
      progress?.({name:ref.name,index:index+1,count:files.length,loaded:offset,size:file.size});
    }
  }
  return refs;
}
