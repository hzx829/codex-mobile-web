import {FILE_CHUNK_SIZE, MAX_DOWNLOAD_SIZE, type FilePreview, type FileChunk} from '../src/shared/types';
import {recordTransfer} from './trace';

export async function receiveFile(file:FilePreview,read:(offset:number)=>Promise<FileChunk>,signal:AbortSignal,progress:(bytes:number)=>void=()=>{}) {
  if(!Number.isSafeInteger(file.size)||file.size<0||file.size>MAX_DOWNLOAD_SIZE)throw new Error('下载上限为 100 MiB，请在电脑获取此文件');
  const parts:ArrayBuffer[]=[];let offset=0;const started=performance.now();
  do {
    signal.throwIfAborted();
    let cancel=()=>{};
    const chunk=await Promise.race([
      read(offset),
      new Promise<never>((_,reject)=>{cancel=()=>reject(signal.reason);signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();}),
    ]).finally(()=>signal.removeEventListener('abort',cancel));
    signal.throwIfAborted();
    const expected=Math.min(FILE_CHUNK_SIZE,file.size-offset);
    if(chunk.offset!==offset||typeof chunk.data!=='string'||chunk.data.length!==Math.ceil(expected/3)*4)throw new Error('文件数据不完整，请重新下载');
    const decoded=atob(chunk.data),bytes=new Uint8Array(decoded.length);
    if(bytes.length!==expected)throw new Error('文件数据不完整，请重新下载');
    for(let i=0;i<bytes.length;i++)bytes[i]=decoded.charCodeAt(i);
    parts.push(bytes.buffer);offset+=bytes.length;progress(offset);
  }while(offset<file.size);
  signal.throwIfAborted();
  if(file.size)recordTransfer('download',file.size,performance.now()-started);
  // Download as a file even for HTML/SVG; never run active content as a same-origin page.
  return new Blob(parts,{type:'application/octet-stream'});
}

/** Receives a file from the relay's data channel (web/blob.ts). A 401 has `code: 'blob_auth'`: sign in again and retry. */
export async function receiveStream(url:string,size:number,signal:AbortSignal,progress:(bytes:number)=>void=()=>{}):Promise<Blob> {
  const started=performance.now();
  const response=await fetch(url,{credentials:'same-origin',signal});
  if(response.status===401)throw Object.assign(new Error('需要重新登录下载通道'),{code:'blob_auth'});
  if(!response.ok)throw new Error((await response.text().catch(()=>''))||'下载失败，请重试');
  const reader=response.body!.getReader(),parts:Uint8Array<ArrayBuffer>[]=[];let received=0;
  for(;;){const {done,value}=await reader.read();if(done)break;parts.push(value as Uint8Array<ArrayBuffer>);received+=value.length;progress(received);}
  if(received!==size)throw new Error('文件数据不完整，请重新下载');
  recordTransfer('download',received,performance.now()-started);
  // As above: a file, never this site's page.
  return new Blob(parts,{type:'application/octet-stream'});
}
