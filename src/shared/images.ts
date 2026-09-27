import {BridgeError} from './types.js';

export const MAX_IMAGES=2;
export const MAX_IMAGE_BYTES=2*1024*1024;
export function imageDataUrl(value:unknown):string {
  if(typeof value!=='string')throw new BridgeError('invalid','图片数据无效');
  const match=value.match(/^data:image\/(png|jpeg|webp);base64,([a-z\d+/=\s]+)$/i);
  if(!match)throw new BridgeError('invalid','请选择 PNG、JPEG 或 WebP 图片');
  const data=match[2].replace(/\s/g,'');
  if(data.length>Math.ceil(MAX_IMAGE_BYTES/3)*4)throw new BridgeError('invalid','每张图片不能超过 2 MiB');
  let bytes:string;try{bytes=atob(data);}catch{throw new BridgeError('invalid','图片 Base64 数据无效');}
  if(!bytes.length||bytes.length>MAX_IMAGE_BYTES)throw new BridgeError('invalid','每张图片须大于 0 B 且不超过 2 MiB');
  return `data:image/${match[1].toLowerCase()};base64,${btoa(bytes)}`;
}
