import {Icon} from './icons';
import {IconButton} from './icon-button';
import type {DraftFileAttachment} from './attachments';
import type {UploadProgress} from './file-upload';

const size=(bytes:number)=>bytes>=1024*1024?`${(bytes/1024/1024).toFixed(1)} MiB`:`${Math.max(1,Math.ceil(bytes/1024))} KiB`;

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
/** One picker for photos and documents; the phone offers its photo library and files. */
export const ATTACHMENT_ACCEPT='image/png,image/jpeg,image/webp,application/*,text/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.json,.xml,.zip';
