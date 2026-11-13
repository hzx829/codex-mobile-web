import {BridgeError} from './types.js';

export const MAX_IMAGES=10;
export const MAX_IMAGE_BYTES=2*1024*1024;
export const MAX_IMAGE_INPUT_BYTES=20*1024*1024;
// Base64 plus text/metadata must fit the relay's 12 MiB frame.
export const MAX_TOTAL_IMAGE_BYTES=8*1024*1024;
export const imageBytes=(url:string)=>{const data=url.slice(url.indexOf(',')+1);return data.length/4*3-(data.endsWith('==')?2:data.endsWith('=')?1:0);};
export function imageDataUrl(value:unknown):string {return normalizeImage(value,MAX_IMAGE_BYTES);}
export function sourceImageDataUrl(value:unknown):string {return normalizeImage(value,MAX_IMAGE_INPUT_BYTES);}
function normalizeImage(value:unknown,maxBytes:number):string {
  if(typeof value!=='string')throw new BridgeError('invalid','图片数据无效');
  const match=value.match(/^data:image\/(png|jpeg|webp);base64,/i);
  if(!match)throw new BridgeError('invalid','请选择 PNG、JPEG 或 WebP 图片');
  const data=value.slice(match[0].length).replace(/\s/g,'');
  const limit=`每张图片须大于 0 B 且不超过 ${maxBytes/1024/1024} MiB`;
  if(!data.length||data.length>Math.ceil(maxBytes/3)*4)throw new BridgeError('invalid',limit);
  if(!/^[a-z\d+/]*={0,2}$/i.test(data)||data.length%4===1||data.includes('=')&&data.length%4!==0)throw new BridgeError('invalid','图片 Base64 数据无效');
  const padded=data.padEnd(Math.ceil(data.length/4)*4,'=');
  // Only decode the final quartet to canonicalize padding bits, not multi-MiB images.
  const canonical=padded.slice(0,-4)+btoa(atob(padded.slice(-4)));
  const result=`data:image/${match[1].toLowerCase()};base64,${canonical}`;
  if(imageBytes(result)>maxBytes)throw new BridgeError('invalid',limit);
  return result;
}
export function validateImages(values:unknown):string[] {
  if(!Array.isArray(values)||values.length>MAX_IMAGES)throw new BridgeError('invalid',`最多添加 ${MAX_IMAGES} 张 PNG、JPEG 或 WebP 图片`);
  const images=values.map(imageDataUrl);
  if(images.reduce((sum,url)=>sum+imageBytes(url),0)>MAX_TOTAL_IMAGE_BYTES)throw new BridgeError('invalid','整批图片压缩后不能超过 8 MiB，请减少图片后重试');
  return images;
}
