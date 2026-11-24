import type {FilePreview} from '../src/shared/types';
import type {PreviewSession} from './browser-preview';

export type PreviewTarget =
  | {kind:'file'; machineId:string; threadId:string; path:string; line?:number; file?:FilePreview; error?:string; request:number}
  | {kind:'diff'; threadId:string; turnId:string; text:string}
  | {kind:'image'; url:string; title:string}
  | {kind:'web'; session:PreviewSession}
  | {kind:'site'; machineId:string; threadId:string; url:string}
  | {kind:'artifact'; machineId:string; url:string; title?:string; fresh?:string};

/** claude.ai Artifact pages, which the computer renders and relays; the phone never opens claude.ai itself. */
export function isArtifactUrl(value:string){return /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]{8,64}\/?(?:[?#].*)?$/.test(value);}

/** How a page reaches the phone: rendered on the computer, tunnelled through it, loaded by the phone itself, or not embeddable at all. */
export type PreviewRoute='artifact'|'tunnel'|'direct'|'external';
/** A host on the computer's side of the network, going by its spelling alone; the connector decides what it really relays. */
export function lanHost(hostname:string):boolean {
  const host=hostname.toLowerCase().replace(/\.$/,'');
  if(host.startsWith('['))return /^\[(?:::1\]|f[cd][0-9a-f]{2}:)/.test(host);
  const v4=host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if(v4){const a=Number(v4[1]),b=Number(v4[2]);return a===10||a===127||a===192&&b===168||a===172&&b>=16&&b<=31;}
  return host==='localhost'||host.endsWith('.local')||!host.includes('.');
}
/** `securePage`: this app is served over https, where a plain http page cannot be framed. */
export function previewRoute(address:string,securePage=true):PreviewRoute|null {
  const value=address.trim();
  let url:URL;try{url=new URL(value);}catch{return null;}
  if(url.protocol!=='http:'&&url.protocol!=='https:'||url.username||url.password||!url.hostname)return null;
  if(isArtifactUrl(value))return 'artifact';
  if(lanHost(url.hostname))return 'tunnel';
  return url.protocol==='https:'||!securePage?'direct':'external';
}

export function samePreviewTarget(a:PreviewTarget,b:PreviewTarget):boolean{
  if(a.kind!==b.kind)return false;
  if(a.kind==='file'&&b.kind==='file')return a.machineId===b.machineId&&a.threadId===b.threadId&&a.path===b.path;
  if(a.kind==='diff'&&b.kind==='diff')return a.threadId===b.threadId&&a.turnId===b.turnId;
  if(a.kind==='image'&&b.kind==='image')return a.url===b.url;
  if(a.kind==='site'&&b.kind==='site')return a.machineId===b.machineId&&a.threadId===b.threadId&&a.url===b.url;
  if(a.kind==='artifact'&&b.kind==='artifact')return a.machineId===b.machineId&&a.url===b.url;
  return a.kind==='web'&&b.kind==='web'&&a.session.sessionId===b.session.sessionId;
}

// Keep the URL escaped until fileReference decodes it for the connector.
export function markdownFileUrl(value:string):string|null {
  if(!/^file:/i.test(value))return null;
  try {
    const url=new URL(value);
    if(url.host || url.search || !/^file:\/\/\//i.test(value) && !/^file:\/\/localhost\//i.test(value))return '';
    const path=decodeURIComponent(url.pathname);
    if(/^[\\/]{2}|[\\\0]/.test(path))return '';
    return url.pathname+url.hash;
  }catch{return '';}
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
  if(/^(?:[a-z]:[\\/]|[\\/])/i.test(decoded))return decoded.replace(/^\/(?=[a-z]:[\\/])/i,'');
  const base=documentPath.replace(/\\/g,'/');
  return base.slice(0,base.lastIndexOf('/')+1)+decoded;
}

export function fileViewer(file:FilePreview) {
  // Filename fallback also supports connectors predating PDF metadata.
  if(file.mime==='application/pdf'||/\.pdf$/i.test(file.name))return 'pdf';
  if(file.data!==undefined&&/^image\/(png|jpeg|webp|gif)$/.test(file.mime))return 'image';
  if(/^video\/(mp4|webm|ogg|quicktime)$/.test(file.mime))return 'video';
  if(/\.html?$/i.test(file.name))return 'html';
  if(file.text!==undefined)return /\.(md|markdown|mdown)$/i.test(file.name)?'markdown':'code';
  return 'unsupported';
}
