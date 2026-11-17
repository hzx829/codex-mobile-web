import {BridgeError} from './types.js';
import {validateImages,MAX_IMAGES} from './images.js';

export interface FileAttachment {id:string;name:string;size:number}
export const MAX_ATTACHMENTS=MAX_IMAGES;
export const MAX_FILE_UPLOAD_BYTES=100*1024*1024;
export const UPLOAD_CHUNK_BYTES=512*1024;

export function uploadId(value:unknown):string {
  if(typeof value!=='string'||!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value))throw new BridgeError('invalid','文件上传标识无效，请重新选择文件');
  return value.toLowerCase();
}

export function attachmentName(value:unknown):string {
  if(typeof value!=='string'||!value.trim()||value.length>180||/[<>:"/\\|?*\x00-\x1f\x7f]/.test(value)||/[. ]$/.test(value)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value))throw new BridgeError('invalid','文件名无效，请重命名后上传');
  return value;
}
export function fileAttachment(value:any):FileAttachment {
  const id=uploadId(value?.id),name=attachmentName(value?.name),size=value?.size;
  if(!Number.isSafeInteger(size)||size<=0||size>MAX_FILE_UPLOAD_BYTES)throw new BridgeError('invalid','每个文件须大于 0 B 且不超过 100 MiB');
  return {id,name,size};
}
export function validateAttachments(imageValues:unknown,fileValues:unknown):{images:string[];files:FileAttachment[]} {
  const images=validateImages(imageValues);
  if(!Array.isArray(fileValues)||images.length+fileValues.length>MAX_ATTACHMENTS)throw new BridgeError('invalid',`图片和文件合计最多添加 ${MAX_ATTACHMENTS} 个`);
  return {images,files:fileValues.map(fileAttachment)};
}
