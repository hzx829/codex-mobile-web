import {createHash} from 'node:crypto';
import {mkdirSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync, renameSync, existsSync} from 'node:fs';
import {open, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {BridgeError, type Json} from '../shared/types.js';
import {FileStream} from './project.js';

/**
 * Images by content (docs/sync/DESIGN.md §8). Synced messages carry `cmw-image:<sha256>` instead of the image's data URL,
 * and phones load it once through the relay's data channel; the same image is never sent twice. Images come from the
 * sessions' own records or from what a phone uploads to send. Oldest-used images go first beyond {@link LIMIT}.
 */
export const IMAGE_REF = 'cmw-image:';
const LIMIT = 500 * 1024 * 1024;
const TYPES: Record<string, string> = {png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif'};
const EXTENSION = Object.fromEntries(Object.entries(TYPES).map(([extension, mime]) => [mime, extension]));

export const imageRef = (sha: string) => IMAGE_REF + sha;
export const isImageRef = (value: unknown): value is string => typeof value === 'string' && /^cmw-image:[a-f0-9]{64}$/.test(value);

export class BlobStore {
  private known = new Map<string, string>();
  private size = 0;
  constructor(private dir: string, private limit = LIMIT) {
    mkdirSync(dir, {recursive: true});
    for (const name of readdirSync(dir)) {
      const match = /^([a-f0-9]{64})\.(\w+)$/.exec(name);
      if (!match || !TYPES[match[2]]) continue;
      this.known.set(match[1], name);this.size += statSync(join(dir, name)).size;
    }
  }

  /** Keeps an image given as a data URL and returns its reference; anything else is returned as it was. */
  putDataUrl(url: string): string {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/s.exec(url);
    if (!match) return url;
    return imageRef(this.put(Buffer.from(match[2], 'base64'), match[1]));
  }
  /** Keeps image bytes and returns their SHA-256. */
  put(bytes: Buffer, mime: string): string {
    const extension = EXTENSION[mime];
    if (!extension || !bytes.length) throw new BridgeError('invalid', '只能保存 PNG、JPEG、WebP 或 GIF 图片');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const known = this.known.get(sha);
    if (known) {this.touch(known);return sha;}
    const name = `${sha}.${extension}`, temporary = join(this.dir, `${name}.${process.pid}.tmp`);
    writeFileSync(temporary, bytes);renameSync(temporary, join(this.dir, name));
    this.known.set(sha, name);this.size += bytes.length;
    this.trim();
    return sha;
  }
  /** The image for a download through the data channel. */
  async open(sha: unknown): Promise<FileStream> {
    const name = typeof sha === 'string' ? this.known.get(sha) : undefined;
    if (!name) throw new BridgeError('not_found', '图片已不在电脑上，请刷新会话');
    const handle = await open(join(this.dir, name), 'r');
    const size = (await handle.stat()).size;
    this.touch(name);
    return new FileStream(handle, size, 0, Math.max(0, size - 1), name, TYPES[name.split('.')[1]]);
  }
  /** An image reference as the data URL the runtimes take (a phone sends references to images it uploaded). */
  async dataUrl(ref: string): Promise<string> {
    const name = this.known.get(ref.slice(IMAGE_REF.length));
    if (!name) throw new BridgeError('changed', '图片已不在电脑上，请重新添加');
    this.touch(name);
    return `data:${TYPES[name.split('.')[1]]};base64,${(await readFile(join(this.dir, name))).toString('base64')}`;
  }
  /** `images` with references read back to data URLs; other values as they were. */
  async resolve(images: unknown): Promise<unknown> {
    if (!Array.isArray(images) || !images.some(isImageRef)) return images;
    return Promise.all(images.map(image => isImageRef(image) ? this.dataUrl(image) : image));
  }

  private touch(name: string) {try {const now = new Date();utimesSync(join(this.dir, name), now, now);} catch { /* Still served; it only ages sooner. */ }}
  private trim() {
    if (this.size <= this.limit) return;
    const files = [...this.known.entries()].map(([sha, name]) => {try {const info = statSync(join(this.dir, name));return {sha, name, size: info.size, used: info.mtimeMs};} catch {return {sha, name, size: 0, used: 0};}})
      .sort((a, b) => a.used - b.used);
    for (const file of files) {
      if (this.size <= this.limit * 0.9) break;
      try {if (existsSync(join(this.dir, file.name))) unlinkSync(join(this.dir, file.name));} catch {continue;}
      this.known.delete(file.sha);this.size -= file.size;
    }
  }
}

/** A turn-shaped entry with its images as references; the same object when it has no data URL images. */
export function withImageRefs(store: BlobStore, entry: Json): Json {
  if (!Array.isArray(entry.items) || !entry.items.some((item: Json) => item.images?.some((url: unknown) => typeof url === 'string' && url.startsWith('data:')))) return entry;
  const ref = (url: string) => {try {return store.putDataUrl(url);} catch {return url;}};
  return {...entry, items: entry.items.map((item: Json) => item.images?.length ? {...item, images: item.images.map(ref)} : item)};
}
