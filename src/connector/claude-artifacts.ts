import {execFile, spawn, type ChildProcess} from 'node:child_process';
import {existsSync} from 'node:fs';
import {lstat, mkdir, open as openFile, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {WebSocket} from 'ws';
import {BridgeError, type Json} from '../shared/types.js';
import {downloadProjectFile, readProjectFile} from './project.js';

/**
 * Views claude.ai Artifacts on the phone without the phone reaching claude.ai.
 *
 * The connector keeps its own browser profile on the computer, signed in to claude.ai once.
 * It opens the Artifact there, waits for it to render, and saves a static copy of what it shows:
 * the page's DOM with its styles, images and fonts inlined and every script removed. The phone
 * downloads that file over the relay and shows it in a sandboxed frame.
 *
 * Signing in happens in that same profile, either at the computer (the connector puts a sign-in window on its
 * screen) or from the phone, which sees screenshots of the computer's browser and sends taps, text and keys to it.
 * The connector never reads another browser's profile: those are locked while that browser runs, and Chrome
 * refuses remote debugging on its default profile.
 */

const ARTIFACT = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9_-]{8,64})\/?(?:[?#].*)?$/;
export function artifactSlug(value: unknown) {
  const slug = typeof value === 'string' && value.length < 300 ? ARTIFACT.exec(value)?.[1] : undefined;
  if (!slug) throw new BridgeError('invalid', '只能打开 claude.ai 的 Artifact 链接');
  return slug;
}
const FRAME_HOST = /\.frame\.claudeusercontent\.com$/;
const SITE = 'https://claude.ai';
/** claude.ai's session cookie; `sessionKeyV3` and the like are taken as the same thing under a newer name. */
const SESSION_COOKIE = /^sessionKey(?:V\d+)?$/;
/** Pages of the sign-in itself: being on one means sign-in is not finished, whatever cookies are there. */
const SIGN_IN_PATH = /^\/(?:login|magic-link|sso-callback|oauth)(?:\/|$)/;
const CHALLENGE = 'claude.ai 要求先通过 Cloudflare 人机验证。被程序控制的浏览器过不了这一步，需要在电脑屏幕上的窗口里用鼠标完成。';
/** Links from claude.ai's sign-in email, which may be opened in the connector's browser. */
const SIGN_IN_LINK = /^https:\/\/(?:[a-z0-9-]+\.)*(?:claude\.ai|anthropic\.com)\//i;
/**
 * What claude.ai's sign-in page shows, read from its markup: the active step (`email`, `sent`, `code`,
 * `second_factor`), the first visible alert, whether a human check is up, and whether a remembered account stands in
 * front of the email box.
 */
const LOGIN_STATE = `(() => {
  const shown = el => !!el && !el.closest('[hidden]') && el.getClientRects().length > 0;
  const active = [...document.querySelectorAll('.si-step[data-active]')].find(shown);
  const alert = [...document.querySelectorAll('[role=alert], cds-field-error')].filter(el => shown(el) && el.textContent.trim()).map(el => el.textContent.trim())[0] || '';
  // claude.ai keeps hCaptcha frames in the page, clipped to nothing; one counts only where it can be seen and clicked.
  const onTop = f => {
    if (f.closest('[inert],[aria-hidden="true"]') || getComputedStyle(f).visibility === 'hidden') return false;
    const r = f.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    return r.width > 100 && r.height > 60 && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && document.elementFromPoint(x, y) === f;
  };
  const challenge = [...document.querySelectorAll('iframe')].some(f => /hcaptcha/.test(f.src) && onTop(f));
  const cloudflare = /^(Just a moment|请稍候)/.test(document.title) || /challenge|cdn-cgi/.test(location.pathname);
  return {host: location.hostname, path: location.pathname, title: document.title, step: active ? active.getAttribute('data-step') : '', alert, challenge, cloudflare,
    email: shown(document.querySelector('#email')), another: shown(document.querySelector('[data-testid=login-use-another-account]'))};
})()`;
const DEFAULT_TITLE = 'claude.ai 页面';
const MAX_RESOURCE = 8 * 1024 * 1024, MAX_TOTAL = 40 * 1024 * 1024;

export function findBrowser(env = process.env, exists = existsSync): string | undefined {
  if (env.CLAUDE_ARTIFACT_BROWSER) return env.CLAUDE_ARTIFACT_BROWSER;
  const pf = env['ProgramFiles'] || 'C:\\Program Files', pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', local = env.LOCALAPPDATA || '';
  // Chrome first, as the browser most people already use; Edge is there on every Windows computer.
  const candidates = process.platform === 'win32' ? [
    join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ...(local ? [join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
    join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return candidates.find(path => exists(path));
}
/**
 * Each browser keeps its own profile folder: a profile is encrypted for the browser that made it, so one made by Edge
 * cannot be handed to Chrome. Edge keeps the folder's first name, so computers already signed in with it stay signed in.
 */
export function profileFolder(executable: string) {
  return /msedge|microsoft[ -]edge/i.test(executable) ? 'claude-browser' : 'claude-browser-chrome';
}

/**
 * Whether a browser has this profile open. On Windows it holds the profile's `lockfile` for as long as it runs;
 * elsewhere it keeps a `SingletonLock` link.
 */
export async function profileInUse(profile: string) {
  if (process.platform !== 'win32') return lstat(join(profile, 'SingletonLock')).then(() => true, () => false);
  const file = join(profile, 'lockfile');
  if (!existsSync(file)) return false;
  try {const handle = await openFile(file, 'r+');await handle.close();return false;}
  catch (error) {return ['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '');}
}

const run = promisify(execFile);
/** The title of a process's main window (Windows), read without touching the browser itself. */
export async function windowTitle(pid: number): Promise<string> {
  if (process.platform !== 'win32') return '';
  try {
    const {stdout} = await run('tasklist', ['/v', '/fo', 'csv', '/nh', '/fi', `PID eq ${pid}`], {windowsHide: true, timeout: 5000});
    const fields = stdout.trim().match(/"[^"]*"/g);
    return fields ? fields[fields.length - 1].slice(1, -1) : '';
  } catch {return '';}
}
/**
 * Whether a window title shows claude.ai's app rather than its sign-in or Cloudflare's check. The app names itself
 * "… - Claude" ("新建对话 - Claude - Google Chrome"); sign-in pages end in "| Claude.ai" and the check says "请稍候…".
 * Only the ASCII parts are relied on, as the title may arrive in another code page.
 */
export const appTitle = (title: string) => /(^|\s-\s)Claude(\s-\s|$)/.test(title) && !/Claude\.ai/i.test(title);

type Message = {id?: number; method?: string; params?: Json; result?: Json; error?: {message?: string}; sessionId?: string};
/** A minimal Chrome DevTools Protocol client over one browser-level WebSocket, with flattened sessions. */
export class Cdp {
  private id = 0;
  private waits = new Map<number, {resolve: (value: Json) => void; reject: (error: Error) => void; timer: NodeJS.Timeout}>();
  private listeners = new Set<(message: Message) => void>();
  closed = false;
  private constructor(private socket: WebSocket) {
    socket.on('message', data => {
      let message: Message;
      try {message = JSON.parse(String(data));} catch {return;}
      const wait = message.id ? this.waits.get(message.id) : undefined;
      if (wait) {
        this.waits.delete(message.id!);clearTimeout(wait.timer);
        if (message.error) wait.reject(new Error(message.error.message || 'CDP error'));else wait.resolve(message.result || {});
      } else for (const listener of this.listeners) listener(message);
    });
    socket.on('close', () => {
      this.closed = true;
      for (const wait of this.waits.values()) {clearTimeout(wait.timer);wait.reject(new Error('浏览器已关闭'));}
      this.waits.clear();
    });
    socket.on('error', () => {});
  }
  static connect(url: string) {
    return new Promise<Cdp>((resolve, reject) => {
      const socket = new WebSocket(url, {perMessageDeflate: false, maxPayload: 512 * 1024 * 1024});
      socket.once('open', () => resolve(new Cdp(socket)));
      socket.once('error', reject);
    });
  }
  send(method: string, params: Json = {}, sessionId?: string, timeout = 30_000): Promise<Json> {
    if (this.closed) return Promise.reject(new Error('浏览器已关闭'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {this.waits.delete(id);reject(new Error(`${method} 超时`));}, timeout);
      this.waits.set(id, {resolve, reject, timer});
      this.socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
    });
  }
  on(listener: (message: Message) => void) {this.listeners.add(listener);return () => {this.listeners.delete(listener);};}
  close() {try {this.socket.close();} catch {}}
}

type Browser = {process: ChildProcess; pid?: number; cdp: Cdp; userAgent: string; visible: boolean};
function running(pid?: number) {
  if (!pid) return false;
  try {process.kill(pid, 0);return true;} catch {return false;}
}
type Frame = {sessionId: string; frameId: string; url: string};
type Serialized = {html: string; resources: string[]; frames: {src: string; name: string}[]};
/** `challenge`: Cloudflare wants a person to pass its check, which only the window on the computer's screen can do. */
export type Snapshot = {state: 'ready'; slug: string; title: string; at: number; file: Json} | {state: 'login'} | {state: 'challenge'} | {state: 'rendering'};

/**
 * Serializer evaluated inside each frame (in an isolated world, so the page's scripts cannot see it).
 * Returns the frame's DOM as static HTML. Resource URLs become `cmw-resource:N` placeholders that the
 * connector fills from the browser's cache; child frames become `<iframe data-cmw-frame=N>` filled the same way.
 */
const SERIALIZER = String.raw`(async () => {
  const resources = [], frames = [], index = new Map();
  const resource = (value, base) => {
    if (!value || /^(data|blob|about|javascript):/i.test(value.trim())) return /^data:/i.test(value.trim()) ? value : '';
    let url; try { url = new URL(value, base || document.baseURI).href; } catch { return ''; }
    if (!/^https?:/.test(url)) return '';
    if (!index.has(url)) { index.set(url, resources.length); resources.push(url); }
    return 'cmw-resource:' + index.get(url);
  };
  const css = (text, base) => text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (_, q, u) => 'url("' + resource(u, base) + '")');
  const rules = (sheet, depth = 0) => {
    let out = '';
    try {
      for (const rule of sheet.cssRules) {
        if (rule.styleSheet && depth < 4) out += rules(rule.styleSheet, depth + 1);
        else out += css(rule.cssText, sheet.href || document.baseURI) + '\n';
      }
    } catch { return null; }
    return out;
  };
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const attr = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const voids = new Set(['area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr']);
  const drop = new Set(['script','noscript','template','base','object','embed','applet','frame','frameset','portal']);
  const urlAttrs = new Set(['src','href','xlink:href','poster','background','action','formaction','data']);
  const adopted = root => [...(root.adoptedStyleSheets || [])].map(s => '<style>' + esc(rules(s) || '') + '</style>').join('');
  const children = async (n) => { let out = ''; for (const c of n.childNodes) out += await node(c); return out; };
  async function node(n) {
    if (n.nodeType === 3) return n.parentNode && n.parentNode.nodeName.toLowerCase() === 'style' ? '' : esc(n.data);
    if (n.nodeType !== 1) return '';
    const tag = n.localName, name = n.tagName.toLowerCase().includes(':') ? n.tagName : tag;
    if (drop.has(tag)) return '';
    if (tag === 'link') {
      if (!/(^|\s)stylesheet(\s|$)/i.test(n.rel) || !n.sheet) return n.sheet === null && /(^|\s)stylesheet(\s|$)/i.test(n.rel) && n.href ? '<style data-cmw-sheet="' + resource(n.href) + '"></style>' : '';
      const text = rules(n.sheet);
      return text === null ? '<style data-cmw-sheet="' + resource(n.href) + '"></style>' : '<style>' + esc(text) + '</style>';
    }
    if (tag === 'meta') return n.getAttribute('charset') || n.getAttribute('name') === 'viewport' ? '' : '';
    if (tag === 'style') { const text = (n.sheet && rules(n.sheet)) ?? css(n.textContent || '', document.baseURI); return '<style>' + esc(text) + '</style>'; }
    if (tag === 'canvas') {
      let src = ''; try { src = n.toDataURL('image/png'); } catch {}
      const box = n.getBoundingClientRect();
      return '<img src="' + attr(src) + '" style="' + attr((n.getAttribute('style') || '') + ';width:' + box.width + 'px;height:' + box.height + 'px') + '"' + (n.className ? ' class="' + attr(String(n.className.baseVal ?? n.className)) + '"' : '') + '>';
    }
    if (tag === 'iframe') {
      const box = n.getBoundingClientRect();
      frames.push({src: n.src || (n.srcdoc ? 'about:srcdoc' : 'about:blank'), name: n.name || ''});
      return '<iframe data-cmw-frame="' + (frames.length - 1) + '" sandbox="allow-popups allow-popups-to-escape-sandbox" style="' + attr((n.getAttribute('style') || '') + ';width:' + box.width + 'px;height:' + box.height + 'px;border:0') + '"' + (n.className ? ' class="' + attr(String(n.className)) + '"' : '') + '></iframe>';
    }
    let out = '<' + name;
    for (const a of n.attributes) {
      const key = a.name.toLowerCase();
      if (key.startsWith('on') || key === 'srcset' || key === 'nonce' || key === 'integrity' || key === 'autofocus') continue;
      let value = a.value;
      if (key === 'style') value = css(value, document.baseURI);
      else if (urlAttrs.has(key)) {
        if (/^\s*javascript:/i.test(value)) continue;
        if (tag === 'a' || tag === 'area' || key === 'action' || key === 'formaction') {
          if (value.startsWith('#')) { out += ' ' + a.name + '="' + attr(value) + '"'; continue; }
          try { value = new URL(value, document.baseURI).href; } catch { continue; }
        } else value = resource(value);
      }
      out += ' ' + a.name + '="' + attr(value) + '"';
    }
    if (tag === 'a') out += ' target="_blank" rel="noopener noreferrer"';
    if (tag === 'input') {
      if (n.type === 'checkbox' || n.type === 'radio') { if (n.checked) out += ' checked'; }
      else if (n.type !== 'password' && n.type !== 'file') out += ' value="' + attr(n.value) + '"';
    }
    if (tag === 'option' && n.selected) out += ' selected';
    if (tag === 'details' && n.open && !n.hasAttribute('open')) out += ' open';
    out += '>';
    if (voids.has(tag)) return out;
    if (n.shadowRoot) out += '<template shadowrootmode="open">' + adopted(n.shadowRoot) + await children(n.shadowRoot) + '</template>';
    if (tag === 'textarea') out += esc(n.value);
    else out += await children(n);
    return out + '</' + name + '>';
  }
  const root = document.documentElement;
  let html = '<!doctype html>' + await node(root);
  const head = adopted(document);
  if (head) html = html.replace(/<head([^>]*)>/i, m => m + head);
  return {html, resources, frames, title: document.title};
})()`;

const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:";
const mimeOf = (url: string, type = '') => {
  const known: Record<string, string> = {Image: 'image/png', Font: 'font/woff2', Stylesheet: 'text/css'};
  const ext: Record<string, string> = {png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
    woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', css: 'text/css', mp4: 'video/mp4', webm: 'video/webm'};
  const match = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
  return (match && ext[match]) || known[type] || 'application/octet-stream';
};
const textMime = (mime: string) => mime === 'text/css' || mime === 'image/svg+xml';

export class ArtifactViewer {
  private browser?: Promise<Browser>;
  private idle?: NodeJS.Timeout;
  private jobs = new Map<string, Promise<Snapshot>>();
  private login?: {targetId: string; sessionId: string; width: number; height: number};
  /** The sign-in window on the computer's own screen. */
  private desk?: {child: ChildProcess};
  private visible = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private dataDir: string, private executable = () => findBrowser(), private frameHost = FRAME_HOST,
    private idleMs = 3 * 60_000, private now = Date.now, private site = SITE) {}
  private get loginUrl() {return `${this.site}/login`;}
  private get siteHost() {return new URL(this.site).hostname;}
  private onSite(host: unknown) {const site = this.siteHost;return host === site || String(host).replace(/^\./, '') === site || String(host).endsWith(`.${site}`);}
  private snapshots(slug: string) {return join(this.dataDir, 'claude-artifacts', slug);}

  private launch(visible: boolean): Promise<Browser> {
    return (async () => {
      const exe = this.executable();
      if (!exe) throw new BridgeError('unavailable', '电脑上没有找到 Edge 或 Chrome，无法中转 claude.ai 页面。可在连接器环境变量 CLAUDE_ARTIFACT_BROWSER 指定浏览器。');
      const profile = join(this.dataDir, profileFolder(exe));
      if (await profileInUse(profile)) throw new BridgeError('busy', '电脑屏幕上的 claude.ai 窗口还开着，请先在那里完成登录。');
      await mkdir(profile, {recursive: true});
      const portFile = join(profile, 'DevToolsActivePort');
      await rm(portFile, {force: true});
      const child = spawn(exe, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-first-run',
        '--no-default-browser-check', '--disable-sync', '--hide-crash-restore-bubble', '--mute-audio',
        ...(visible ? ['--window-position=-32000,-32000', '--window-size=1200,900'] : ['--headless=new']), 'about:blank'], {stdio: 'ignore', windowsHide: !visible});
      child.on('error', () => {});
      // msedge.exe on Windows can be a launcher that hands the browser to another process and exits with 0,
      // so only a failed exit ends the wait, and the browser's own process id is asked from the browser.
      let port = '';
      for (let i = 0; i < 150 && !port; i++) {
        await delay(100);
        port = await readFile(portFile, 'utf8').catch(() => '');
        if (child.exitCode) break;
      }
      const [number, path] = port.trim().split(/\r?\n/);
      if (!number || !path) {child.kill();throw new BridgeError('unavailable', '电脑上的中转浏览器没有启动。如果它已经在运行，请关闭后重试。');}
      const cdp = await Cdp.connect(`ws://127.0.0.1:${number}${path}`);
      const [{userAgent = ''}, {processInfo = []}] = await Promise.all([cdp.send('Browser.getVersion'), cdp.send('SystemInfo.getProcessInfo').catch((): Json => ({}))]);
      const pid = (processInfo as Json[]).find(info => info.type === 'browser')?.id;
      return {process: child, pid: typeof pid === 'number' ? pid : child.pid, cdp, visible, userAgent: String(userAgent).replace('HeadlessChrome', 'Chrome').replace('HeadlessEdg', 'Edg')};
    })();
  }

  private async open(visible = this.visible): Promise<Browser> {
    clearTimeout(this.idle);
    if (this.browser) {
      const current = await this.browser.catch(() => undefined);
      if (current && !current.cdp.closed && current.visible === visible) return current;
      // The next browser uses the same profile, so the old one must be gone first.
      if (current) await this.stop(current);
    }
    this.browser = this.launch(visible);
    this.browser.catch(() => {this.browser = undefined;});
    return this.browser;
  }
  /** Closes the browser, and ends its process if it has not exited within two seconds. */
  private async stop(browser: Browser) {
    this.browser = undefined;this.login = undefined;
    await browser.cdp.send('Browser.close', {}, undefined, 2000).catch(() => {});
    for (let i = 0; i < 20 && running(browser.pid); i++) await delay(100);
    browser.cdp.close();
    if (running(browser.pid)) try {process.kill(browser.pid!);} catch {}
    if (browser.process.exitCode === null) browser.process.kill();
  }
  private rest() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (this.jobs.size || this.login || this.desk) return this.rest();
      void this.browser?.then(browser => this.stop(browser), () => {});
    }, this.idleMs);
    this.idle.unref?.();
  }
  /** Runs browser work one piece at a time, so a sign-in and a capture never fight over the profile. */
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  private async tab(browser: Browser, width: number, height: number, dark = false, scale = 2) {
    const {targetId} = await browser.cdp.send('Target.createTarget', {url: 'about:blank'});
    const {sessionId} = await browser.cdp.send('Target.attachToTarget', {targetId, flatten: true});
    const mobile = width < 700;
    await Promise.all([
      browser.cdp.send('Network.setUserAgentOverride', {userAgent: browser.userAgent}, sessionId),
      browser.cdp.send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: scale, mobile}, sessionId),
      browser.cdp.send('Emulation.setEmulatedMedia', {features: [{name: 'prefers-color-scheme', value: dark ? 'dark' : 'light'}]}, sessionId),
      browser.cdp.send('Page.enable', {}, sessionId),
    ]);
    return {targetId: String(targetId), sessionId: String(sessionId)};
  }

  /** Starts or continues a capture; answers within `wait` ms so a phone request never times out. */
  async snapshot(p: Json, wait = 25_000): Promise<Snapshot> {
    const slug = artifactSlug(p.url);
    const width = Math.round(Math.min(1600, Math.max(320, Number(p.width) || 420))), dark = p.dark === true;
    const variant = `${width}-${dark ? 'dark' : 'light'}`, dir = this.snapshots(slug), file = join(dir, `${variant}.html`);
    const meta = join(dir, `${variant}.json`);
    if (p.refresh !== true && !this.jobs.has(variant + slug)) {
      const saved = await readFile(meta, 'utf8').then(text => JSON.parse(text), () => null);
      if (saved && existsSync(file)) return {state: 'ready', slug, title: saved.title, at: saved.at, file: await readProjectFile(dir, file).then(({text, ...info}) => info)};
    }
    let job = this.jobs.get(variant + slug);
    if (!job) {
      job = this.serial(() => this.capture(String(p.url), width, dark)).then(async result => {
        if ('html' in result || result.state === 'login') void this.note('html' in result);
        if ('html' in result) {
          await mkdir(dir, {recursive: true});
          await writeFile(file, result.html);
          const at = this.now();
          await writeFile(meta, JSON.stringify({title: result.title, at}));
          const {text, ...info} = await readProjectFile(dir, file);
          return {state: 'ready', slug, title: result.title, at, file: info} as Snapshot;
        }
        return result;
      }).finally(() => {this.jobs.delete(variant + slug);this.rest();});
      this.jobs.set(variant + slug, job);
    }
    let timer: NodeJS.Timeout | undefined;
    const waiting = new Promise<Snapshot>(resolve => {timer = setTimeout(() => resolve({state: 'rendering'}), wait);});
    return Promise.race([job, waiting]).finally(() => clearTimeout(timer));
  }

  /** Page names from snapshots already saved on this computer, for pages the transcript does not name. */
  async savedTitles(urls: string[]): Promise<Map<string, string>> {
    const titles = new Map<string, string>();
    await Promise.all([...new Set(urls)].map(async url => {
      let dir: string;
      try {dir = this.snapshots(artifactSlug(url));} catch {return;}
      const names = await readdir(dir).catch(() => [] as string[]);
      for (const name of names.filter(name => name.endsWith('.json'))) {
        const title = await readFile(join(dir, name), 'utf8').then(text => String(JSON.parse(text).title || '').trim(), () => '');
        if (title && title !== DEFAULT_TITLE) {titles.set(url, title.slice(0, 200));return;}
      }
    }));
    return titles;
  }

  async download(p: Json) {
    const slug = artifactSlug(`https://claude.ai/artifact/${typeof p.slug === 'string' ? p.slug : ''}`);
    const name = typeof p.name === 'string' && /^\d{3,4}-(?:dark|light)\.html$/.test(p.name) ? p.name : '';
    if (!name) throw new BridgeError('invalid', '快照文件无效');
    return downloadProjectFile(this.snapshots(slug), name, String(p.revision || ''), Number(p.offset));
  }

  private async capture(url: string, width: number, dark: boolean, retried = false): Promise<{html: string; title: string} | {state: 'login'} | {state: 'challenge'}> {
    const browser = await this.open();
    const {cdp} = browser;
    const page = await this.tab(browser, width, 900, dark);
    const children = new Map<string, {sessionId: string; url: string}>();
    const attach = async (sessionId: string) => {
      await cdp.send('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: false, flatten: true}, sessionId).catch(() => {});
    };
    const off = cdp.on(message => {
      if (message.method === 'Target.attachedToTarget' && message.params?.targetInfo?.type === 'iframe') {
        const info = message.params.targetInfo, sessionId = String(message.params.sessionId);
        children.set(String(info.targetId), {sessionId, url: String(info.url)});
        void Promise.all([cdp.send('Page.enable', {}, sessionId), attach(sessionId)]).catch(() => {});
      } else if (message.method === 'Target.targetInfoChanged') {
        const info = message.params?.targetInfo, child = children.get(String(info?.targetId));
        if (child && info?.url) child.url = String(info.url);
      } else if (message.method === 'Target.detachedFromTarget') {
        for (const [id, child] of children) if (child.sessionId === message.params?.sessionId) children.delete(id);
      } else if (message.method === 'Page.frameNavigated' && message.sessionId && !message.params?.frame?.parentId) {
        for (const child of children.values()) if (child.sessionId === message.sessionId) child.url = String(message.params?.frame?.url || child.url);
      }
    });
    try {
      await attach(page.sessionId);
      await cdp.send('Page.navigate', {url}, page.sessionId);
      const started = this.now();
      let stable = 0, last = '', frame: {sessionId: string; url: string; frameId?: string; tree?: Json} | undefined, frameSince = 0;
      const matches = (value: string) => {try {return this.frameHost.test(new URL(value).hostname);} catch {return false;}};
      // The Artifact's frame is an out-of-process child target, or a frame inside the page's own process.
      const locate = async () => {
        const target = [...children.values()].find(child => matches(child.url));
        if (target) return target;
        const {frameTree} = await cdp.send('Page.getFrameTree', {}, page.sessionId).catch(() => ({frameTree: null}));
        const find = (node: Json | null): Json | undefined => !node ? undefined : node.frame?.parentId && matches(String(node.frame.url)) ? node : (node.childFrames || []).map(find).find(Boolean);
        const found = find(frameTree);
        return found ? {sessionId: page.sessionId, url: String(found.frame.url), frameId: String(found.frame.id), tree: found} : undefined;
      };
      for (;;) {
        await delay(600);
        const state = await this.evaluate(cdp, page.sessionId, `({href: location.href, title: document.title, text: (document.body && document.body.innerText || '').slice(0, 400)})`).catch(() => null);
        if (state) {
          if (/challenge|cdn-cgi/.test(state.href) || /^(Just a moment|请稍候)/.test(state.title)) {
            if (this.now() - started > 20_000) {
              // A check that wants a person is not a sign-out: it is passed in the window on the computer's screen.
              if (retried || browser.visible) return {state: 'challenge'};
              this.visible = true;
              return this.capture(url, width, dark, true);
            }
            continue;
          }
          if (/\/login(?:[/?#]|$)/.test(new URL(state.href).pathname) || /Sign in to view|登录以查看/i.test(state.text)) return {state: 'login'};
        }
        frame = await locate();
        if (!frame) {
          if (this.now() - started > 35_000) throw new BridgeError('not_found', `没有找到页面内容${state?.text ? `：${state.text.slice(0, 120)}` : ''}`);
          continue;
        }
        frameSince ||= this.now();
        const context = frame.frameId ? await this.world(cdp, frame.sessionId, frame.frameId).catch(() => undefined) : undefined;
        const look = await this.evaluate(cdp, frame.sessionId, `document.readyState + ':' + document.documentElement.outerHTML.length + ':' + (document.body ? document.body.innerText.length : 0)`, context).catch(() => '');
        stable = look && look === last && look.startsWith('complete') ? stable + 1 : 0;
        last = look;
        // Rendered when the frame stops changing for ~2.4 s, or after 50 s whatever it shows.
        if (stable >= 4 && this.now() - frameSince > 3000 || this.now() - started > 50_000) break;
      }
      const html = frame.frameId && frame.tree
        ? await this.serializeFrame(cdp, {sessionId: frame.sessionId, frameId: frame.frameId, url: frame.url}, frame.tree, children, 0, {total: 0})
        : await this.serializeTarget(cdp, frame.sessionId, children, 0);
      const titleRaw = await this.evaluate(cdp, page.sessionId, 'document.title').catch(() => '');
      return {html, title: String(titleRaw || '').replace(/\s*[–-]\s*Claude\s*$/, '').trim() || DEFAULT_TITLE};
    } finally {
      off();
      await cdp.send('Target.closeTarget', {targetId: page.targetId}).catch(() => {});
    }
  }

  private async world(cdp: Cdp, sessionId: string, frameId: string): Promise<number> {
    const {executionContextId} = await cdp.send('Page.createIsolatedWorld', {frameId, worldName: 'cmw-snapshot', grantUniveralAccess: false}, sessionId);
    return Number(executionContextId);
  }

  private async evaluate(cdp: Cdp, sessionId: string, expression: string, contextId?: number): Promise<any> {
    const result = await cdp.send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true, ...(contextId ? {contextId} : {})}, sessionId, 60_000);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || '页面脚本出错');
    return result.result?.value;
  }

  /** Serializes the main frame of a target, its same-process child frames and its out-of-process child targets. */
  private async serializeTarget(cdp: Cdp, sessionId: string, children: Map<string, {sessionId: string; url: string}>, depth: number): Promise<string> {
    const {frameTree} = await cdp.send('Page.getFrameTree', {}, sessionId);
    return this.serializeFrame(cdp, {sessionId, frameId: String(frameTree.frame.id), url: String(frameTree.frame.url)}, frameTree, children, depth, {total: 0});
  }

  private async serializeFrame(cdp: Cdp, frame: Frame, tree: Json, children: Map<string, {sessionId: string; url: string}>, depth: number, budget: {total: number}): Promise<string> {
    const result: Serialized & {title: string} = await this.evaluate(cdp, frame.sessionId, SERIALIZER, await this.world(cdp, frame.sessionId, frame.frameId));
    let html = result.html;
    const types = new Map<string, string>();
    try {
      const {frameTree} = await cdp.send('Page.getResourceTree', {}, frame.sessionId);
      const walk = (node: Json) => {for (const item of node.resources || []) types.set(String(item.url), `${item.type}|${item.mimeType || ''}`);for (const child of node.childFrames || []) walk(child);};
      walk(frameTree);
    } catch {}
    const values = await Promise.all(result.resources.map(async url => {
      try {
        const {content, base64Encoded} = await cdp.send('Page.getResourceContent', {frameId: frame.frameId, url}, frame.sessionId);
        const [type = '', mime = ''] = (types.get(url) || '').split('|');
        const kind = mime || mimeOf(url, type);
        let bytes = base64Encoded ? Buffer.from(String(content), 'base64') : Buffer.from(String(content));
        if (bytes.length > MAX_RESOURCE || budget.total + bytes.length > MAX_TOTAL) return '';
        budget.total += bytes.length;
        if (kind === 'text/css') return {css: bytes.toString('utf8')};
        if (textMime(kind) && !base64Encoded) bytes = Buffer.from(String(content));
        return `data:${kind};base64,${bytes.toString('base64')}`;
      } catch {return '';}
    }));
    const value = (index: number) => {const item = values[index];return typeof item === 'string' ? item : '';};
    // Linked stylesheets the frame could not read become their fetched text; their own url()s stay unresolved.
    html = html.replace(/<style data-cmw-sheet="cmw-resource:(\d+)"><\/style>/g, (_, index) => {
      const item = values[Number(index)];
      return typeof item === 'object' && item ? `<style>${item.css.replace(/<\/style/gi, '<\\/style').replace(/url\([^)]*\)/g, 'url("")')}</style>` : '';
    });
    html = html.replace(/cmw-resource:(\d+)/g, (_, index) => value(Number(index)));
    // Child frames: same-process ones are in this frame tree, out-of-process ones are attached targets.
    const childFrames: Json[] = tree.childFrames || [];
    const used = new Set<number>();
    const parts = await Promise.all(result.frames.map(async ({src, name}) => {
      if (depth >= 3) return '';
      const at = childFrames.findIndex((child, i) => !used.has(i) && (child.frame.url === src || name && child.frame.name === name));
      if (at >= 0) {
        used.add(at);
        const child = childFrames[at];
        return this.serializeFrame(cdp, {sessionId: frame.sessionId, frameId: String(child.frame.id), url: String(child.frame.url)}, child, children, depth + 1, budget).catch(() => '');
      }
      const target = [...children.values()].find(child => child.url === src);
      return target ? this.serializeTarget(cdp, target.sessionId, children, depth + 1).catch(() => '') : '';
    }));
    html = html.replace(/<iframe data-cmw-frame="(\d+)"/g, (whole, index) => {
      const inner = parts[Number(index)];
      return inner ? `<iframe srcdoc="${inner.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"` : whole;
    });
    const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${CSP}">`;
    return /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${head}`) : html.replace(/^<!doctype html>/i, `<!doctype html>${head}`);
  }

  /**
   * Whether the connector's browser is signed in, as last seen, kept in a small file so asking does not start the browser.
   * `unknown`: a profile from before this was recorded, which may well be signed in.
   */
  async known(): Promise<Json> {
    const exe = this.executable();
    if (!exe) return {desktop: true, available: false, signedIn: 'no'};
    const folder = profileFolder(exe);
    const saved = await readFile(join(this.dataDir, 'claude-signin.json'), 'utf8').then(text => JSON.parse(text), () => null);
    if (saved?.profile === folder) return {desktop: true, available: true, signedIn: saved.signedIn ? 'yes' : 'no'};
    return {desktop: true, available: true, signedIn: existsSync(join(this.dataDir, folder)) ? 'unknown' : 'no'};
  }
  private async note(signedIn: boolean) {
    const exe = this.executable();
    if (!exe) return;
    await writeFile(join(this.dataDir, 'claude-signin.json'), JSON.stringify({profile: profileFolder(exe), signedIn, at: this.now()})).catch(() => {});
  }
  private async signedIn(cdp: Cdp) {
    const {cookies = []} = await cdp.send('Storage.getCookies').catch((): Json => ({}));
    return (cookies as Json[]).some(cookie => SESSION_COOKIE.test(String(cookie.name)) && this.onSite(cookie.domain));
  }
  private closeDesk() {
    const desk = this.desk;
    this.desk = undefined;
    if (desk?.child.exitCode === null) desk.child.kill();
  }

  /**
   * Sign-in at the computer: the connector's profile opened in a plain browser window on the computer's screen, at
   * claude.ai's sign-in page, with no remote debugging and nothing attached. Cloudflare's "verify you are human" keeps
   * coming back in a browser under DevTools control, so this window is where a person passes it, and signs in.
   * The connector's own browser stays closed meanwhile (one browser per profile). Nothing can be read from the window,
   * so it is done when the person closes it; the profile's cookies then tell whether sign-in happened.
   * `start` opens it; without it this reports whether it is still open and, once closed, whether sign-in is done.
   */
  private async deskSignIn(start: boolean): Promise<Json> {
    const exe = this.executable();
    if (!exe) throw new BridgeError('unavailable', '电脑上没有找到 Edge 或 Chrome。');
    const profile = join(this.dataDir, profileFolder(exe));
    if (start && !(this.desk && await profileInUse(profile))) {
      const current = await this.browser?.catch(() => undefined);
      if (current) await this.stop(current);
      this.login = undefined;
      await mkdir(profile, {recursive: true});
      const child = spawn(exe, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', '--hide-crash-restore-bubble',
        '--new-window', '--window-position=80,60', '--window-size=1100,820', this.loginUrl], {stdio: 'ignore'});
      child.on('error', () => {});
      this.desk = {child};
      for (let i = 0; i < 100 && !(await profileInUse(profile)); i++) await delay(100);
      if (!await profileInUse(profile)) {this.desk = undefined;throw new BridgeError('unavailable', '电脑上的浏览器窗口没有打开');}
    }
    if (this.desk && await profileInUse(profile)) {
      // Signed in once the window shows claude.ai's app. It is then closed as a person would close it, so the
      // browser saves its cookies first, and those are checked below as for a window the person closed.
      const pid = this.desk.child.exitCode === null ? this.desk.child.pid : undefined;
      if (!pid || !appTitle(await windowTitle(pid))) return {desktop: true, open: true, signedIn: false};
      await run('taskkill', ['/PID', String(pid)], {windowsHide: true, timeout: 10_000}).catch(() => {});
      for (let i = 0; i < 100 && await profileInUse(profile); i++) await delay(150);
      if (await profileInUse(profile)) return {desktop: true, open: true, signedIn: false};
    }
    if (!this.desk) return {desktop: true, open: false, signedIn: (await this.known()).signedIn === 'yes'};
    this.desk = undefined;
    // Closed: the connector's browser looks at the cookies the window left, without opening any page.
    const browser = await this.open();
    const signedIn = await this.signedIn(browser.cdp);
    await this.note(signedIn);
    this.rest();
    return {desktop: true, open: false, signedIn};
  }

  /** The tab sign-in works in. Shared with the remote screen, so a stuck email sign-in can be finished by hand. */
  private async loginTab(browser: Browser, fresh: boolean) {
    if (this.login && !fresh) {
      const {targetInfos = []} = await browser.cdp.send('Target.getTargets').catch((): Json => ({}));
      if ((targetInfos as Json[]).some(info => info.targetId === this.login!.targetId)) return this.login;
    }
    if (this.login) await browser.cdp.send('Target.closeTarget', {targetId: this.login.targetId}).catch(() => {});
    const width = 390, height = 760;
    this.login = {...await this.tab(browser, width, height, false, 1), width, height};
    return this.login;
  }
  private signInLink(url: string) {return url.length <= 4000 && (SIGN_IN_LINK.test(url) || url.startsWith(`${this.site}/`));}
  private async loginState(cdp: Cdp, sessionId: string): Promise<Json> {return await this.evaluate(cdp, sessionId, LOGIN_STATE).catch(() => ({})) || {};}
  /**
   * Watches the sign-in page until `want` accepts what it shows, sign-in completes, an alert or a human check comes up,
   * or `ms` passes. An alert already on the page before (`stale`) counts only once it has stayed a few seconds.
   */
  private async loginWait(cdp: Cdp, sessionId: string, want: (state: Json) => Json | undefined, ms = 25_000, stale = ''): Promise<Json> {
    const started = this.now();
    let cloudflare = 0;
    while (this.now() - started < ms) {
      await delay(500);
      const state = await this.loginState(cdp, sessionId);
      // Cloudflare's quiet check passes by itself in a few seconds; one still there wants a person at the computer.
      if (state.cloudflare) {
        cloudflare ||= this.now();
        if (this.now() - cloudflare > 12_000) return {stage: 'challenge', message: CHALLENGE};
        continue;
      }
      cloudflare = 0;
      if (this.onSite(state.host) && state.path && !SIGN_IN_PATH.test(String(state.path)) && await this.signedIn(cdp)) return {stage: 'done', signedIn: true};
      const hit = want(state);
      if (hit) return hit;
      if (state.challenge) return {stage: 'blocked', message: 'claude.ai 要求人机验证，请改用远程画面，自己点一下。'};
      if (state.alert && (state.alert !== stale || this.now() - started > 4000)) return {stage: 'error', message: String(state.alert).slice(0, 300)};
    }
    return {stage: 'blocked', message: 'claude.ai 的登录页没有继续，可以改用远程画面看看停在哪里。'};
  }
  private async loginDone(result: Json): Promise<Json> {
    if (result.stage === 'done') {
      await this.note(true);
      const browser = await this.browser?.catch(() => undefined);
      if (browser && this.login) await browser.cdp.send('Target.closeTarget', {targetId: this.login.targetId}).catch(() => {});
      this.login = undefined;
    }
    this.rest();
    return result;
  }
  private async press(cdp: Cdp, sessionId: string, box: string, text: string, submit: string) {
    await this.evaluate(cdp, sessionId, `(() => {const box = document.querySelector(${JSON.stringify(box)}); box.focus(); box.select(); return true;})()`);
    await cdp.send('Input.insertText', {text}, sessionId);
    await delay(200);
    // The page's own button, clicked in script, so a cookie banner over it does not matter.
    await this.evaluate(cdp, sessionId, `(() => {const b = document.querySelector(${JSON.stringify(submit)}); if (b && !b.disabled) b.click(); else document.querySelector(${JSON.stringify(box)}).form?.requestSubmit(); return true;})()`);
  }

  /**
   * Sign-in by email, done by the connector's browser on claude.ai's own sign-in page: it enters the address and asks
   * for the email. The person then hands back what the email gives them (`code`): the link itself, or the code the link
   * shows when opened on another device.
   */
  private async emailSignIn(email: string): Promise<Json> {
    if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email)) throw new BridgeError('invalid', '邮箱地址无效');
    // A real (off-screen) window, as with the remote screen: claude.ai's human check is more likely to accept it.
    this.visible = true;
    const browser = await this.open(), {cdp} = browser;
    const {sessionId} = await this.loginTab(browser, true);
    await cdp.send('Page.navigate', {url: this.loginUrl}, sessionId);
    let ready = await this.loginWait(cdp, sessionId, state => state.email || state.another ? {stage: 'ready', another: state.another} : undefined);
    if (ready.stage === 'ready' && ready.another && !ready.email) {
      await this.evaluate(cdp, sessionId, `document.querySelector('[data-testid=login-use-another-account]').click()`).catch(() => {});
      ready = await this.loginWait(cdp, sessionId, state => state.email ? {stage: 'ready'} : undefined, 10_000);
    }
    if (ready.stage !== 'ready') return this.loginDone(ready);
    await this.press(cdp, sessionId, '#email', email, '[data-form=email] [data-testid=continue]');
    return this.loginDone(await this.loginWait(cdp, sessionId, state => state.step === 'sent' || state.step === 'code' ? {stage: 'sent', email} : undefined, 30_000));
  }

  /** What the sign-in email gave: its link, opened here, or a code typed into the page's code step or second-factor step. */
  private async codeSignIn(value: string): Promise<Json> {
    if (/^https?:\/\//i.test(value)) {
      if (!this.signInLink(value)) throw new BridgeError('invalid', '只能打开 claude.ai 的登录链接');
      this.visible = true;
      const browser = await this.open(), {cdp} = browser;
      const {sessionId} = await this.loginTab(browser, false);
      await cdp.send('Page.navigate', {url: value}, sessionId);
      await delay(1500);
      return this.loginDone(await this.loginWait(cdp, sessionId, state => state.step === 'second_factor' ? {stage: 'mfa'} : undefined));
    }
    const code = value.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9-]{4,64}$/.test(code)) throw new BridgeError('invalid', '验证码格式不对');
    const browser = await this.browser?.catch(() => undefined);
    if (!browser || browser.cdp.closed || !this.login) throw new BridgeError('expired', '登录已中断，请重新发送登录邮件');
    const {cdp} = browser, {sessionId} = this.login;
    let state = await this.loginState(cdp, sessionId);
    if (state.step === 'sent') {
      await this.evaluate(cdp, sessionId, `document.querySelector('[data-action=enter-code]').click()`).catch(() => {});
      await delay(400);
      state = await this.loginState(cdp, sessionId);
    }
    const mfa = state.step === 'second_factor';
    if (!mfa && state.step !== 'code') return this.loginDone({stage: 'blocked', message: 'claude.ai 的登录页不在输入验证码这一步。请重新发送登录邮件，或改用远程画面。'});
    await this.press(cdp, sessionId, mfa ? '#mfa-code' : '#code', code, mfa ? '[data-form=second_factor] button[type=submit]' : '[data-form=code] [data-testid=continue]');
    return this.loginDone(await this.loginWait(cdp, sessionId, next => !mfa && next.step === 'second_factor' ? {stage: 'mfa'} : undefined, 25_000, String(state.alert || '')));
  }

  /**
   * The fallback: a session cookie copied from a browser already signed in to claude.ai, put into the connector's
   * profile and kept only if claude.ai then accepts it. Accepts the bare value or `name=value`.
   */
  private async cookieSignIn(raw: string): Promise<Json> {
    const match = /^\s*(?:(sessionKey(?:V\d+)?)\s*[=:]\s*)?["']?([^"'\s;]+)["']?\s*;?\s*$/.exec(raw.slice(0, 2000));
    const name = match?.[1] || 'sessionKey', value = match?.[2] || '';
    if (!/^sk-ant-[\w-]{16,1000}$/.test(value)) throw new BridgeError('invalid', '这不像 claude.ai 的 sessionKey，它应以 sk-ant- 开头');
    this.visible = true;
    const browser = await this.open(), {cdp} = browser;
    const {sessionId} = await this.loginTab(browser, true);
    const secure = this.site.startsWith('https:');
    const set = await cdp.send('Network.setCookie', {name, value, domain: this.siteHost, path: '/', secure, httpOnly: true, sameSite: 'Lax',
      expires: Math.floor(this.now() / 1000) + 30 * 86400}, sessionId);
    if (set.success === false) throw new BridgeError('invalid', '没能把 sessionKey 写进中转浏览器');
    await cdp.send('Page.navigate', {url: `${this.site}/`}, sessionId);
    // Accepted once claude.ai's own API answers as signed in; a refused key is taken out again.
    const started = this.now();
    while (this.now() - started < 25_000) {
      await delay(800);
      const state = await this.loginState(cdp, sessionId);
      if (state.cloudflare && this.now() - started > 15_000) return this.loginDone({stage: 'challenge', message: CHALLENGE});
      if (!this.onSite(state.host) || state.cloudflare) continue;
      const status = await this.evaluate(cdp, sessionId, `fetch('/api/organizations', {credentials: 'include', headers: {accept: 'application/json'}}).then(r => r.status, () => 0)`).catch(() => 0);
      if (status === 200) return this.loginDone({stage: 'done', signedIn: true});
      if (status === 401 || status === 403) {
        await cdp.send('Network.deleteCookies', {name, domain: this.siteHost, path: '/'}, sessionId).catch(() => {});
        await this.note(false);
        return this.loginDone({stage: 'error', message: 'claude.ai 没有接受这个 sessionKey，可能已过期或复制不完整'});
      }
    }
    return this.loginDone({stage: 'blocked', message: '已写入 sessionKey，但 claude.ai 一直没有答复，暂时无法确认。可以稍后刷新页面再试。'});
  }

  /**
   * Sign-in to claude.ai in the connector's browser. `email`/`code`: by email, with the link or code handed back here;
   * `cookie`: a session cookie pasted from a browser already signed in. `desktop`/`status`: in a window on the computer's screen.
   * The other operations work it from the phone: screenshots of a claude.ai tab, and input sent back to it.
   */
  async signIn(p: Json): Promise<Json> {
    const op = p.op;
    if (op === 'check') return this.known();
    if (op === 'desktop' || op === 'status') return this.serial(() => this.deskSignIn(op === 'desktop'));
    if (op === 'email') return this.serial(() => this.emailSignIn(typeof p.email === 'string' ? p.email.trim() : ''));
    if (op === 'code') return this.serial(() => this.codeSignIn(typeof p.code === 'string' ? p.code.trim() : ''));
    if (op === 'cookie') return this.serial(() => this.cookieSignIn(typeof p.value === 'string' ? p.value : ''));
    if (op === 'close') return this.serial(async () => {
      const browser = await this.browser?.catch(() => undefined);
      if (browser && this.login) await browser.cdp.send('Target.closeTarget', {targetId: this.login.targetId}).catch(() => {});
      this.closeDesk();
      this.login = undefined;this.rest();
      return {closed: true};
    });
    return this.serial(async () => {
      // Signing in uses a real (off-screen) window: claude.ai's human check is more likely to accept it.
      if (op === 'start') this.visible = true;
      const browser = await this.open();
      if (op === 'start' || !this.login) {
        if (op !== 'start') throw new BridgeError('expired', '登录窗口已关闭，请重新开始');
        if (this.login) await browser.cdp.send('Target.closeTarget', {targetId: this.login.targetId}).catch(() => {});
        const width = Math.round(Math.min(800, Math.max(320, Number(p.width) || 390))), height = Math.round(Math.min(1200, Math.max(480, Number(p.height) || 760)));
        const tab = await this.tab(browser, width, height, false, 1);
        this.login = {...tab, width, height};
        await browser.cdp.send('Page.navigate', {url: this.loginUrl}, tab.sessionId);
        await delay(1500);
      }
      const login = this.login!, {cdp} = browser;
      if (op === 'click') {
        const x = Number(p.x) * login.width, y = Number(p.y) * login.height;
        if (!(x >= 0 && x <= login.width && y >= 0 && y <= login.height)) throw new BridgeError('invalid', '点击位置无效');
        for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', {type, x, y, button: 'left', clickCount: 1}, login.sessionId);
      } else if (op === 'scroll') {
        await cdp.send('Input.dispatchMouseEvent', {type: 'mouseWheel', x: login.width / 2, y: login.height / 2, deltaX: 0, deltaY: Math.max(-2000, Math.min(2000, Number(p.dy) || 0))}, login.sessionId);
      } else if (op === 'text') {
        const text = typeof p.text === 'string' ? p.text.slice(0, 2000) : '';
        if (text) await cdp.send('Input.insertText', {text}, login.sessionId);
      } else if (op === 'key') {
        const keys: Record<string, [number, string]> = {Enter: [13, '\r'], Backspace: [8, ''], Tab: [9, ''], Escape: [27, '']};
        const key = keys[String(p.key)];
        if (!key) throw new BridgeError('invalid', '按键无效');
        await cdp.send('Input.dispatchKeyEvent', {type: key[1] ? 'keyDown' : 'rawKeyDown', key: p.key, code: p.key, windowsVirtualKeyCode: key[0], ...(key[1] ? {text: key[1]} : {})}, login.sessionId);
        await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: p.key, code: p.key, windowsVirtualKeyCode: key[0]}, login.sessionId);
      } else if (op === 'navigate') {
        const url = typeof p.url === 'string' ? p.url.trim() : '';
        if (!this.signInLink(url)) throw new BridgeError('invalid', '只能打开 claude.ai 的登录链接');
        await cdp.send('Page.navigate', {url}, login.sessionId);
      } else if (op === 'back') {
        await this.evaluate(cdp, login.sessionId, 'history.back()').catch(() => {});
      } else if (op !== 'start' && op !== 'frame') throw new BridgeError('invalid', '登录操作无效');
      if (op !== 'frame' && op !== 'start') await delay(op === 'navigate' ? 1500 : 400);
      const [{data}, href, cookies] = await Promise.all([
        cdp.send('Page.captureScreenshot', {format: 'jpeg', quality: 70}, login.sessionId),
        this.evaluate(cdp, login.sessionId, 'location.href').catch(() => ''),
        cdp.send('Network.getCookies', {urls: [`${this.site}/`]}, login.sessionId).catch(() => ({cookies: []})),
      ]);
      let path = '';
      try {path = new URL(String(href)).pathname;} catch {}
      const signedIn = (cookies.cookies || []).some((cookie: Json) => SESSION_COOKIE.test(String(cookie.name))) && !SIGN_IN_PATH.test(path);
      await this.note(signedIn);
      this.rest();
      return {image: `data:image/jpeg;base64,${data}`, url: String(href), signedIn, width: login.width, height: login.height};
    });
  }

  close(): Promise<void> {
    clearTimeout(this.idle);
    return this.browser ? this.browser.then(browser => this.stop(browser), () => {}) : Promise.resolve();
  }
}
