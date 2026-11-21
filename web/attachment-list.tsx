import {Icon} from './icons';
import {IconButton} from './icon-button';
import type {DraftFileAttachment} from './attachments';
import type {UploadProgress} from './file-upload';
import {MAX_IMAGES} from '../src/shared/images';

const size=(bytes:number)=>bytes>=1024*1024?`${(bytes/1024/1024).toFixed(1)} MiB`:`${Math.max(1,Math.ceil(bytes/1024))} KiB`;

/** Photos waiting in a composer: tap one to view it, or remove it until it is sent. */
export function ImageAttachments({images,disabled,show,remove}:{images:string[];disabled:boolean;show:(url:string,title:string)=>void;remove:(index:number)=>void}){
  if(!images.length)return null;
  return <div className="image-strip"><span className="attachment-count" role="status">图片 {images.length}/{MAX_IMAGES}</span><div className="attachment-thumbnails">{images.map((url,i)=><div className="attachment-thumb" key={i}>
    <button type="button" aria-label={`查看第 ${i+1} 张图片，共 ${images.length} 张`} onClick={()=>show(url,`待发送图片 ${i+1}/${images.length}`)}><img src={url} alt={`待发送图片 ${i+1}`} decoding="async"/></button>
    <button className="attachment-remove" type="button" disabled={disabled} aria-label={`移除第 ${i+1} 张图片`} onClick={()=>remove(i)}><Icon name="close" size={14}/></button></div>)}</div></div>;
}
/** Shown while a selection is read and large photos are compressed. */
export function ReadingStatus({loading}:{loading:boolean}){
  return loading?<span className="attachment-count" role="status">正在处理附件，大图会自动压缩…</span>:null;
}

/** Documents waiting in a composer, each removable until it is sent. */
export function FileAttachments({files,disabled,remove}:{files:DraftFileAttachment[];disabled:boolean;remove:(index:number)=>void}){
  if(!files.length)return null;
  return <div className="file-attachments">{files.map((file,i)=><div className="file-attachment" key={file.id}><Icon name="file" size={18}/>
    <span title={file.name}>{file.name}<small>{size(file.size)}</small></span>
    <IconButton icon="close" label={`移除 ${file.name}`} disabled={disabled} onClick={()=>remove(i)}/></div>)}</div>;
}
export function UploadStatus({progress}:{progress:UploadProgress|null}){
  if(!progress)return null;
  return <div className="upload-progress" role="status"><span>正在上传 {progress.index}/{progress.count} · {Math.floor(progress.loaded/progress.size*100)}% · {progress.name}</span>
    <progress value={progress.loaded} max={progress.size} aria-label={`正在上传 ${progress.name}`}/></div>;
}
export const IMAGE_ACCEPT='image/png,image/jpeg,image/webp';
/** Document types only, so phones do not offer the camera for this picker. */
export const DOCUMENT_ACCEPT='application/*,text/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.json,.xml,.zip';
