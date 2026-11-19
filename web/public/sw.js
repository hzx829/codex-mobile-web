// App shell cache: the page and its versioned static files, never conversations or requests.
// The cached page opens at once; a fresh copy is fetched in the background and only
// replaces it once every file it references is cached, so the shell stays consistent.
const CACHE='cmw-shell-v1';
const SHELL='/';
const MANIFEST='/__shell-assets';
const ASSET=/\/assets\/[\w.-]+-[\w-]{8,}\.(?:m?js|css)/g;
let refreshing=null,checked=0;

self.addEventListener('install',event=>{self.skipWaiting();event.waitUntil(refreshShell().catch(()=>{}));});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    for(const key of await caches.keys())if(key!==CACHE)await caches.delete(key);
    await self.clients.claim();
  })());
});

async function readManifest(cache){
  try{return await (await cache.match(MANIFEST))?.json()||{current:[],previous:[]};}catch{return {current:[],previous:[]};}
}
async function cacheAsset(cache,path){
  if(await cache.match(path))return;
  const response=await fetch(path,{cache:'no-store'});
  if(!response.ok)throw new Error(`asset ${response.status}`);
  await cache.put(path,response);
}
/** Fetches the page and everything it can load, then swaps it in. Older files stay one version for open pages. */
async function refreshShell(){
  const cache=await caches.open(CACHE);
  const page=await fetch(SHELL,{cache:'no-store'});
  if(!page.ok||page.type!=='basic')return;
  const html=await page.clone().text();
  const assets=new Set(html.match(ASSET)||[]);
  // Lazy chunks and workers are named inside the scripts that load them.
  const queue=[...assets];
  while(queue.length){
    const path=queue.shift();
    await cacheAsset(cache,path);
    if(!/\.m?js$/.test(path))continue;
    const text=await (await cache.match(path)).text();
    for(const match of text.matchAll(/assets\/[\w.-]+-[\w-]{8,}\.(?:m?js|css)/g)){
      const found='/'+match[0];
      if(!assets.has(found)){assets.add(found);queue.push(found);}
    }
  }
  const manifest=await readManifest(cache),current=[...assets];
  const same=current.length===manifest.current.length&&current.every(path=>manifest.current.includes(path));
  const next=same?manifest:{current,previous:manifest.current};
  await cache.put(SHELL,page);
  await cache.put(MANIFEST,new Response(JSON.stringify(next),{headers:{'Content-Type':'application/json'}}));
  const keep=new Set([...next.current,...next.previous]);
  for(const request of await cache.keys()){
    const path=new URL(request.url).pathname;
    if(path.startsWith('/assets/')&&!keep.has(path))await cache.delete(request);
  }
}
function backgroundRefresh(event){
  if(refreshing||Date.now()-checked<30_000)return;
  checked=Date.now();
  refreshing=refreshShell().catch(()=>{}).finally(()=>{refreshing=null;});
  event.waitUntil(refreshing);
}

self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin||url.pathname==='/ws'||url.pathname==='/health'||url.pathname==='/sw.js')return;
  if(request.mode==='navigate'&&url.pathname===SHELL){
    event.respondWith((async()=>{
      const cached=await caches.match(SHELL);
      if(cached){backgroundRefresh(event);return cached;}
      const response=await fetch(request);
      backgroundRefresh(event);
      return response;
    })());
    return;
  }
  if(url.pathname.startsWith('/assets/')){
    event.respondWith((async()=>{
      const cache=await caches.open(CACHE),cached=await cache.match(url.pathname);
      if(cached)return cached;
      const response=await fetch(request);
      if(response.ok&&response.type==='basic')await cache.put(url.pathname,response.clone());
      return response;
    })());
  }
});
