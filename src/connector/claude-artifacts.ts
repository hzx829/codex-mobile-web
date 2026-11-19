import {spawn, type ChildProcess} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
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
 * Signing in is done from the phone too: the phone sees screenshots of the computer's browser
 * and sends taps, text and keys to it.
 */

const ARTIFACT = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9_-]{8,64})\/?(?:[?#].*)?$/;
export function artifactSlug(value: unknown) {
  const slug = typeof value === 'string' && value.length < 300 ? ARTIFACT.exec(value)?.[1] : undefined;
  if (!slug) throw new BridgeError('invalid', '只能打开 claude.ai 的 Artifact 链接');
  return slug;
}
const FRAME_HOST = /\.frame\.claudeusercontent\.com$/;
const LOGIN_URL = 'https://claude.ai/login';
const MAX_RESOURCE = 8 * 1024 * 1024, MAX_TOTAL = 40 * 1024 * 1024;

export function findBrowser(env = process.env, exists = existsSync): string | undefined {
  if (env.CLAUDE_ARTIFACT_BROWSER) return env.CLAUDE_ARTIFACT_BROWSER;
  const pf = env['ProgramFiles'] || 'C:\\Program Files', pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', local = env.LOCALAPPDATA || '';
  const candidates = process.platform === 'win32' ? [
    join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ...(local ? [join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
  ] : process.platform === 'darwin' ? [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ] : ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find(path => exists(path));
}

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
export type Snapshot = {state: 'ready'; slug: string; title: string; at: number; file: Json} | {state: 'login'} | {state: 'rendering'};

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
  private visible = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private dataDir: string, private executable = () => findBrowser(), private frameHost = FRAME_HOST,
    private idleMs = 3 * 60_000, private now = Date.now) {}
  private get profile() {return join(this.dataDir, 'claude-browser');}
  private snapshots(slug: string) {return join(this.dataDir, 'claude-artifacts', slug);}

  private launch(visible: boolean): Promise<Browser> {
    return (async () => {
      const exe = this.executable();
      if (!exe) throw new BridgeError('unavailable', '电脑上没有找到 Edge 或 Chrome，无法中转 claude.ai 页面。可在连接器环境变量 CLAUDE_ARTIFACT_BROWSER 指定浏览器。');
      await mkdir(this.profile, {recursive: true});
      const portFile = join(this.profile, 'DevToolsActivePort');
      await rm(portFile, {force: true});
      const child = spawn(exe, [`--user-data-dir=${this.profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-first-run',
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
      if (this.jobs.size || this.login) return this.rest();
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

  async download(p: Json) {
    const slug = artifactSlug(`https://claude.ai/artifact/${typeof p.slug === 'string' ? p.slug : ''}`);
    const name = typeof p.name === 'string' && /^\d{3,4}-(?:dark|light)\.html$/.test(p.name) ? p.name : '';
    if (!name) throw new BridgeError('invalid', '快照文件无效');
    return downloadProjectFile(this.snapshots(slug), name, String(p.revision || ''), Number(p.offset));
  }

  private async capture(url: string, width: number, dark: boolean, retried = false): Promise<{html: string; title: string} | {state: 'login'}> {
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
              // A check that needs a person goes to the phone's sign-in view, where they can tick it themselves.
              if (retried || browser.visible) return {state: 'login'};
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
      return {html, title: String(titleRaw || '').replace(/\s*[–-]\s*Claude\s*$/, '').trim() || 'claude.ai 页面'};
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

  /** Sign-in from the phone: screenshots of a claude.ai tab in the connector's browser, and input sent back to it. */
  async signIn(p: Json): Promise<Json> {
    const op = p.op;
    if (op === 'close') return this.serial(async () => {
      const browser = await this.browser?.catch(() => undefined);
      if (browser && this.login) await browser.cdp.send('Target.closeTarget', {targetId: this.login.targetId}).catch(() => {});
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
        await browser.cdp.send('Page.navigate', {url: LOGIN_URL}, tab.sessionId);
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
        if (!/^https:\/\/(?:[a-z0-9-]+\.)*(?:claude\.ai|anthropic\.com)\//i.test(url) || url.length > 4000) throw new BridgeError('invalid', '只能打开 claude.ai 的登录链接');
        await cdp.send('Page.navigate', {url}, login.sessionId);
      } else if (op === 'back') {
        await this.evaluate(cdp, login.sessionId, 'history.back()').catch(() => {});
      } else if (op !== 'start' && op !== 'frame') throw new BridgeError('invalid', '登录操作无效');
      if (op !== 'frame' && op !== 'start') await delay(op === 'navigate' ? 1500 : 400);
      const [{data}, href, cookies] = await Promise.all([
        cdp.send('Page.captureScreenshot', {format: 'jpeg', quality: 70}, login.sessionId),
        this.evaluate(cdp, login.sessionId, 'location.href').catch(() => ''),
        cdp.send('Network.getCookies', {urls: ['https://claude.ai/']}, login.sessionId).catch(() => ({cookies: []})),
      ]);
      const signedIn = (cookies.cookies || []).some((cookie: Json) => cookie.name === 'sessionKey') && !/\/login/.test(String(href));
      this.rest();
      return {image: `data:image/jpeg;base64,${data}`, url: String(href), signedIn, width: login.width, height: login.height};
    });
  }

  close(): Promise<void> {
    clearTimeout(this.idle);
    return this.browser ? this.browser.then(browser => this.stop(browser), () => {}) : Promise.resolve();
  }
}
