import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { BridgeError, type Json } from '../shared/types.js';

// Protocol versions verified against Codex Desktop 26.901.6511.0. See SOURCES.md.
const versions: Record<string, number> = { 'thread-stream-state-changed': 11, 'thread-follower-start-turn': 2, 'thread-follower-interrupt-turn': 4 };
export function applyPatches(state: Json, patches: Json[]) {
  const next = structuredClone(state);
  for (const p of patches) {
    if (!Array.isArray(p.path) || !p.path.length || p.path.some((k: unknown) => ['__proto__','constructor','prototype'].includes(String(k)))) throw new Error('invalid_patch');
    let parent: any = next;
    for (const key of p.path.slice(0,-1)) { parent = parent?.[key]; if (!parent || typeof parent !== 'object') throw new Error('missing_patch_baseline'); }
    const key = p.path.at(-1);
    if (Array.isArray(parent)) {
      if (!Number.isInteger(key) || key < 0 || key > parent.length) throw new Error('invalid_patch_index');
      if (p.op === 'add') parent.splice(key, 0, p.value);
      else if (p.op === 'remove' && key < parent.length) parent.splice(key,1);
      else if (p.op === 'replace' && key < parent.length) parent[key] = p.value;
      else throw new Error('invalid_patch');
    } else if (p.op === 'remove') delete parent[key];
    else if (p.op === 'add' || p.op === 'replace') parent[key] = p.value;
    else throw new Error('invalid_patch');
  }
  return next;
}

export class Desktop extends EventEmitter {
  socket: net.Socket | null = null;
  clientId = '';
  states = new Map<string, { state: Json; revision: number; owner: string; hostId: string }>();
  private buffer = Buffer.alloc(0);
  private connecting: Promise<void> | null = null;
  private pending = new Map<string, { resolve: (v:any)=>void; reject:(e:Error)=>void; timer:NodeJS.Timeout }>();
  async connect() {
    if (this.clientId) return;
    if(this.connecting)return this.connecting;
    this.connecting=this.open();
    try {await this.connecting;} finally {this.connecting=null;}
  }
  private async open() {
    const paths = process.env.CODEX_IPC_PATH ? [process.env.CODEX_IPC_PATH] : process.platform === 'win32' ? ['\\\\.\\pipe\\codex-ipc'] : [join(process.env.CODEX_HOME || join(homedir(),'.codex'),'ipc','ipc.sock'), join(tmpdir(),'codex-ipc',`ipc-${process.getuid?.() || 0}.sock`)];
    for (const path of paths) {
      try {
        await new Promise<void>((resolve,reject)=>{
          const s = net.connect(path); this.socket = s; this.buffer = Buffer.alloc(0);
          const timer = setTimeout(()=>{s.destroy();reject(new Error('IPC connection timeout'));},1500);
          s.once('connect',()=>{clearTimeout(timer);resolve();});
          s.once('error',e=>{clearTimeout(timer);reject(e);});
          s.on('data',chunk=>this.receive(Buffer.from(chunk)));
          s.on('close',()=>{if(this.socket===s) this.reset();});
        });
        const r = await this.request('initialize',{clientType:'codex-mobile-web'},1500);
        this.clientId = r.clientId; return;
      } catch { this.close(); }
    }
    throw new BridgeError('desktop_offline','官方桌面未连接');
  }
  request(method: string, params: Json, timeout = 10_000): Promise<any> {
    return new Promise((resolve,reject)=>{
      const requestId = randomUUID();
      const timer = setTimeout(()=>{this.pending.delete(requestId);reject(new BridgeError('timeout',`桌面请求超时：${method}`,true));},timeout);
      this.pending.set(requestId,{resolve,reject,timer});
      try { this.write({type:'request',requestId,sourceClientId:this.clientId||'initializing-client',version:versions[method]||1,method,params}); }
      catch(e) {clearTimeout(timer);this.pending.delete(requestId);reject(e);}
    });
  }
  broadcast(method: string, params: Json) { this.write({type:'broadcast',sourceClientId:this.clientId,method,version:versions[method]||1,params}); }
  async follow(threadId: string, hostId = 'local') {
    await this.connect();
    if(this.states.has(threadId)){const cached=this.states.get(threadId)!;this.states.delete(threadId);this.states.set(threadId,cached);return cached.state;}
    await this.request('thread-owner-discovery',{hostId,conversationId:threadId},1500);
    this.broadcast('thread-stream-following-changed',{hostId,conversationId:threadId,following:true});
    await this.request('thread-follower-load-complete-history',{hostId,conversationId:threadId});
    for(let i=0;i<20 && !this.states.has(threadId);i++) await new Promise(r=>setTimeout(r,50));
    if (!this.states.has(threadId)) throw new BridgeError('no_snapshot','桌面尚未提供实时状态');
    while(this.states.size>8){const oldest=this.states.keys().next().value!;const entry=this.states.get(oldest)!;this.broadcast('thread-stream-following-changed',{conversationId:oldest,hostId:entry.hostId,following:false});this.states.delete(oldest);}
    return this.states.get(threadId)!.state;
  }
  private write(value: Json) {
    if(!this.socket || this.socket.destroyed) throw new BridgeError('desktop_offline','桌面连接已断开');
    const b=Buffer.from(JSON.stringify(value)),h=Buffer.alloc(4);h.writeUInt32LE(b.length);this.socket.write(Buffer.concat([h,b]));
  }
  private receive(chunk: Buffer) {
    this.buffer=Buffer.concat([this.buffer,chunk]);
    while(this.buffer.length>=4) {
      const n=this.buffer.readUInt32LE(0);
      if(n>64*1024*1024) {this.close();return;}
      if(this.buffer.length<4+n) return;
      const b=this.buffer.subarray(4,4+n);this.buffer=this.buffer.subarray(4+n);
      try { this.handle(JSON.parse(b.toString())); } catch { this.emit('diagnostic','invalid_desktop_frame'); }
    }
  }
  private handle(e: Json) {
    if(e.type==='client-discovery-request') {this.write({type:'client-discovery-response',requestId:e.requestId,response:{canHandle:false}});return;}
    if(e.type==='response') {
      const p=this.pending.get(e.requestId);if(!p)return;clearTimeout(p.timer);this.pending.delete(e.requestId);
      if(e.resultType==='error') p.reject(new BridgeError(/no-client-found/.test(String(e.error))?'no_owner':'desktop_error',String(e.error)));
      else p.resolve(e.result);return;
    }
    if(e.method==='thread-stream-state-changed') {
      const {conversationId:id,hostId,change:c}=e.params||{}, previous=this.states.get(id);
      if(!id||!c) return;
      if(c.type==='snapshot') {
        if(previous && previous.owner===e.sourceClientId && c.revision<previous.revision) return;
        this.states.set(id,{state:c.conversationState,revision:c.revision,owner:e.sourceClientId,hostId});
      } else if(c.type==='patches') {
        if(!previous || previous.owner!==e.sourceClientId || previous.revision!==c.baseRevision) {this.states.delete(id);this.emit('resync',id);return;}
        try {this.states.set(id,{...previous,state:applyPatches(previous.state,c.patches),revision:c.revision});}
        catch {this.states.delete(id);this.emit('resync',id);return;}
      }
      this.emit('change',id);
    }
    this.emit('envelope',e);
  }
  private reset() {const wasOnline=Boolean(this.clientId);this.clientId='';this.states.clear();for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new BridgeError('desktop_offline','桌面连接断开',true));}this.pending.clear();if(wasOnline)this.emit('offline');}
  close() {const s=this.socket;this.socket=null;s?.destroy();this.reset();}
}
