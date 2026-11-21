import {useRef,useState,type ClipboardEvent,type SetStateAction} from 'react';
import {clipboardFiles,imageFile,isImageFile,pastedImage,readAttachmentFiles,type DraftFileAttachment} from './attachments';
import {useFileDrop} from './file-drop';

type Options={
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
  const [images,setImageState]=useState<string[]>([]),[files,setFileState]=useState<DraftFileAttachment[]>([]),[loading,setLoading]=useState(false);
  const imagesRef=useRef(images),filesRef=useRef(files),reading=useRef<number|null>(null),sequence=useRef(0);
  const latest=useRef(options);latest.current=options;
  function setImages(next:SetStateAction<string[]>){const value=typeof next==='function'?next(imagesRef.current):next;imagesRef.current=value;setImageState(value);}
  function setFiles(next:SetStateAction<DraftFileAttachment[]>){const value=typeof next==='function'?next(filesRef.current):next;filesRef.current=value;setFileState(value);}
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
  /** Empties the composer and ignores a selection still being read (another conversation opened). */
  function reset(){sequence.current++;reading.current=null;setLoading(false);setImages([]);setFiles([]);}
  const drop=useFileDrop(dropped=>void add(dropped),options.disabled||loading);
  return {images,files,loading,count:images.length+files.length,add,paste,drop,setImages,setFiles,clear:()=>{setImages([]);setFiles([]);},reset};
}
