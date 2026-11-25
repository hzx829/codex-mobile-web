import {useEffect,useRef,useState,type ClipboardEvent,type SetStateAction} from 'react';
import {clipboardFiles,imageFile,isImageFile,pastedImage,readAttachmentFiles,readImageFiles,type DraftFileAttachment} from './attachments';
import {useFileDrop} from './file-drop';
import {MAX_TOTAL_IMAGE_BYTES,imageBytes,validateImages} from '../src/shared/images';

type StoredAttachments={images:string[];files:DraftFileAttachment[]};
const draftAttachments=new Map<string,StoredAttachments>();
const MAX_DRAFT_SCOPES=32;

export function readDraftAttachments(key?:string):StoredAttachments{
  if(!key)return {images:[],files:[]};
  const saved=draftAttachments.get(key);
  return saved?{images:[...saved.images],files:[...saved.files]}:{images:[],files:[]};
}
export function writeDraftAttachments(key:string|undefined,images:string[],files:DraftFileAttachment[]){
  if(!key)return;
  draftAttachments.delete(key);
  if(!images.length&&!files.length)return;
  draftAttachments.set(key,{images:[...images],files:[...files]});
  while(draftAttachments.size>MAX_DRAFT_SCOPES)draftAttachments.delete(draftAttachments.keys().next().value!);
}
export function clearDraftAttachments(key?:string){
  if(key)draftAttachments.delete(key);
  else draftAttachments.clear();
}

type Options={
  /** When set, unsent images and files stay in memory under this key across conversation switches. */
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
