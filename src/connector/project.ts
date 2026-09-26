import { realpath, stat, open } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { resolve, isAbsolute, extname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { BridgeError, FILE_CHUNK_SIZE, MAX_DOWNLOAD_SIZE, type FilePreview, type FileChunk } from '../shared/types.js';

export async function projectDirectory(path:string) {
  if(!isAbsolute(path))throw new BridgeError('invalid','请使用电脑上的完整项目路径');
  const canonical=await realpath(path);
  if(!(await stat(canonical)).isDirectory())throw new BridgeError('invalid','项目目录无效');
  return canonical;
}
function revision(target:string,info:BigIntStats) {
  return createHash('sha256').update([target,info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join('\0')).digest('hex');
}
function fileError(error:unknown):never {
  const code=(error as NodeJS.ErrnoException).code;
  if(code==='ENOENT'||code==='ENOTDIR')throw new BridgeError('not_found','文件已移动或删除，请确认电脑上的文件路径');
  if(code==='EACCES'||code==='EPERM')throw new BridgeError('forbidden','连接器没有权限读取此文件');
  throw error;
}
async function openProjectFile(cwd:string,path:string) {
  try {
    if(!isAbsolute(path)&&!isAbsolute(cwd))throw new BridgeError('invalid','该会话没有工作目录，请填写电脑上的完整文件路径');
    const target=await realpath(isAbsolute(path)?path:resolve(cwd,path));
    if(!(await stat(target)).isFile())throw new BridgeError('invalid','请选择文件');
    const handle=await open(target,'r');
    try {
      const info=await handle.stat({bigint:true});
      if(!info.isFile())throw new BridgeError('invalid','请选择文件');
      return {handle,target,info};
    }catch(error){await handle.close();throw error;}
  }catch(error){fileError(error);}
}
async function readBytes(handle:Awaited<ReturnType<typeof open>>,offset:number,length:number) {
  const data=Buffer.alloc(length);let read=0;
  while(read<length){const {bytesRead}=await handle.read(data,read,length-read,offset+read);if(!bytesRead)break;read+=bytesRead;}
  return data.subarray(0,read);
}
const changed=()=>new BridgeError('changed','文件已变化，请重新打开文件后下载');

export async function readProjectFile(cwd:string,path:string):Promise<FilePreview> {
  const {handle,target,info}=await openProjectFile(cwd,path);
  try {
    const file:FilePreview={path:target,name:basename(path),size:Number(info.size),revision:revision(target,info),mime:'application/octet-stream'};
    if(file.size>2*1024*1024)return {...file,notice:'文件超过 2 MiB 预览上限。'};
    const data=await readBytes(handle,0,file.size);
    if(data.length!==file.size||revision(target,await handle.stat({bigint:true}))!==file.revision)throw changed();
    const mime:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'};
    if(mime[extname(target).toLowerCase()])return {...file,mime:mime[extname(target).toLowerCase()],data:data.toString('base64')};
    const binary={...file,notice:'此类文件不支持预览，可下载后打开。'};
    if(data.includes(0)||/\.(pdf|pptx?|docx?|xlsx?|zip)$/i.test(target))return binary;
    try{return {...file,mime:'text/plain',text:new TextDecoder('utf-8',{fatal:true}).decode(data)};}catch{return binary;}
  }catch(error){fileError(error);}finally{await handle.close();}
}

export async function downloadProjectFile(cwd:string,path:string,expectedRevision:string,offset:number):Promise<FileChunk> {
  if(!Number.isSafeInteger(offset)||offset<0)throw new BridgeError('invalid','文件读取位置无效');
  const {handle,target,info}=await openProjectFile(cwd,path);
  try {
    if(info.size>BigInt(MAX_DOWNLOAD_SIZE))throw new BridgeError('too_large','下载上限为 100 MiB，请在电脑获取此文件');
    if(revision(target,info)!==expectedRevision)throw changed();
    const size=Number(info.size);
    if(offset>size)throw new BridgeError('invalid','文件读取位置无效');
    const length=Math.min(FILE_CHUNK_SIZE,size-offset),data=await readBytes(handle,offset,length);
    if(data.length!==length||revision(target,await handle.stat({bigint:true}))!==expectedRevision)throw changed();
    return {offset,data:data.toString('base64')};
  }catch(error){fileError(error);}finally{await handle.close();}
}
