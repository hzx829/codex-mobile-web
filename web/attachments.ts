import {imageDataUrl,MAX_IMAGES,MAX_IMAGE_BYTES} from '../src/shared/images';

export function pastedImage(text:string):string|null {
  const value=text.trim();
  if(/^data:image\//i.test(value))return imageDataUrl(value);
  // Recognize bare Base64 only by a supported image signature; ordinary text remains text.
  if(!/^[a-z\d+/=\s]+$/i.test(value))return null;
  const data=value.replace(/\s/g,'');
  let header='';try{header=atob(data.slice(0,16));}catch{return null;}
  const mime=data.startsWith('iVBORw0KGgo')?'png':data.startsWith('/9j/')?'jpeg':header.startsWith('RIFF')&&header.slice(8,12)==='WEBP'?'webp':null;
  return mime?imageDataUrl(`data:image/${mime};base64,${data}`):null;
}
export function appendImages(current:string[],incoming:string[]):string[] {
  const next=[...new Set([...current,...incoming.map(imageDataUrl)])];
  if(next.length>MAX_IMAGES)throw Error(`最多添加 ${MAX_IMAGES} 张图片，请先移除一张`);
  return next;
}
export async function readImageFiles(files:File[]):Promise<string[]> {
  if(files.length>MAX_IMAGES)throw Error(`最多添加 ${MAX_IMAGES} 张图片`);
  return Promise.all(files.map(file=>{
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)||!file.size||file.size>MAX_IMAGE_BYTES)throw Error('请选择不超过 2 MiB 的 PNG、JPEG 或 WebP 图片');
    return new Promise<string>((resolve,reject)=>{
      const reader=new FileReader();reader.onload=()=>{try{resolve(imageDataUrl(reader.result));}catch(e){reject(e);}};
      reader.onerror=()=>reject(Error('图片读取失败'));reader.readAsDataURL(file);
    });
  }));
}
