import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { BridgeError, type Json } from '../shared/types.js';

export function resolveCodex(configured = process.env.CODEX_BIN): string {
  if (configured) {
    if (/\.(cmd|ps1|bat)$/i.test(configured)) throw new Error('CODEX_BIN 请指向 Codex 可执行文件，而非 shell 包装脚本');
    return configured;
  }
  if (process.platform !== 'win32') return 'codex';
  // Prefer the installation the user's shell resolves, without launching a shell.
  const roots = (process.env.PATH || '').split(';');
  for (const root of roots) {
    if (existsSync(join(root, 'codex.exe'))) return join(root, 'codex.exe');
    const vendor = join(root, 'node_modules', '@openai', 'codex', 'node_modules', '@openai');
    if (existsSync(vendor)) for (const pkg of readdirSync(vendor)) {
      const v = join(vendor, pkg, 'vendor');
      if (existsSync(v)) for (const target of readdirSync(v)) {
        for(const subdir of ['bin','codex']){const exe=join(v,target,subdir,'codex.exe');if(existsSync(exe))return exe;}
      }
    }
    for(const subdir of ['bin','codex']){const legacy = join(root, 'node_modules', '@openai', 'codex', 'vendor', process.arch==='arm64'?'aarch64-pc-windows-msvc':'x86_64-pc-windows-msvc', subdir, 'codex.exe');if(existsSync(legacy))return legacy;}
  }
  const managed = join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  if (existsSync(managed)) {
    const candidates = [join(managed, 'codex.exe'), ...readdirSync(managed).map(n => join(managed, n, 'codex.exe'))]
      .filter(p => existsSync(p)).sort((a,b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (candidates[0]) return candidates[0];
  }
  throw new Error('未找到 Codex 可执行文件，请设置 CODEX_BIN');
}

export class AppServer extends EventEmitter {
  child: ChildProcessWithoutNullStreams | null = null;
  private next = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  requests = new Map<string, Json>();
  private responding=new Set<string>();
  constructor(public bin = resolveCodex(), private env: NodeJS.ProcessEnv = process.env) { super(); }
  async start() {
    if (this.child) return;
    if(this.env.CODEX_PROFILE)throw new BridgeError('unsupported_profile','当前验证的 Codex 0.146.0 不支持为 app-server 选择命名 profile。请使用默认配置，或连接已经使用该配置的官方桌面会话；不会自动换用其他模型。');
    const args = ['app-server', '--stdio'];
    const child = spawn(this.bin, args, { cwd: this.env.CODEX_HOME || join(homedir(), '.codex'), env: { ...this.env }, windowsHide: true, stdio: 'pipe' });
    this.child = child;
    child.stderr.on('data', () => {}); // Native diagnostics can contain credentials; never forward them to the relay.
    createInterface({ input: child.stdout }).on('line', line => {
      try { this.receive(JSON.parse(line)); } catch { this.emit('diagnostic', 'invalid_runtime_frame'); }
    });
    child.on('error', e => { if(this.child===child)this.disconnected(e); });
    child.on('exit', () => { if(this.child===child)this.disconnected(new BridgeError('offline','Codex 运行进程已退出',true)); });
    await this.rpc('initialize', { clientInfo: { name: 'codex_mobile_web', title: 'Codex Mobile Web', version: '0.1.3' }, capabilities: { experimentalApi: true } });
    this.write({ method: 'initialized' });
  }
  private receive(m: Json) {
    if (m.id !== undefined && !m.method) {
      const pending = this.pending.get(m.id);
      if (!pending) return;
      this.pending.delete(m.id); clearTimeout(pending.timer);
      if (m.error) pending.reject(new BridgeError('runtime_error', m.error.message || 'Codex 请求失败'));
      else pending.resolve(m.result);
      return;
    }
    if (m.id !== undefined && m.method) this.requests.set(String(m.id), m);
    if (m.method === 'serverRequest/resolved') {this.requests.delete(String(m.params?.requestId));this.responding.delete(String(m.params?.requestId));}
    if (m.method === 'turn/completed') for (const [id, req] of this.requests) {
      if (req.params?.threadId === m.params?.threadId && (!req.params?.turnId || req.params.turnId === m.params?.turn?.id)) this.requests.delete(id);
    }
    this.emit('event', m);
  }
  rpc<T = any>(method: string, params: Json = {}, timeout = 30_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new BridgeError('timeout', `Codex 请求超时：${method}`, true)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  respond(id: string, result: Json,timeout=10_000):Promise<void> {
    const req = this.requests.get(id);
    if (!req) throw new BridgeError('expired', '该请求已经处理或失效');
    if(this.responding.has(id))throw new BridgeError('pending','这项回应已提交，正在等待 Codex 确认');
    this.responding.add(id);
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);this.off('event',onEvent);this.off('offline',onOffline);};
      const onEvent=(e:Json)=>{if(e.method==='serverRequest/resolved'&&String(e.params?.requestId)===id){cleanup();resolve();}};
      const onOffline=()=>{cleanup();reject(new BridgeError('offline','回应已提交，但 Codex 连接中断，请核实',true));};
      const timer=setTimeout(()=>{cleanup();reject(new BridgeError('timeout','尚未收到 Codex 对这项回应的确认，请核实',true));},timeout);
      this.on('event',onEvent);this.once('offline',onOffline);
      try{this.write({id:req.id,result});}catch(e){cleanup();this.responding.delete(id);reject(e);}
    });
  }
  private write(value: Json) {
    if (!this.child || this.child.stdin.destroyed) throw new BridgeError('offline', 'Codex 未连接');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  private disconnected(error: Error) {
    this.child = null; this.requests.clear();this.responding.clear();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.emit('offline');
  }
  close() { this.child?.stdin.end(); this.child?.kill(); }
}
