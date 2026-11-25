import {useEffect,useState} from 'react';
import {IconButton} from './icon-button';
import {UpdateWatch,pageAssets} from './app-update';

const RELOADED_KEY='cmw-update-reload';
const lastReload=()=>{try{return Number(sessionStorage.getItem(RELOADED_KEY))||0;}catch{return 0;}};
/** Only automatic reloads are remembered: they are the ones that could repeat. */
function reloadQuietly(){
  try{sessionStorage.setItem(RELOADED_KEY,String(Date.now()));}catch{}
  location.reload();
}
const TOUCH=['pointerdown','keydown','wheel'] as const;

/** Moves an open page to a newly deployed release: by itself right after opening, otherwise on request. Needs the service worker, so production only. */
export function UpdateBanner(){
  const [offer,setOffer]=useState(false);
  useEffect(()=>{
    const worker=navigator.serviceWorker;
    if(!import.meta.env.PROD||!worker)return;
    const watch=new UpdateWatch(pageAssets(document));
    const ask=()=>worker.controller?.postMessage({type:'check'});
    const receive=(event:MessageEvent)=>{
      if(event.data?.type!=='shell')return;
      const action=watch.decide(event.data.current,{visible:document.visibilityState==='visible',lastReload:lastReload()});
      if(action==='reload')reloadQuietly();else setOffer(action==='offer');
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
    <button type="button" onClick={()=>location.reload()}>刷新</button>
    <IconButton icon="close" label="稍后" onClick={()=>setOffer(false)}/>
  </div>;
}
