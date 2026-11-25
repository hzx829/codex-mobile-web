import {useEffect,useLayoutEffect,useRef,useState,type ChangeEvent,type ReactNode,type RefObject} from 'react';
import {SendMessageButton,submitOnDesktop} from './chat-layout';
import {IconButton} from './icon-button';
import {ImageEditor} from './image-editor';
import {MenuItem} from './sheet';
import {DOCUMENT_ACCEPT,FileAttachments,IMAGE_ACCEPT,ImageAttachments,ReadingStatus,UploadStatus} from './attachment-list';
import {VoiceButton,VoiceStatus,type Voice} from './voice-controls';
import type {UploadProgress} from './file-upload';
import type {useComposerAttachments} from './composer-attachments';
import type {VoiceProvider} from '../src/shared/voice';
import {MAX_ATTACHMENTS} from '../src/shared/attachments';

type Attachments=ReturnType<typeof useComposerAttachments>;

type Props={
  attachments:Attachments;input:RefObject<HTMLTextAreaElement|null>;
  draft:string;edit:(text:string)=>void;placeholder:string;maxLength?:number;readOnly:boolean;submit:()=>void;
  /** Attachments cannot be removed, e.g. while they are being sent. */
  locked:boolean;showImage:(url:string,title:string)=>void;uploadProgress:UploadProgress|null;
  voice:Voice;voiceMode:VoiceProvider;voiceDisabled:boolean;onVoiceStart:()=>void;connected:boolean;
  /** Opens the "+" sheet: attachments, voice settings and the runtime's other options. */
  add:()=>void;addDisabled:boolean;
  /** Left of the model: the permission control, when the runtime has permission levels. */
  permission?:ReactNode;model?:ReactNode;
  /** A turn the phone can stop. With `queue`, a draft can still be sent to wait for it; otherwise only stopping is offered. */
  running?:{stop:()=>void;disabled:boolean;queue:boolean;label?:string};
  send:{label:string;sending:boolean;disabled:boolean};
  /** A guess at the next message, shown in grey while the field is empty; Tab or the hint fills it in. */
  suggestion?:string;
};

/**
 * The composer shared by Codex, Claude Code and Antigravity: attachments and status above the text,
 * then "+", permission and model on the left and microphone, stop and send on the right.
 * A runtime leaves out what it does not support.
 */
export function Composer(props:Props){
  const {attachments,running,send}=props;
  const drafted=Boolean(props.draft.trim()||attachments.count);
  // While a turn runs: stop alone without a draft; stop and "send when done" with one, if the runtime queues.
  const showSend=!running||running.queue&&(drafted||send.sending);
  const suggestion=!props.draft&&!props.readOnly?props.suggestion||'':'';
  const accept=()=>{props.edit(suggestion);props.input.current?.focus();};
  // Text that arrives from outside the textarea (dictation, a restored draft) would throw the caret to the end.
  // Someone correcting an earlier word keeps their place; otherwise the newest text is scrolled into view.
  const field=props.input.current,outside=Boolean(field&&field.value!==props.draft);
  const editing=outside&&document.activeElement===field&&field!.selectionStart<field!.value.length;
  const caret=editing?[field!.selectionStart,field!.selectionEnd] as const:null;
  useLayoutEffect(()=>{if(caret)props.input.current?.setSelectionRange(caret[0],caret[1]);});
  useEffect(()=>{const el=props.input.current;if(el&&outside&&!caret)el.scrollTop=el.scrollHeight;});
  // The photo open in the editor; it closes by itself if the photo leaves the composer (sent, another conversation opened).
  const [photo,setPhoto]=useState<{url:string;label:string}|null>(null);
  const edited=photo&&attachments.images.includes(photo.url)?photo:null;
  // The editor sits outside the form: React events bubble through the component tree, and a file dropped on it is not an attachment.
  return <><form className={`composer ${attachments.count?'with-images':''}${attachments.drop.dragging?' dragging':''}`} onSubmit={e=>{e.preventDefault();props.submit();}} {...attachments.drop.handlers}>
    <ImageAttachments images={attachments.images} disabled={props.locked||attachments.loading} show={props.showImage} edit={(url,label)=>setPhoto({url,label})} remove={index=>attachments.setImages(old=>old.filter((_,i)=>i!==index))}/>
    <FileAttachments files={attachments.files} disabled={props.locked||attachments.loading} remove={index=>attachments.setFiles(old=>old.filter((_,i)=>i!==index))}/>
    <ReadingStatus loading={attachments.loading}/>
    <UploadStatus progress={props.uploadProgress}/>
    <VoiceStatus voice={props.voice} mode={props.voiceMode}/>
    <textarea ref={props.input} aria-label="任务输入" placeholder={suggestion||props.placeholder} value={props.draft} readOnly={props.readOnly} maxLength={props.maxLength} rows={1}
      onPaste={attachments.paste} onChange={e=>props.edit(e.target.value)} onKeyDown={e=>{if(e.key==='Tab'&&!e.shiftKey&&suggestion){e.preventDefault();accept();return;}submitOnDesktop(e,props.submit);}}/>
    {suggestion&&<button type="button" className="composer-suggestion" onClick={accept} aria-label={`填入建议：${suggestion}`}><kbd>Tab</kbd>填入建议</button>}
    <div className="composer-toolbar">
      <IconButton icon="plus" label="添加与选项" className="composer-add" disabled={props.addDisabled} onClick={props.add}/>
      {props.permission}
      {props.model}
      <div className="composer-actions">
        <VoiceButton voice={props.voice} mode={props.voiceMode} connected={props.connected} disabled={props.voiceDisabled} starting={props.onVoiceStart}/>
        {running&&<IconButton icon="stop" label={running.label||'停止当前任务'} className="black round stop" disabled={running.disabled} onClick={running.stop}/>}
        {showSend&&<SendMessageButton sending={send.sending} label={send.label} disabled={send.disabled}/>}
      </div>
    </div>
  </form>
  {edited&&<ImageEditor key={edited.url} src={edited.url} label={edited.label} close={()=>setPhoto(null)}
    save={async file=>{const problem=await attachments.replace(edited.url,file);if(!problem)setPhoto(null);return problem;}}
    remove={()=>{attachments.setImages(old=>old.filter(url=>url!==edited.url));setPhoto(null);}}/>}
  </>;
}

/** Hidden pickers for photos and for documents; separate so the document picker does not offer the camera. */
export function useAttachmentPickers(add:(files:File[])=>void){
  const images=useRef<HTMLInputElement>(null),documents=useRef<HTMLInputElement>(null);
  const change=(event:ChangeEvent<HTMLInputElement>)=>{const chosen=Array.from(event.target.files||[]);event.target.value='';add(chosen);};
  return {
    inputs:<><input className="hidden" ref={images} type="file" accept={IMAGE_ACCEPT} multiple onChange={change}/>
      <input className="hidden" ref={documents} type="file" accept={DOCUMENT_ACCEPT} multiple onChange={change}/></>,
    images:()=>images.current?.click(),documents:()=>documents.current?.click(),
  };
}

type AddProps={
  attachments:Attachments;pick:{images:()=>void;documents:()=>void};
  /** The composer cannot take attachments now (sending, waiting for the computer). */
  disabled:boolean;connected:boolean;
  /** Why photos cannot be added, when the model or the connector does not take them. */
  imagesBlocked?:string;error?:string;
  voiceLabel:string;chooseVoice:()=>void;
  /** Each is offered only when the runtime supports it here. */
  browse?:()=>void;projectFiles?:()=>void;refresh?:()=>void;chooseProject?:()=>void;
};

/** The "+" sheet's items, the same on every runtime; what a runtime cannot do is left out. */
export function AddOptions(props:AddProps){
  const {attachments}=props,full=attachments.count>=MAX_ATTACHMENTS,off=props.disabled||attachments.loading;
  return <>
    <MenuItem icon="image" disabled={off||full||Boolean(props.imagesBlocked)} onClick={props.pick.images}>添加图片<span className="menu-detail">大图自动压缩</span></MenuItem>
    <MenuItem icon="file" disabled={off||full} onClick={props.pick.documents}>添加文件<span className="menu-detail">PDF、Word 等</span></MenuItem>
    <p className="muted">附件 {attachments.count}/{MAX_ATTACHMENTS} · 文件每个最多 100 MiB</p>
    {props.imagesBlocked&&<p className="muted">{props.imagesBlocked}</p>}
    {props.error&&<p className="error" role="alert">{props.error}</p>}
    <MenuItem icon="mic" onClick={props.chooseVoice}>语音输入<span className="menu-detail">{props.voiceLabel}</span></MenuItem>
    {props.browse&&<MenuItem icon="browser" disabled={!props.connected} onClick={props.browse}>打开网页</MenuItem>}
    {props.projectFiles&&<MenuItem icon="file" disabled={!props.connected} onClick={props.projectFiles}>查看项目文件</MenuItem>}
    {props.refresh&&<MenuItem icon="refresh" disabled={!props.connected} onClick={props.refresh}>刷新会话</MenuItem>}
    {props.chooseProject&&<MenuItem icon="folder" disabled={props.disabled} onClick={props.chooseProject}>选择项目</MenuItem>}
  </>;
}
