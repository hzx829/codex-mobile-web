import {useEffect,useRef,useState,type ClipboardEvent,type SetStateAction} from 'react';
import {clipboardFiles,imageFile,isImageFile,pastedImage,readAttachmentFiles,readImageFiles,type DraftFileAttachment} from './attachments';
import {useFileDrop} from './file-drop';
import {MAX_TOTAL_IMAGE_BYTES,imageBytes,validateImages} from '../src/shared/images';

type StoredAttachments={images:string[];files:DraftFileAttachment[]};
const draftAttachments=new Map<string,StoredAttachments>();
const MAX_DRAFT_SCOPES=32;

// Persist unsent composer images & files in IndexedDB so hot-deploy / manual page reloads never lose them.
const DRAFT_DB='codex-mobile-web-drafts',DRAFT_STORE='attachments',DRAFT_DB_VERSION=1;
let draftDb:Promise<IDBDatabase>|null=null;
let writeQueue:Promise<void>=Promise.resolve();

function openDraftDb():Promise<IDBDatabase>{
  draftDb??=new Promise<IDBDatabase>((resolve,reject)=>{
    if(typeof indexedDB==='undefined'){reject(Error('IndexedDB unavailable'));return;}
    const request=indexedDB.open(DRAFT_DB,DRAFT_DB_VERSION);
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains(DRAFT_STORE))db.createObjectStore(DRAFT_STORE);
    };
    request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();draftDb=null;};db.onclose=()=>{draftDb=null;};resolve(db);};
    request.onerror=()=>reject(request.error);
    request.onblocked=()=>reject(Error('IndexedDB blocked'));
  });
  draftDb.catch(()=>{draftDb=null;});
  return draftDb;
}
const txDone=(tx:IDBTransaction)=>new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
const reqResult=<T>(request:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});

function enqueuePersist(op:(store:IDBObjectStore)=>void){
  if(typeof indexedDB==='undefined')return;
  writeQueue=writeQueue.then(async()=>{
    try{
      const db=await openDraftDb(),tx=db.transaction(DRAFT_STORE,'readwrite');
      op(tx.objectStore(DRAFT_STORE));
      await txDone(tx);
    }catch{/* Private browsing or storage unavailable: stay in memory. */}
  });
}

/** Hydrates saved composer images/files from IndexedDB before first render so reloads keep attachments intact. */
export async function loadDraftAttachments(timeout=250):Promise<void>{
  if(typeof indexedDB==='undefined')return;
  const read=async()=>{
    const db=await openDraftDb(),tx=db.transaction(DRAFT_STORE,'readonly'),store=tx.objectStore(DRAFT_STORE);
    const [keys,values]=await Promise.all([reqResult(store.getAllKeys()),reqResult(store.getAll())]);
    keys.forEach((rawKey,index)=>{
      const key=String(rawKey),val=values[index] as Partial<StoredAttachments>|undefined;
      if(!val||draftAttachments.has(key))return;
      const images=Array.isArray(val.images)?val.images.filter((item):item is string=>typeof item==='string'):[];
      const files=Array.isArray(val.files)?val.files.filter((item):item is DraftFileAttachment=>Boolean(item&&typeof item==='object'&&typeof item.id==='string'&&typeof item.name==='string')):[];
      if(images.length||files.length)draftAttachments.set(key,{images,files});
    });
    while(draftAttachments.size>MAX_DRAFT_SCOPES)draftAttachments.delete(draftAttachments.keys().next().value!);
  };
  try{await Promise.race([read(),new Promise<void>(resolve=>setTimeout(resolve,timeout))]);}catch{}
}

/** Waits for any queued attachment persistence to finish (called before a hot-deploy page reload). */
export async function flushDraftAttachments(timeout=400):Promise<void>{
  try{await Promise.race([writeQueue,new Promise<void>(resolve=>setTimeout(resolve,timeout))]);}catch{}
}

/** True when any conversation has unsent images or files waiting in the composer. */
export function hasDraftAttachments():boolean{
  for(const entry of draftAttachments.values())if(entry.images.length||entry.files.length)return true;
  return false;
}

export function readDraftAttachments(key?:string):StoredAttachments{
  if(!key)return {images:[],files:[]};
  const saved=draftAttachments.get(key);
  return saved?{images:[...saved.images],files:[...saved.files]}:{images:[],files:[]};
}
export function writeDraftAttachments(key:string|undefined,images:string[],files:DraftFileAttachment[]){
  if(!key)return;
  draftAttachments.delete(key);
  if(!images.length&&!files.length){
    enqueuePersist(store=>store.delete(key));
    return;
  }
  const copy:StoredAttachments={images:[...images],files:[...files]};
  draftAttachments.set(key,copy);
  const evicted:string[]=[];
  while(draftAttachments.size>MAX_DRAFT_SCOPES){
    const oldest=draftAttachments.keys().next().value!;
    draftAttachments.delete(oldest);
    evicted.push(oldest);
  }
  enqueuePersist(store=>{
    store.put(copy,key);
    for(const oldKey of evicted)store.delete(oldKey);
  });
}
export function clearDraftAttachments(key?:string){
  if(key){
    draftAttachments.delete(key);
    enqueuePersist(store=>store.delete(key));
  }else{
    draftAttachments.clear();
    enqueuePersist(store=>store.clear());
  }
}

type Options={
  /** When set, unsent images and files stay under this key across conversation switches and page reloads. */
  draftKey?:string;
  /** Nothing can be added now, e.g. while a message is being sent. */
  disabled:boolean;
  /** Why images cannot be added (the model does not take them); undefined when they can. */
  imagesBlocked?:string;
  /** Shows an error; '' clears the previous one when a new selection starts. */
  notify:(message:string)=>void;
  /** Runs after a selection was added, e.g. to close the menu it came from. */
  added?:()=>void;
};

/**
 * Photos and documents waiting in a composer, shared by Codex, Claude Code and Antigravity.
 * One selection is read at a time: large photos take seconds to compress, and a second selection
 * or a send in the meantime would otherwise work from stale lists. `reset` drops a reading in progress.
 */
export function useComposerAttachments(options:Options){
  const [images,setImageState]=useState<string[]>(()=>readDraftAttachments(options.draftKey).images);
  const [files,setFileState]=useState<DraftFileAttachment[]>(()=>readDraftAttachments(options.draftKey).files);
  const [loading,setLoading]=useState(false);
  const draftKeyRef=useRef(options.draftKey);
  const imagesRef=useRef(images),filesRef=useRef(files),reading=useRef<number|null>(null),sequence=useRef(0);
  const latest=useRef(options);latest.current=options;
  function setImages(next:SetStateAction<string[]>){
    const value=typeof next==='function'?next(imagesRef.current):next;
    imagesRef.current=value;setImageState(value);
    writeDraftAttachments(draftKeyRef.current,value,filesRef.current);
  }
  function setFiles(next:SetStateAction<DraftFileAttachment[]>){
    const value=typeof next==='function'?next(filesRef.current):next;
    filesRef.current=value;setFileState(value);
    writeDraftAttachments(draftKeyRef.current,imagesRef.current,value);
  }
  useEffect(()=>{
    if(draftKeyRef.current===options.draftKey)return;
    draftKeyRef.current=options.draftKey;
    sequence.current++;reading.current=null;setLoading(false);
    const next=readDraftAttachments(options.draftKey);
    imagesRef.current=next.images;filesRef.current=next.files;
    setImageState(next.images);setFileState(next.files);
  },[options.draftKey]);
  async function add(selection:File[]){
    const {disabled,imagesBlocked,notify}=latest.current;
    if(disabled||!selection.length)return;
    if(imagesBlocked&&selection.some(isImageFile)){notify(imagesBlocked);return;}
    if(reading.current!==null){notify('附件正在读取，请稍候');return;}
    const request=++sequence.current;reading.current=request;setLoading(true);notify('');
    try{
      const next=await readAttachmentFiles(selection,imagesRef.current,filesRef.current,()=>request!==sequence.current);
      if(!next||request!==sequence.current)return;
      setImages(next.images);setFiles(next.files);latest.current.added?.();
    }catch(error){if(request===sequence.current)latest.current.notify((error as Error)?.message||'附件读取失败');}
    finally{if(reading.current===request){reading.current=null;setLoading(false);}}
  }
  /** Pasted files and screenshots, or an image pasted as Base64 text, go through the same compression as picked photos. */
  function paste(event:ClipboardEvent<HTMLTextAreaElement>){
    const pasted=clipboardFiles(event.clipboardData);
    if(pasted.length){event.preventDefault();void add(pasted);return;}
    try{const data=pastedImage(event.clipboardData.getData('text/plain'));if(data){event.preventDefault();void add([imageFile(data)]);}}
    catch(error){event.preventDefault();latest.current.notify((error as Error)?.message||'图片读取失败');}
  }
  /**
   * Puts an edited photo (cropped, marked) in place of the one it was made from, compressed within what the other photos leave.
   * Resolves to '' once it is in place, else to what went wrong; the editor shows that and stays open.
   */
  async function replace(original:string,edited:File):Promise<string>{
    if(reading.current!==null)return '附件正在读取，请稍候';
    const request=++sequence.current;reading.current=request;setLoading(true);
    try{
      const others=imagesRef.current.filter(url=>url!==original);
      const [url]=await readImageFiles([edited],MAX_TOTAL_IMAGE_BYTES-others.reduce((sum,image)=>sum+imageBytes(image),0),()=>request!==sequence.current);
      // Another conversation was opened meanwhile: its composer has nothing to replace.
      if(request!==sequence.current)return '';
      const index=imagesRef.current.indexOf(original);
      if(index<0||!url)return '这张图片已不在输入框里';
      const next=[...imagesRef.current];next[index]=url;
      setImages(validateImages(next));
      return '';
    }catch(error){return (error as Error)?.message||'图片保存失败';}
    finally{if(reading.current===request){reading.current=null;setLoading(false);}}
  }
  /** Empties the composer and ignores a selection still being read (another conversation opened). */
  function reset(){sequence.current++;reading.current=null;setLoading(false);setImages([]);setFiles([]);}
  const drop=useFileDrop(dropped=>void add(dropped),options.disabled||loading);
  return {images,files,loading,count:images.length+files.length,add,paste,replace,drop,setImages,setFiles,clear:()=>{setImages([]);setFiles([]);},reset};
}
