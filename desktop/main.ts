// Desktop window of the Windows tray app. The tray (scripts/windows/tray/Tray.cs) owns every side effect;
// this page only renders the state it posts and sends back what the user asked for.
import QRCode from 'qrcode';

type Mode = 'all' | 'connector' | 'relay';
type Config = {mode?: Mode; relayUrl?: string; token?: string; codexBin?: string; codexHome?: string; claudeBin?: string; localRelay?: string};
type Service = 'running' | 'partial' | 'stopped' | 'starting' | 'stopping' | 'saving';
type HostState = {service: Service; configured: boolean; error?: string | null; autostart: boolean; config?: Config | null};
type Health = {relay: 'ok' | 'unreachable' | 'unauthorized'; connector: 'online' | 'offline' | 'unknown'; services?: string[]; codexVersion?: string; desktopOnline?: boolean; claudeSignIn?: 'yes' | 'no' | 'unknown'};
type Settings = {mode: Mode; relayUrl: string; token: string; codexBin: string; codexHome: string; claudeBin: string};
type PathField = 'codexBin' | 'codexHome' | 'claudeBin';
type FromHost =
  | {type: 'state'; state: HostState}
  | {type: 'health'; health: Health | null}
  | {type: 'dialog'; name: 'stop' | 'exit'}
  | {type: 'screen'; name: 'settings' | 'status'}
  | {type: 'picked'; field: PathField; path: string}
  | {type: 'saveResult'; ok: boolean; error?: string}
  | {type: 'claudeSignIn'; state: 'started' | 'done' | 'closed' | 'failed'; error?: string};
type ToHost =
  | {type: 'ready'} | {type: 'start'} | {type: 'stop'} | {type: 'exit'; stop: boolean}
  | {type: 'save'; settings: Settings} | {type: 'autostart'; enabled: boolean}
  | {type: 'logs'} | {type: 'open'; url: string} | {type: 'copy'; text: string}
  | {type: 'pick'; field: PathField} | {type: 'hide'} | {type: 'claudeSignIn'};

declare global {interface Window {chrome?: {webview?: {postMessage(message: unknown): void; addEventListener(type: 'message', listener: (event: {data: unknown}) => void): void}}}}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const host = window.chrome?.webview;
if (new URLSearchParams(location.search).has('mica')) document.documentElement.classList.add('mica');

let state: HostState = {service: 'stopped', configured: true, autostart: false};
let health: Health | null = null;
let screen: 'status' | 'settings' | null = null;
let draftMode: Mode = 'all';
let saving = false;
let qrFor = '';
let toastTimer = 0;
// Signing the connector's browser in to claude.ai: offered once the service runs, until done or declined.
let signIn: 'idle' | 'started' | 'failed' = 'idle', signInError = '';
const SIGNIN_DECLINED = 'claude-signin-declined';
const declined = () => {try {return localStorage.getItem(SIGNIN_DECLINED) === '1';} catch {return false;}};

function send(message: ToHost) {
  if (host) host.postMessage(message);
  else mock(message);
}

function link(config?: Config | null) {
  if (!config?.relayUrl || !config.token) return '';
  try {
    const url = new URL(config.relayUrl);
    url.hash = new URLSearchParams({token: config.token}).toString();
    return url.href;
  } catch {return '';}
}

const busy = () => ['starting', 'stopping', 'saving'].includes(state.service);
const local = (mode?: Mode) => mode !== 'connector';

function setText(id: string, text: string) {$(id).textContent = text;}
function setDot(id: string, kind: 'ok' | 'bad' | 'idle') {$(id).className = 'dot' + (kind === 'idle' ? '' : ' ' + kind);}

function renderStatus() {
  const s = state.service, config = state.config || {}, running = s === 'running';
  const failed = !!state.error && (s === 'stopped' || s === 'partial');
  const titles: Record<Service, string> = {running: '运行中', partial: '部分服务未运行', stopped: '已停止', starting: '正在启动…', stopping: '正在停止…', saving: '正在保存设置…'};
  const subs: Record<Service, string> = {
    running: '手机或任意浏览器都可以使用这台电脑上的 AI 编程助手',
    partial: '中继或连接器已经停止，重新启动即可恢复',
    stopped: '服务未运行，手机和浏览器暂时无法连接这台电脑',
    starting: local(config.mode) ? '正在启动本机中继和连接器' : '正在启动连接器并连接你的中继',
    stopping: '正在结束连接器和它管理的任务',
    saving: '保存后会自动启动服务',
  };
  setText('title', failed ? '启动失败' : titles[s]);
  setText('subtitle', failed ? '服务没有启动成功' : subs[s]);
  $('indicator').className = 'indicator ' + (busy() ? 'busy' : running ? 'running' : failed || s === 'partial' ? 'error' : '');
  $('error').hidden = !failed;
  setText('error-text', state.error || '');

  const href = link(config);
  if (href !== qrFor) {
    qrFor = href;
    if (href) QRCode.toString(href, {type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: {dark: '#0d0d0dff', light: '#ffffffff'}}).then(svg => {if (qrFor === href) $('qr').innerHTML = svg;});
    else $('qr').innerHTML = '';
  }
  $('qr').classList.toggle('dim', !running);
  $('qr-overlay').hidden = running;
  setText('qr-overlay', busy() ? titles[s] : '启动服务后显示二维码');
  setText('qr-caption', local(config.mode) ? '手机扫码（需连同一 Wi-Fi），或直接在浏览器打开' : '手机扫码，或在任意设备的浏览器打开链接');
  ($('copy') as HTMLButtonElement).disabled = !running || !href;
  ($('open-web') as HTMLButtonElement).disabled = !running || !href;

  const relayText = config.relayUrl ? config.relayUrl + (config.mode === 'all' ? ' · 本机' : '') : '未设置';
  const h = running ? health : null;
  if (!running) {
    setText('relay-value', relayText); setDot('relay-dot', 'idle');
    setText('codex-value', '—'); setDot('codex-dot', 'idle');
    setText('claude-value', '—'); setDot('claude-dot', 'idle');
    setText('antigravity-value', '—'); setDot('antigravity-dot', 'idle');
  } else if (!h) {
    setText('relay-value', relayText); setDot('relay-dot', 'idle');
    setText('codex-value', '检查中…'); setDot('codex-dot', 'idle');
    setText('claude-value', '检查中…'); setDot('claude-dot', 'idle');
    setText('antigravity-value', '检查中…'); setDot('antigravity-dot', 'idle');
  } else {
    if (h.relay === 'ok') {setText('relay-value', relayText); setDot('relay-dot', 'ok');}
    else {setText('relay-value', h.relay === 'unauthorized' ? 'Token 不匹配' : '无法连接中继'); setDot('relay-dot', 'bad');}
    if (h.connector === 'online') {
      const has = (service: string) => !h.services || h.services.includes(service);
      setText('codex-value', h.codexVersion ? `${h.codexVersion} · ${h.desktopOnline ? '官方桌面在线' : '官方桌面未打开'}` : has('codex') ? '已连接' : '未检测到');
      setDot('codex-dot', h.codexVersion ? 'ok' : 'idle');
      for (const service of ['claude', 'antigravity']) {
        const found = !!h.services?.includes(service);
        const page = service === 'claude' && found ? h.claudeSignIn === 'yes' ? ' · 已登录 claude.ai' : h.claudeSignIn === 'no' ? ' · 未登录 claude.ai' : '' : '';
        setText(`${service}-value`, (found ? '已检测到' : '未检测到') + page); setDot(`${service}-dot`, found ? 'ok' : 'idle');
      }
    } else {
      setText('codex-value', h.relay === 'ok' ? '连接器未上线' : '—'); setDot('codex-dot', h.relay === 'ok' ? 'bad' : 'idle');
      setText('claude-value', '—'); setDot('claude-dot', 'idle');
      setText('antigravity-value', '—'); setDot('antigravity-dot', 'idle');
    }
  }
  for (const id of ['relay-value', 'codex-value', 'claude-value', 'antigravity-value']) $(id).classList.toggle('muted', !running);

  const needsSignIn = h?.connector === 'online' && !!h.services?.includes('claude') && h.claudeSignIn === 'no';
  $('claude-signin').hidden = !(running && (signIn !== 'idle' || needsSignIn && !declined()));
  setText('claude-signin-text', signIn === 'started' ? '已在屏幕上打开登录窗口，请在那里登录 claude.ai，完成后窗口会自动关闭。这是连接器自己的浏览器，和平时用的 Chrome 分开；用邮箱登录时，邮件里的链接在别的浏览器打开会显示验证码，把验证码填回这个窗口即可。'
    : signIn === 'failed' ? `没能登录：${signInError}` : '登录 claude.ai 后，才能在手机或浏览器里查看 Claude 发布的页面。只需登录一次，用的是连接器自己单独的浏览器档案。');
  ($('claude-signin-go') as HTMLButtonElement).hidden = signIn === 'started';
  ($('claude-signin-go') as HTMLButtonElement).textContent = signIn === 'failed' ? '重试' : '登录';
  ($('claude-signin-skip') as HTMLButtonElement).hidden = signIn === 'started';

  $('autostart').setAttribute('aria-checked', String(state.autostart));
  ($('autostart') as HTMLButtonElement).disabled = busy();
  const primary = $('primary') as HTMLButtonElement, stop = $('stop') as HTMLButtonElement;
  primary.hidden = running;
  primary.disabled = busy();
  primary.textContent = busy() ? titles[s] : failed ? '重试' : s === 'partial' ? '重新启动' : '启动服务';
  stop.hidden = !(running || s === 'partial');
  stop.disabled = busy();
  ($('open-settings') as HTMLButtonElement).disabled = busy();
}

function renderSettingsChrome() {
  const first = !state.configured, running = state.service === 'running' || state.service === 'partial';
  $('welcome').hidden = !first;
  $('settings-head').hidden = first;
  $('cancel').hidden = first;
  $('restart-warning').hidden = first || !running;
  const save = $('save') as HTMLButtonElement;
  save.textContent = saving ? '正在保存…' : running ? '保存并重新启动' : '保存并启动';
  save.disabled = saving || busy();
  for (const button of document.querySelectorAll<HTMLButtonElement>('.segmented button')) button.setAttribute('aria-checked', String(button.dataset.mode === draftMode || (draftMode === 'relay' && button.dataset.mode === 'all')));
  const isLocal = local(draftMode);
  setText('relay-hint', isLocal ? '本机中继默认使用这台电脑的局域网地址，手机需连同一 Wi-Fi。' : '填写已部署中继的 HTTPS 地址。');
  ($('relay') as HTMLInputElement).placeholder = isLocal ? (state.config?.localRelay || 'http://192.168.1.2:3340') : 'https://codex.your-domain.com';
  ($('token') as HTMLInputElement).placeholder = isLocal ? '本机首次留空，自动生成' : '填写服务器 .env 中的 Token';
}

function openSettings() {
  const config = state.config || {};
  draftMode = config.mode || 'all';
  ($('relay') as HTMLInputElement).value = config.relayUrl || '';
  ($('token') as HTMLInputElement).value = config.token || '';
  ($('codexBin') as HTMLInputElement).value = config.codexBin || '';
  ($('codexHome') as HTMLInputElement).value = config.codexHome || '';
  ($('claudeBin') as HTMLInputElement).value = config.claudeBin || '';
  ($('advanced') as HTMLDetailsElement).open = !!(config.codexBin || config.codexHome || config.claudeBin);
  $('save-error').hidden = true;
  show('settings');
}

function show(next: 'status' | 'settings') {
  screen = next;
  $('status').hidden = next !== 'status';
  $('settings').hidden = next !== 'settings';
  render();
  // Only the first run starts typing in the relay field; later visits must not let stray keys edit a saved address.
  if (next === 'settings' && !state.configured) ($('relay') as HTMLInputElement).focus();
}

function render() {
  if (screen === 'status') renderStatus();
  if (screen === 'settings') renderSettingsChrome();
}

type DialogButton = {label: string; kind: 'primary' | 'outline' | 'danger'; action: () => void};
function dialog(title: string, text: string, buttons: DialogButton[]) {
  setText('dialog-title', title);
  setText('dialog-text', text);
  const actions = $('dialog-actions');
  actions.replaceChildren(...buttons.map(button => {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'pill ' + button.kind;
    element.textContent = button.label;
    element.addEventListener('click', () => {closeDialog(); button.action();});
    return element;
  }));
  $('dialog').hidden = false;
  (actions.lastElementChild as HTMLButtonElement | null)?.focus();
}
function closeDialog() {$('dialog').hidden = true;}

function confirmStop() {
  dialog('停止服务？', '电脑上由连接器管理的任务会被中断，手机和浏览器都将无法连接这台电脑。独立运行的 Codex、Claude Code、Antigravity 桌面程序不受影响。', [
    {label: '取消', kind: 'outline', action: () => {}},
    {label: '停止服务', kind: 'danger', action: () => send({type: 'stop'})},
  ]);
}

function confirmExit() {
  if (state.service === 'stopped') {send({type: 'exit', stop: false}); return;}
  dialog('退出 Codex 随行？', '可以只关闭托盘图标，让服务继续在后台运行；也可以同时停止服务，这会中断连接器管理的任务。', [
    {label: '取消', kind: 'outline', action: () => {}},
    {label: '只退出图标', kind: 'outline', action: () => send({type: 'exit', stop: false})},
    {label: '停止服务并退出', kind: 'danger', action: () => send({type: 'exit', stop: true})},
  ]);
}

function toast(text: string) {
  const element = $('toast');
  element.textContent = text;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {element.hidden = true;}, 1600);
}

function receive(message: FromHost) {
  if (message.type === 'state') {
    state = message.state;
    if (state.service !== 'running') health = null;
    if (!state.configured && screen !== 'settings') openSettings();
    else if (!screen) show('status');
    render();
  } else if (message.type === 'health') {
    health = message.health;
    render();
  } else if (message.type === 'dialog') {
    if (screen !== 'status' && state.configured) show('status');
    if (message.name === 'stop') confirmStop(); else confirmExit();
  } else if (message.type === 'screen') {
    if (message.name === 'settings') openSettings(); else show('status');
  } else if (message.type === 'picked') {
    ($(message.field) as HTMLInputElement).value = message.path;
  } else if (message.type === 'claudeSignIn') {
    signIn = message.state === 'started' ? 'started' : message.state === 'failed' ? 'failed' : 'idle';
    signInError = message.error || '';
    if (message.state === 'done') {if (health) health = {...health, claudeSignIn: 'yes'}; toast('已登录 claude.ai');}
    render();
  } else if (message.type === 'saveResult') {
    saving = false;
    if (message.ok) show('status');
    else {setText('save-error-text', message.error || '配置未保存'); $('save-error').hidden = false; render();}
  }
}

$('open-settings').addEventListener('click', openSettings);
$('back').addEventListener('click', () => show('status'));
$('cancel').addEventListener('click', () => show('status'));
$('primary').addEventListener('click', () => send({type: 'start'}));
$('stop').addEventListener('click', confirmStop);
$('logs').addEventListener('click', () => send({type: 'logs'}));
$('claude-signin-go').addEventListener('click', () => send({type: 'claudeSignIn'}));
$('claude-signin-skip').addEventListener('click', () => {
  try {localStorage.setItem(SIGNIN_DECLINED, '1');} catch {}
  signIn = 'idle';
  render();
  toast('以后可以从托盘菜单“登录 claude.ai”');
});
$('autostart').addEventListener('click', () => send({type: 'autostart', enabled: !state.autostart}));
$('copy').addEventListener('click', () => {const href = link(state.config); if (href) {send({type: 'copy', text: href}); toast('已复制连接链接');}});
$('open-web').addEventListener('click', () => {const href = link(state.config); if (href) send({type: 'open', url: href});});
$('toggle-token').addEventListener('click', () => {
  const input = $('token') as HTMLInputElement, visible = input.type === 'password';
  input.type = visible ? 'text' : 'password';
  input.classList.toggle('mono', visible);
  $('toggle-token').setAttribute('aria-pressed', String(visible));
});
for (const button of document.querySelectorAll<HTMLButtonElement>('.segmented button')) {
  button.addEventListener('click', () => {
    const next = button.dataset.mode as Mode, relay = $('relay') as HTMLInputElement, localRelay = state.config?.localRelay || '';
    if (next === draftMode) return;
    if (next === 'connector' && relay.value === localRelay) relay.value = '';
    if (next === 'all' && (!relay.value || relay.value.startsWith('https://'))) relay.value = localRelay;
    draftMode = next;
    renderSettingsChrome();
  });
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-pick]')) button.addEventListener('click', () => send({type: 'pick', field: button.dataset.pick as PathField}));
$('settings-form').addEventListener('submit', event => {
  event.preventDefault();
  if (saving) return;
  saving = true;
  $('save-error').hidden = true;
  const value = (id: string) => ($(id) as HTMLInputElement).value.trim();
  send({type: 'save', settings: {mode: draftMode === 'relay' ? 'all' : draftMode, relayUrl: value('relay'), token: value('token'), codexBin: value('codexBin'), codexHome: value('codexHome'), claudeBin: value('claudeBin')}});
  render();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (!$('dialog').hidden) closeDialog();
  else if (screen === 'settings' && state.configured) show('status');
});
document.addEventListener('contextmenu', event => {if (!(event.target instanceof HTMLInputElement)) event.preventDefault();});

if (host) host.addEventListener('message', event => receive(event.data as FromHost));
send({type: 'ready'});

// Browser preview without the tray: a scripted host so the page can be checked in any browser.
function mock(message: ToHost) {
  const config: Config = {mode: 'all', relayUrl: 'http://192.168.1.8:3340', token: 'preview-token-not-real', localRelay: 'http://192.168.1.8:3340'};
  const later = (fn: () => void, ms = 900) => setTimeout(fn, ms);
  const update = (patch: Partial<HostState>) => receive({type: 'state', state: {...state, ...patch}});
  const params = new URLSearchParams(location.search);
  if (message.type === 'ready') {
    const first = params.get('state') === 'first';
    update({service: first ? 'stopped' : (params.get('state') as Service) || 'running', configured: !first, autostart: true, config: first ? {localRelay: config.localRelay, relayUrl: config.localRelay, mode: 'all'} : config, error: params.get('error')});
    if (!first) later(() => receive({type: 'health', health: {relay: 'ok', connector: 'online', services: ['codex', 'claude', 'antigravity'], codexVersion: '0.146.0', desktopOnline: true, claudeSignIn: params.get('signin') === 'yes' ? 'yes' : 'no'}}));
  } else if (message.type === 'start') {
    update({service: 'starting', error: null});
    later(() => {update({service: 'running'}); later(() => receive({type: 'health', health: {relay: 'ok', connector: 'online', services: ['codex', 'claude'], codexVersion: '0.146.0', desktopOnline: false}}));});
  } else if (message.type === 'stop') {
    update({service: 'stopping'}); later(() => update({service: 'stopped'}));
  } else if (message.type === 'claudeSignIn') {
    receive({type: 'claudeSignIn', state: 'started'});
    later(() => receive(params.has('signin-fails') ? {type: 'claudeSignIn', state: 'failed', error: '连接器未在线'} : {type: 'claudeSignIn', state: 'done'}), 1800);
  } else if (message.type === 'autostart') update({autostart: message.enabled});
  else if (message.type === 'save') {
    update({service: 'saving'});
    later(() => {update({service: 'running', configured: true, config: {...config, ...message.settings}}); receive({type: 'saveResult', ok: true});});
  }
}
