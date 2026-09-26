import {FILE_CHUNK_SIZE, MAX_DOWNLOAD_SIZE, type FilePreview, type FileChunk} from '../src/shared/types';

export async function receiveFile(file:FilePreview,read:(offset:number)=>Promise<FileChunk>,signal:AbortSignal,progress:(bytes:number)=>void=()=>{}) {
  if(!Number.isSafeInteger(file.size)||file.size<0||file.size>MAX_DOWNLOAD_SIZE)throw new Error('下载上限为 100 MiB，请在电脑获取此文件');
  const parts:ArrayBuffer[]=[];let offset=0;
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
  // Download as a file even for HTML/SVG; never run active content as a same-origin page.
  return new Blob(parts,{type:'application/octet-stream'});
}
