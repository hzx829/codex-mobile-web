import type {Json} from '../src/shared/types';

/**
 * The relay's data channel (src/server/blob.ts): files come as plain HTTP downloads, which the browser streams, shows
 * and saves itself. A cookie for this device is set once per token with {@link blobSession}.
 */
let session:Promise<boolean>|null=null,sessionToken='';

/** Signs this device in to the data channel; true once its cookie is set. Asked again after a failure. */
export function blobSession(token:string):Promise<boolean>{
  if(session&&sessionToken===token)return session;
  sessionToken=token;
  const asked=fetch('/blob/session',{method:'POST',headers:{Authorization:`Bearer ${token}`},credentials:'same-origin'}).then(response=>response.ok,()=>false);
  session=asked;
  void asked.then(ok=>{if(!ok&&session===asked)session=null;});
  return asked;
}
/** Forgets the cookie, as after a 401 when the relay restarted. */
export function resetBlobSession(){session=null;}

/** Where a download action's file is; `download` saves it rather than showing it. */
export function blobUrl(machine:string,action:string,payload:Json,download=false){
  const query=new URLSearchParams({action});
  for(const [key,value] of Object.entries(payload))if(typeof value==='string'||typeof value==='number')query.set(key,String(value));
  if(download)query.set('download','1');
  return `/blob/${encodeURIComponent(machine)}/file?${query}`;
}

/**
 * The computer uploads go to through the data channel, and the token that signs in; null while either side lacks it.
 * `images`: it also keeps images by content (web/blob-image.tsx).
 */
export type BlobUploadTarget={machine:string;token:string;images?:boolean};
let uploadTarget:BlobUploadTarget|null=null;
const targetListeners=new Set<()=>void>();
export function setBlobUploadTarget(target:BlobUploadTarget|null){
  if(uploadTarget?.machine===target?.machine&&uploadTarget?.token===target?.token&&Boolean(uploadTarget?.images)===Boolean(target?.images))return;
  uploadTarget=target;
  for(const listener of targetListeners)listener();
}
export function blobUploadTarget(){return uploadTarget;}
export function onBlobUploadTarget(listener:()=>void){targetListeners.add(listener);return()=>{targetListeners.delete(listener);};}

/** The answer to one upload part, or why it failed; `status` 0 when the request did not get through. */
export type PartAnswer={status:number;result?:Json;error?:{code?:string;message?:string}};
/** Sends one upload part (web/file-upload.ts) with the browser's upload progress. */
export function putPart(url:string,body:Blob,progress:(sent:number)=>void):Promise<PartAnswer>{
  return new Promise(resolve=>{
    const request=new XMLHttpRequest();
    request.open('PUT',url);request.withCredentials=true;
    request.upload.onprogress=event=>progress(event.loaded);
    request.onload=()=>{let value:Json={};try{value=JSON.parse(request.responseText||'{}');}catch{}resolve({status:request.status,result:value.result,error:value.error});};
    request.onerror=request.onabort=request.ontimeout=()=>resolve({status:0});
    request.send(body);
  });
}
