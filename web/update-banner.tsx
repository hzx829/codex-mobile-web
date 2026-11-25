import {useEffect,useState} from 'react';
import {IconButton} from './icon-button';
import {UpdateWatch,pageAssets} from './app-update';
import {flushAllDrafts,hasPendingDrafts} from './draft-save';
import {flushDraftAttachments,hasDraftAttachments} from './composer-attachments';
import {flushCache} from './session-cache';
import {flushThreadStore} from './sync/idb-store';

const RELOADED_KEY='cmw-update-reload';
const lastReload=()=>{try{return Number(sessionStorage.getItem(RELOADED_KEY))||0;}catch{return 0;}};
const TOUCH=['pointerdown','keydown','wheel'] as const;

/** True when the user has unsent text or attachments in any composer or editor, so automatic reload must not interrupt them. */
function isPageDirty():boolean{
  if(hasPendingDrafts()||hasDraftAttachments())return true;
  if(typeof document==='undefined')return false;
  for(const field of document.querySelectorAll<HTMLTextAreaElement>('textarea')){
    if(field.value.trim().length>0)return true;
  }
  return false;
}

/** Persists all unsent drafts, attachments and caches before reloading into the new web build. */
async function reloadPreservingDrafts(quiet:boolean){
  flushAllDrafts();
  if(quiet){try{sessionStorage.setItem(RELOADED_KEY,String(Date.now()));}catch{}}
  await Promise.race([
    Promise.allSettled([flushDraftAttachments(),flushCache(),flushThreadStore()]),
    new Promise<void>(resolve=>setTimeout(resolve,450)),
  ]);
  location.reload();
}

/** Moves an open page to a newly deployed release: by itself right after opening, otherwise on request. Needs the service worker, so production only. */
export function UpdateBanner(){
  const [offer,setOffer]=useState(false);
  const [reloading,setReloading]=useState(false);
  useEffect(()=>{
    const worker=navigator.serviceWorker;
    if(!import.meta.env.PROD||!worker)return;
    const watch=new UpdateWatch(pageAssets(document));
    const ask=()=>worker.controller?.postMessage({type:'check'});
    const receive=(event:MessageEvent)=>{
      if(event.data?.type!=='shell')return;
      const action=watch.decide(event.data.current,{visible:document.visibilityState==='visible',lastReload:lastReload(),dirty:isPageDirty()});
      if(action==='reload')void reloadPreservingDrafts(true);else setOffer(action==='offer');
    };
    const touch=()=>watch.touch();
    // A page brought back from the background did not navigate, so nothing else would check.
    const show=()=>{
      if(document.visibilityState!=='visible')return;
      watch.show();
      void worker.getRegistration().then(registration=>registration?.update()).catch(()=>{});
      ask();
    };
    const restored=(event:PageTransitionEvent)=>{if(event.persisted)show();};
    worker.addEventListener('message',receive);
    for(const type of TOUCH)window.addEventListener(type,touch,{capture:true,passive:true});
    document.addEventListener('visibilitychange',show);
    window.addEventListener('pageshow',restored);
    ask();
    return()=>{
      worker.removeEventListener('message',receive);
      for(const type of TOUCH)window.removeEventListener(type,touch,{capture:true});
      document.removeEventListener('visibilitychange',show);
      window.removeEventListener('pageshow',restored);
    };
  },[]);
  if(!offer)return null;
  return <div className="update-banner" role="status">
    <span>新版本已就绪</span>
    <button type="button" disabled={reloading} onClick={()=>{setReloading(true);void reloadPreservingDrafts(false);}}>{reloading?'正在刷新…':'刷新'}</button>
    <IconButton icon="close" label="稍后" disabled={reloading} onClick={()=>setOffer(false)}/>
  </div>;
}
