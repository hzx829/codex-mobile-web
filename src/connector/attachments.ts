import {mkdir,realpath,open} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {BridgeError} from '../shared/types.js';
import {fileAttachment,uploadId,MAX_ATTACHMENTS,UPLOAD_CHUNK_BYTES,type FileAttachment} from '../shared/attachments.js';
import {assertInsideWorkspace, checkProjectPath, projectDirectory} from './project.js';
import type {Ledger,UploadRecord} from './ledger.js';

const location=(file:UploadRecord)=>join(file.cwd,'.codex-mobile-attachments',file.id,file.name);
function record(ledger:Ledger,threadId:string,id:string):UploadRecord {
  const file=ledger.upload(id);
  if(!file||file.threadId!==threadId)throw new BridgeError('invalid','文件不属于当前会话，请重新上传');
  return file;
}
async function checkedPath(path:string) {
  const canonical=await realpath(path);
  assertInsideWorkspace(canonical);
  if(canonical!==resolve(path))throw new BridgeError('invalid','附件路径已变化，请重新上传');
  return path;
}
async function uploadFile(file:UploadRecord,mode:'r'|'r+') {
  try {
    const handle=await open(await checkedPath(location(file)),mode);
    try {
      const info=await handle.stat();
      if(!info.isFile()||info.size>file.size)throw new BridgeError('invalid','附件内容已变化，请重新上传');
      return {handle,size:info.size};
    }catch(error){await handle.close();throw error;}
  }catch(error){
    if(error instanceof BridgeError)throw error;
    throw new BridgeError('upload_failed','附件无法读取，请检查项目目录或重新上传');
  }
}
export async function startUpload(ledger:Ledger,threadId:string,cwd:string,value:unknown) {
  const file=fileAttachment(value),project=await projectDirectory(cwd),old=ledger.upload(file.id);
  if(old&&(old.threadId!==threadId||old.cwd!==project||old.name!==file.name||old.size!==file.size))throw new BridgeError('conflict','上传内容或会话已变化，请重新选择文件');
  const stored:UploadRecord={...file,threadId,cwd:project};
  if(!old){
    const root=join(project,'.codex-mobile-attachments');await checkProjectPath(root);await mkdir(root,{recursive:true});await checkedPath(root);
    const dir=join(root,file.id);await mkdir(dir);await checkedPath(dir);
    // Record before creating the file so a restart can resume the same upload ID.
    ledger.addUpload(stored);
  }
  await checkedPath(join(project,'.codex-mobile-attachments',file.id));
  try{const handle=await open(location(stored),'wx');await handle.close();}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const {handle,size}=await uploadFile(stored,'r');await handle.close();
  return {id:file.id,offset:size};
}
/**
 * A part of an upload arriving through the relay's data channel (src/connector/blob.ts): `length` bytes from `stream`.
 * Only the connector makes these; a phone's JSON cannot, so it can only send base64 parts.
 */
export class UploadBody {
  constructor(readonly stream:AsyncIterable<Buffer>,readonly length:number){}
}
/** The most one data channel request may carry. */
export const UPLOAD_STREAM_BYTES=8*1024*1024;
async function appendStream(file:UploadRecord,id:string,start:number,body:UploadBody) {
  const end=start+body.length;
  if(!Number.isSafeInteger(body.length)||body.length<=0||body.length>UPLOAD_STREAM_BYTES||end>file.size)throw new BridgeError('invalid','文件分块超过上传大小');
  const {handle,size}=await uploadFile(file,'r+');
  try {
    // A phone that lost an answer asks uploadStart where to go on, so a part always starts where the file ends.
    if(start!==size)throw new BridgeError('conflict','上传位置不连续，请重试');
    let position=start;
    for await(const chunk of body.stream){
      if(position+chunk.length>end)throw new BridgeError('invalid','文件分块超过声明的大小');
      let written=0;
      while(written<chunk.length){const result=await handle.write(chunk,written,chunk.length-written,position+written);if(!result.bytesWritten)throw new BridgeError('upload_failed','附件写入失败，请重试');written+=result.bytesWritten;}
      position+=chunk.length;
    }
    // What arrived stays: the next uploadStart reports it and the phone goes on from there.
    if(position!==end)throw new BridgeError('incomplete','上传中断，请重试');
    return {id,offset:end};
  }finally{await handle.close();}
}
export async function appendUpload(ledger:Ledger,threadId:string,id:string,offset:unknown,value:unknown) {
  const file=record(ledger,threadId,id);
  if(!Number.isSafeInteger(offset)||(offset as number)<0)throw new BridgeError('invalid','上传位置无效');
  if(value instanceof UploadBody)return appendStream(file,id,offset as number,value);
  if(typeof value!=='string'||!value.length||value.length>Math.ceil(UPLOAD_CHUNK_BYTES/3)*4||value.length%4!==0||!/^[a-z\d+/]+={0,2}$/i.test(value))throw new BridgeError('invalid','文件分块数据无效');
  const bytes=Buffer.from(value,'base64'),start=offset as number,end=start+bytes.length;
  if(bytes.length>UPLOAD_CHUNK_BYTES||end>file.size)throw new BridgeError('invalid','文件分块超过上传大小');
  const {handle,size}=await uploadFile(file,'r+');
  try {
    if(start>size)throw new BridgeError('invalid','上传位置不连续，请重试');
    // A lost receipt may repeat a chunk; only accept bytes already present unchanged.
    const overlap=Math.min(bytes.length,size-start);
    if(overlap){
      const previous=Buffer.alloc(overlap);let read=0;
      while(read<overlap){const result=await handle.read(previous,read,overlap-read,start+read);if(!result.bytesRead)throw new BridgeError('changed','附件内容已变化');read+=result.bytesRead;}
      if(!previous.equals(bytes.subarray(0,overlap)))throw new BridgeError('conflict','文件分块内容不一致，请重新选择文件');
    }
    let written=overlap;
    while(written<bytes.length){const result=await handle.write(bytes,written,bytes.length-written,start+written);if(!result.bytesWritten)throw new BridgeError('upload_failed','附件写入失败，请重试');written+=result.bytesWritten;}
    return {id,offset:Math.max(size,end)};
  }finally{await handle.close();}
}
const uploading=new Map<string,Promise<unknown>>();
/** Runs the steps of one upload in order: a retried chunk may arrive while the previous copy is still being written. */
function uploadStep<T>(id:string,run:()=>Promise<T>):Promise<T> {
  const next=(uploading.get(id)??Promise.resolve()).catch(()=>{}).then(run),settled=next.catch(()=>{});
  uploading.set(id,settled);
  void settled.then(()=>{if(uploading.get(id)===settled)uploading.delete(id);});
  return next;
}
/**
 * Upload for Claude Code and Antigravity, stored like Codex's in the project's `.codex-mobile-attachments`.
 * `scope` names the conversation (or the project a new one starts in); only that scope can attach the file.
 */
export function scopedUpload(ledger:Ledger,stage:'start'|'chunk',scope:string,cwd:()=>Promise<string>,p:any) {
  const id=uploadId(p?.id);
  return uploadStep(id,async()=>stage==='chunk'?appendUpload(ledger,scope,id,p.offset,p.body instanceof UploadBody?p.body:p.data):startUpload(ledger,scope,await cwd(),p));
}
/** Files as ledger identity: what was attached, not where it is stored. */
export const attachmentIds=(files:FileAttachment[])=>files.map(file=>file.id);
/** Validated `files` of a request; none when absent. */
export function requestFiles(value:unknown):FileAttachment[] {
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>MAX_ATTACHMENTS)throw new BridgeError('invalid',`最多添加 ${MAX_ATTACHMENTS} 个文件`);
  return value.map(fileAttachment);
}
/** The message with links to its uploaded files appended, as Codex receives them. */
export async function withAttachmentLinks(ledger:Ledger,scope:string,text:string,files:FileAttachment[]) {
  return [text,await attachmentLinks(ledger,scope,files)].filter(Boolean).join('\n\n');
}
export async function attachmentLinks(ledger:Ledger,threadId:string,files:FileAttachment[]):Promise<string> {
  if(!files.length)return '';
  const links:string[]=[];
  for(const file of files){
    const stored=record(ledger,threadId,file.id);
    if(stored.name!==file.name||stored.size!==file.size)throw new BridgeError('invalid','附件信息不匹配，请重新上传');
    const {handle,size}=await uploadFile(stored,'r');await handle.close();
    if(size!==file.size)throw new BridgeError('incomplete','文件尚未上传完成，请重试');
    const label=file.name.replace(/[\\`*_[\]<>]/g,'\\$&');
    const href=location(stored).replace(/\\/g,'/').split('/').map((part,i)=>i===0&&/^[a-z]:$/i.test(part)?part:encodeURIComponent(part)).join('/');
    links.push(`- [${label}](<${href}>)`);
  }
  return `附件（已保存到当前项目，请按需读取）：\n${links.join('\n')}`;
}
