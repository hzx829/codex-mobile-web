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
