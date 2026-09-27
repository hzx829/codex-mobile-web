import type {FilePreview} from '../src/shared/types';
import type {PreviewSession} from './browser-preview';

export type PreviewTarget =
  | {kind:'file'; machineId:string; threadId:string; path:string; line?:number; file?:FilePreview; error?:string; request:number}
  | {kind:'diff'; threadId:string; turnId:string; text:string}
  | {kind:'image'; url:string; title:string}
  | {kind:'web'; session:PreviewSession};

export function samePreviewTarget(a:PreviewTarget,b:PreviewTarget):boolean{
  if(a.kind!==b.kind)return false;
  if(a.kind==='file'&&b.kind==='file')return a.machineId===b.machineId&&a.threadId===b.threadId&&a.path===b.path;
  if(a.kind==='diff'&&b.kind==='diff')return a.threadId===b.threadId&&a.turnId===b.turnId;
  if(a.kind==='image'&&b.kind==='image')return a.url===b.url;
  return a.kind==='web'&&b.kind==='web'&&a.session.sessionId===b.session.sessionId;
}

export function fileReference(value:string):{path:string;line?:number} {
  let path=value;
  try{path=decodeURIComponent(value);}catch{}
  // Codex file links use /C:/... in Markdown; the filesystem needs C:/....
  path=path.replace(/^\/(?=[a-z]:[\\/])/i,'');
  const match=path.match(/(?::(\d+)(?::\d+)?|#L(\d+)(?:C\d+)?(?:-L?\d+)?)$/i);
  return {path:match?path.slice(0,match.index):path,...(match?{line:Math.max(1,Number(match[1]||match[2]))}:{})};
}

export function localDocumentLink(href:string,documentPath:string):string|null {
  if(!href||href.startsWith('#'))return null;
  let decoded=href;try{decoded=decodeURIComponent(href);}catch{}
  if(/^[\\/]{2}/.test(decoded))return null;
  if(/^[a-z][a-z\d+.-]*:/i.test(decoded)&&!/^[a-z]:[\\/]/i.test(decoded))return null;
  if(/^(?:[a-z]:[\\/]|[\\/])/i.test(decoded))return decoded;
  const base=documentPath.replace(/\\/g,'/');
  return base.slice(0,base.lastIndexOf('/')+1)+decoded;
}

export function fileViewer(file:FilePreview) {
  if(file.data!==undefined&&/^image\/(png|jpeg|webp|gif)$/.test(file.mime))return 'image';
  if(/^video\/(mp4|webm|ogg|quicktime)$/.test(file.mime))return 'video';
  if(file.text!==undefined)return /\.(md|markdown|mdown)$/i.test(file.name)?'markdown':'code';
  return 'unsupported';
}
