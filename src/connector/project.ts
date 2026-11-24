import { lstat, mkdir, open, readdir, realpath, stat } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { resolve, isAbsolute, extname, basename, dirname, join, relative, sep, toNamespacedPath } from 'node:path';
import { createHash } from 'node:crypto';
import { BridgeError, FILE_CHUNK_SIZE, MAX_DOWNLOAD_SIZE, type FilePreview, type FileChunk } from '../shared/types.js';

let workspace: string | undefined;
export const guestWorkspace = () => workspace;
export async function setWorkspace(root?: string) {workspace = root ? await realpath(root) : undefined;}

export function assertInsideWorkspace(path: string, root = workspace) {
  if (!root) return;
  const offset = relative(toNamespacedPath(root), toNamespacedPath(path));
  if (offset === '..' || offset.startsWith('..' + sep) || isAbsolute(offset))
    throw new BridgeError('forbidden', '借用电脑只能使用访客工作区里的项目');
}

/** Check existing links as well as the parent of a file that hasn't been created yet. */
export async function checkProjectPath(path: string, root = workspace): Promise<void> {
  if (!root) return;
  assertInsideWorkspace(path, root);
  if (path === root) {
    assertInsideWorkspace(await realpath(path), root);
    return;
  }
  try {assertInsideWorkspace(await realpath(path), root);}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const entry = await lstat(path).catch(e => {if (e.code !== 'ENOENT') throw e;});
    if (entry) throw new BridgeError('forbidden', '项目链接已失效，请在电脑上修正路径');
    await checkProjectPath(dirname(path), root);
  }
}

export async function projectDirectory(path:string) {
  if(!isAbsolute(path))throw new BridgeError('invalid','请使用电脑上的完整项目路径');
  assertInsideWorkspace(path);
  const canonical=await realpath(path);
  assertInsideWorkspace(canonical);
  if(!(await stat(canonical)).isDirectory())throw new BridgeError('invalid','项目目录无效');
  return canonical;
}

export async function workspaceProjects(sessionPaths: string[] = []) {
  const root = workspace;
  if (!root) return [];
  const folders = await readdir(root, {withFileTypes: true});
  const paths = [...folders.filter(folder => folder.isDirectory()).map(folder => join(root, folder.name)), ...sessionPaths];
  const checked = await Promise.all(paths.map(path => projectDirectory(path).catch(() => undefined)));
  return [...new Set(checked.filter((path): path is string => Boolean(path)))].map(path => ({path, name: basename(path)}));
}

export async function createGuestProject(value: unknown) {
  if (!workspace) throw new BridgeError('unsupported', '此操作仅在借用电脑时可用');
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 80 || /[\\/:*?"<>|\x00-\x1f]|\.$/.test(name) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$) *(?:\.|$)/i.test(name))
    throw new BridgeError('invalid', '请输入有效的项目文件夹名称');
  const path = join(workspace, name);
  await checkProjectPath(path);
  await mkdir(path).catch(error => {if (error.code !== 'EEXIST') throw error;});
  return {path: await projectDirectory(path)};
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
    const requested=isAbsolute(path)?path:resolve(cwd,path);
    assertInsideWorkspace(requested);
    const target=await realpath(requested);
    assertInsideWorkspace(target);
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
    const video:Record<string,string>={'.mp4':'video/mp4','.m4v':'video/mp4','.webm':'video/webm','.ogv':'video/ogg','.mov':'video/quicktime'};
    const videoMime=video[extname(target).toLowerCase()];
    if(videoMime)return {...file,mime:videoMime};
    if(extname(target).toLowerCase()==='.pdf')return {...file,mime:'application/pdf'};
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

/** A file opened for a stream download (src/connector/blob.ts); whoever gets it reads `start`..`end` and closes `handle`. */
export class FileStream {
  constructor(readonly handle:FileHandle,readonly size:number,readonly start:number,readonly end:number,readonly name:string,readonly mime:string){}
}
const STREAM_TYPES:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif',
  '.mp4':'video/mp4','.m4v':'video/mp4','.webm':'video/webm','.ogv':'video/ogg','.mov':'video/quicktime','.pdf':'application/pdf'};
/**
 * Opens a file for a stream download with the same checks as {@link downloadProjectFile}. `range`: the bytes asked for,
 * `end` included; the whole file without it.
 */
export async function openProjectDownload(cwd:string,path:string,expectedRevision:string,range?:unknown):Promise<FileStream> {
  const {handle,target,info}=await openProjectFile(cwd,path);
  try {
    if(info.size>BigInt(MAX_DOWNLOAD_SIZE))throw new BridgeError('too_large','下载上限为 100 MiB，请在电脑获取此文件');
    if(revision(target,info)!==expectedRevision)throw changed();
    const size=Number(info.size),asked=range&&typeof range==='object'?range as {start?:unknown;end?:unknown}:{};
    const start=asked.start===undefined?0:Number(asked.start),end=asked.end===undefined?size-1:Math.min(size-1,Number(asked.end));
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||(size>0&&start>end))throw new BridgeError('range','请求的文件范围无效');
    return new FileStream(handle,size,start,end,basename(target),STREAM_TYPES[extname(target).toLowerCase()]||'application/octet-stream');
  }catch(error){await handle.close();fileError(error);}
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
