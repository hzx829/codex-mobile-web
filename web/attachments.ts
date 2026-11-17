import {imageDataUrl,sourceImageDataUrl,validateImages,MAX_IMAGES,MAX_IMAGE_BYTES,MAX_IMAGE_INPUT_BYTES,MAX_TOTAL_IMAGE_BYTES} from '../src/shared/images';
import {fileAttachment,validateAttachments,MAX_ATTACHMENTS,type FileAttachment} from '../src/shared/attachments';
import {imageBytes} from '../src/shared/images';
import {uuid} from './client';

export type DraftFileAttachment=FileAttachment&{file?:File};

export function clipboardFiles(data:DataTransfer):File[] {
  const items=Array.from(data.items||[]).filter(item=>item.kind==='file').map(item=>item.getAsFile()).filter((file):file is File=>Boolean(file));
  return items.length?items:Array.from(data.files||[]);
}
export function isImageFile(file:File):boolean {
  return ['image/png','image/jpeg','image/webp'].includes(file.type)||!file.type&&/\.(png|jpe?g|webp)$/i.test(file.name);
}
export async function readAttachmentFiles(selection:File[],images:string[],files:DraftFileAttachment[],cancelled=()=>false) {
  if(selection.length+images.length+files.length>MAX_ATTACHMENTS)throw Error(`图片和文件合计最多添加 ${MAX_ATTACHMENTS} 个`);
  const photos=selection.filter(isImageFile),documents=selection.filter(file=>!isImageFile(file));
  const budget=MAX_TOTAL_IMAGE_BYTES-images.reduce((sum,url)=>sum+imageBytes(url),0);
  // Keep browser File handles; only read small slices when actually uploading.
  const incoming=documents.map(file=>({...fileAttachment({id:uuid(),name:file.name,size:file.size}),file}));
  const normalized=photos.map(file=>file.type?file:new File([file],file.name,{type:/\.png$/i.test(file.name)?'image/png':/\.webp$/i.test(file.name)?'image/webp':'image/jpeg'}));
  const newImages=await readImageFiles(normalized,budget,cancelled);
  if(cancelled())return null;
  const next={images:appendImages(images,newImages),files:[...files,...incoming]};
  validateAttachments(next.images,next.files);return next;
}

export function pastedImage(text:string):string|null {
  const value=text.trim();
  if(/^data:image\//i.test(value))return sourceImageDataUrl(value);
  // Recognize bare Base64 only by a supported image signature; ordinary text remains text.
  if(!/^[a-z\d+/=\s]+$/i.test(value))return null;
  const data=value.replace(/\s/g,'');
  let header='';try{header=atob(data.slice(0,16));}catch{return null;}
  const mime=data.startsWith('iVBORw0KGgo')?'png':data.startsWith('/9j/')?'jpeg':header.startsWith('RIFF')&&header.slice(8,12)==='WEBP'?'webp':null;
  return mime?sourceImageDataUrl(`data:image/${mime};base64,${data}`):null;
}
export function appendImages(current:string[],incoming:string[]):string[] {
  return validateImages([...new Set([...current,...incoming.map(imageDataUrl)])]);
}
export function clipboardImageFiles(data:DataTransfer):File[] {
  const items=Array.from(data.items||[]).filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter((file):file is File=>Boolean(file));
  return items.length?items:Array.from(data.files||[]).filter(file=>file.type.startsWith('image/'));
}
export function imageFile(url:string):File {
  const comma=url.indexOf(','),parts:Uint8Array<ArrayBuffer>[]=[];
  for(let offset=comma+1;offset<url.length;offset+=32768){
    const bytes=atob(url.slice(offset,offset+32768)),part=new Uint8Array(bytes.length);
    for(let i=0;i<bytes.length;i++)part[i]=bytes.charCodeAt(i);
    parts.push(part);
  }
  return new File(parts,'pasted-image',{type:url.slice(5,url.indexOf(';'))});
}
function readDataUrl(file:Blob):Promise<string> {
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));
    reader.onerror=()=>reject(Error('文件读取失败'));reader.onabort=()=>reject(Error('文件读取已取消'));reader.readAsDataURL(file);
  });
}
async function decodeImage(file:Blob):Promise<{source:CanvasImageSource;width:number;height:number;close:()=>void}> {
  if(typeof createImageBitmap==='function')try{const bitmap=await createImageBitmap(file);return {source:bitmap,width:bitmap.width,height:bitmap.height,close:()=>bitmap.close()};}catch{}
  const url=URL.createObjectURL(file),img=new Image();
  try{await new Promise<void>((resolve,reject)=>{img.onload=()=>resolve();img.onerror=()=>reject(Error('无法读取这张图片，请换一张后重试'));img.src=url;});return {source:img,width:img.naturalWidth,height:img.naturalHeight,close:()=>{img.src='';URL.revokeObjectURL(url);}};}
  catch(error){URL.revokeObjectURL(url);throw error;}
}
async function compressImage(file:Blob,budget:number):Promise<Blob> {
  if(file.size<=budget)return file;
  const decoded=await decodeImage(file),canvas=document.createElement('canvas');
  try{
    let scale=Math.min(1,2560/Math.max(decoded.width,decoded.height));
    if(!decoded.width||!decoded.height)throw Error('图片尺寸无效');
    for(let attempt=0;attempt<8;attempt++){
      canvas.width=Math.max(1,Math.round(decoded.width*scale));canvas.height=Math.max(1,Math.round(decoded.height*scale));
      const context=canvas.getContext('2d');if(!context)throw Error('浏览器无法压缩图片');
      context.drawImage(decoded.source,0,0,canvas.width,canvas.height);
      const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(Error('图片压缩失败')),'image/webp',Math.max(.7,.9-attempt*.04)));
      if(blob.size<=budget)return blob;
      scale*=.75;
    }
    throw Error('图片压缩后仍然过大，请减少图片后重试');
  }finally{decoded.close();canvas.width=canvas.height=0;}
}
export async function readImageFiles(files:File[],budget=MAX_TOTAL_IMAGE_BYTES,cancelled=()=>false):Promise<string[]> {
  if(files.length>MAX_IMAGES)throw Error(`最多添加 ${MAX_IMAGES} 张图片`);
  for(const file of files)if(!['image/png','image/jpeg','image/webp'].includes(file.type)||!file.size||file.size>MAX_IMAGE_INPUT_BYTES)throw Error('请选择大于 0 B、不超过 20 MiB 的 PNG、JPEG 或 WebP 图片');
  if(files.length&&budget<64*1024)throw Error('整批图片压缩后不能超过 8 MiB，请先移除一张');
  const result:string[]=[];
  // Process one image at a time so a multi-photo selection does not decode all photos together.
  for(const [index,file] of files.entries()){
    if(cancelled())return [];
    const image=await compressImage(file,Math.min(MAX_IMAGE_BYTES,Math.floor(budget/(files.length-index))));
    if(cancelled())return [];
    result.push(await readDataUrl(image));budget-=image.size;
  }
  return result;
}
