import {useEffect,useState,type ImgHTMLAttributes} from 'react';
import type {Json} from '../src/shared/types';
import {blobSession,blobUploadTarget,putPart} from './blob';
import {imageFile} from './attachments';

/**
 * Images by content through the relay's data channel (src/connector/blob-store.ts). Synced messages carry
 * `cmw-image:<sha256>`; the browser loads each once and keeps it. Images to send are uploaded first and go as references.
 */
const REF=/^cmw-image:([a-f0-9]{64})$/;
export const isImageRef=(url:string)=>REF.test(url);

/** Where an image is loaded from: the data channel for a reference, the value itself otherwise ('' when unreachable). */
export function imageSource(url:string):string{
  const match=REF.exec(url);if(!match)return url;
  const target=blobUploadTarget();
  return target?`/blob/${encodeURIComponent(target.machine)}/image/${match[1]}`:'';
}

/** An `<img>` that also shows references, once this device is signed in to the data channel. */
export function BlobImage({src,alt,...rest}:ImgHTMLAttributes<HTMLImageElement>&{src:string}){
  const ref=isImageRef(src),[ready,setReady]=useState(!ref);
  useEffect(()=>{
    if(!ref)return;
    let live=true;const target=blobUploadTarget();
    if(target)void blobSession(target.token).then(ok=>{if(live&&ok)setReady(true);});
    return()=>{live=false;};
  },[src]);
  const source=ready?imageSource(src):'';
  if(!source)return <span className="attachment image-pending" role="img" aria-label={alt||'图片'}>{alt||'图片'}</span>;
  return <img src={source} alt={alt} {...rest}/>;
}

const uploaded=new Map<string,string>();
/** Requests that carry images to send; their images go up first when the computer takes references. */
const SENDS=new Set(['turn.send','turn.edit','session.create','claude.send','claude.create','claude.edit','antigravity.send','antigravity.create']);
/**
 * `payload` with its data URL images uploaded to `machine` and replaced by references, when the data channel takes images.
 * An image that fails to upload stays in the message as before.
 */
export async function withUploadedImages(action:string,payload:Json,machine:string):Promise<Json>{
  const target=blobUploadTarget();
  if(!SENDS.has(action)||!Array.isArray(payload.images)||!payload.images.length||!target?.images||target.machine!==machine)return payload;
  if(!await blobSession(target.token))return payload;
  const images=await Promise.all(payload.images.map(async(url:unknown)=>{
    if(typeof url!=='string'||!url.startsWith('data:image/'))return url;
    const key=`${machine}:${url.length}:${url.slice(-64)}`,known=uploaded.get(key);
    if(known)return known;
    const answer=await putPart(`/blob/${encodeURIComponent(machine)}/image`,imageFile(url),()=>{});
    const ref=answer.status===200&&typeof answer.result?.ref==='string'&&isImageRef(answer.result.ref)?answer.result.ref:null;
    if(!ref)return url;
    uploaded.set(key,ref);if(uploaded.size>200)uploaded.delete(uploaded.keys().next().value!);
    return ref;
  }));
  return {...payload,images};
}
