import {open, realpath} from 'node:fs/promises';
import {basename, dirname, extname, isAbsolute, relative, resolve, sep} from 'node:path';
import {BridgeError, textRequired} from '../shared/types.js';
import {assertInsideWorkspace} from './project.js';

const assetTypes: Record<string,string> = {
  '.css':'text/css', '.js':'text/javascript', '.mjs':'text/javascript',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.gif':'image/gif', '.svg':'image/svg+xml', '.avif':'image/avif', '.ico':'image/x-icon',
  '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf', '.otf':'font/otf',
  '.mp4':'video/mp4', '.webm':'video/webm', '.mp3':'audio/mpeg', '.wav':'audio/wav',
};
const isHtml = (path:string) => /\.html?$/i.test(path);
const missing = () => new BridgeError('not_found','网页文件不存在或超出预览目录');

export async function htmlEntry(value:unknown) {
  const path = textRequired(value,'网页文件路径',4096);
  if (!isAbsolute(path) || /^[\\/]{2}/.test(path) || !isHtml(path)) throw missing();
  assertInsideWorkspace(path);
  const entry = await realpath(path).catch(() => {throw missing();});
  assertInsideWorkspace(entry);
  if (!isHtml(entry)) throw missing();
  return entry;
}

// The tunnel serves exactly the chosen document and static assets beneath its directory.
export async function openHtmlResource(entry:string, pathname:string) {
  const root = dirname(entry);
  const parts = decodeURIComponent(pathname).slice(1).split('/');
  if (parts.some(part => !part || part.startsWith('.') || /[\\:\0]/.test(part))) throw missing();
  const target = await realpath(resolve(root,...parts));
  assertInsideWorkspace(target);
  const within = relative(root,target);
  if (isAbsolute(within) || within.split(sep).some(part=>part.startsWith('.'))) throw missing();
  const mime = target === entry ? 'text/html; charset=utf-8' : assetTypes[extname(target).toLowerCase()];
  if (!mime) throw missing();
  const file = await open(target,'r');
  try {
    const info = await file.stat();
    if (!info.isFile()) throw missing();
    return {file, size:info.size, mime};
  } catch (error) {await file.close(); throw error;}
}

export function htmlEntryUrl(entry:string) {
  return new URL('/'+encodeURIComponent(basename(entry)), 'http://localhost').toString();
}
