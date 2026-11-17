import {DatabaseSync} from 'node:sqlite';
import {open, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {BridgeError, textRequired, type Json} from '../shared/types.js';
import type {Ledger} from './ledger.js';
import {writeHub} from './antigravity-hub.js';

const guid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const idle = 'CASCADE_RUN_STATUS_IDLE';
const active = 'CASCADE_RUN_STATUS_RUNNING';
const tailSize = 1024 * 1024;
type Message = {id: string; role: 'user' | 'assistant' | 'tool'; text: string};
type Summary = {id: string; title: string; status: string; notIdle: number | null; modified: string; steps: number; userStep: number | null; userTime: string | null};
const columns = 'conversation_id AS id, title, status, not_fully_idle AS notIdle, last_modified_time AS modified, step_count AS steps, last_user_input_step_index AS userStep, last_user_input_time AS userTime';
const turnKey = (summary: Summary) => JSON.stringify([summary.userStep, summary.userTime]);
const canSend = (summary: Summary) => summary.status === idle && !summary.notIdle;

async function messages(path: string): Promise<Message[]> {
  const file = await open(path, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!file) return [];
  try {
    const {size} = await file.stat();
    const start = Math.max(0, size - tailSize);
    const data = Buffer.alloc(size - start);
    const {bytesRead} = await file.read(data, 0, data.length, start);
    const lines = data.toString('utf8', 0, bytesRead).split('\n');
    if (start) lines.shift(); // The first line may start in the middle of a UTF-8 character.
    const result = new Map<string, Message>();
    for (const line of lines) {
      let step;
      try { step = JSON.parse(line); } catch { continue; }
      if (!Number.isSafeInteger(step?.step_index)) continue;
      const id = String(step.step_index);
      if (step.type === 'USER_INPUT' && typeof step.content === 'string') {
        const text = /^\s*<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>(?:\s*<ADDITIONAL_METADATA>|\s*$)/.exec(step.content)?.[1] ?? step.content;
        result.set(id, {id, role: 'user', text: text.trim()});
      } else if (step.type === 'PLANNER_RESPONSE') {
        if (typeof step.content === 'string' && step.content.trim()) result.set(id, {id, role: 'assistant', text: step.content});
        const tools = Array.isArray(step.tool_calls) ? step.tool_calls.map((tool: Json) => tool?.name).filter((n: unknown) => typeof n === 'string') : [];
        if (tools.length) result.set(id + '-tools', {id: id + '-tools', role: 'tool', text: tools.join('、')});
      }
    }
    return [...result.values()].slice(-100);
  } finally { await file.close(); }
}

export class AntigravityBridge {
  private writing = new Set<string>();
  private watchers = 0;
  private recent = new Map<string, {revision: string; messages: Message[]}>();
  constructor(private root: string, private ledger: Ledger, private write = writeHub) {}

  private index<T>(read: (db: DatabaseSync) => T): T {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(join(this.root, 'conversation_summaries.db'), {readOnly: true});
      return read(db);
    } catch {
      throw new BridgeError('unavailable', '无法读取 Antigravity 会话索引，请在这台电脑打开桌面应用并建立一次对话。');
    } finally { db?.close(); }
  }

  private summary(id: string) {
    const row = this.index(db => db.prepare(`SELECT ${columns} FROM conversation_summaries WHERE conversation_id=?`).get(id)) as Summary | undefined;
    if (!row) throw new BridgeError('missing', '桌面上找不到这条 Antigravity 会话');
    return row;
  }

  private async snapshot(id: string) {
    const summary = this.summary(id);
    const path = join(this.root, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
    const file = await stat(path, {bigint: true}).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
      return null;
    });
    const revision = JSON.stringify([summary.modified, summary.steps, summary.status, summary.notIdle, turnKey(summary), summary.title, String(file?.mtimeNs), String(file?.size)]);
    return {path, revision, turn: turnKey(summary), title: summary.title || '未命名对话', running: summary.status === active,
      canSend: canSend(summary)};
  }

  private async read(id: string, known?: string) {
    const previous = this.recent.get(id);
    let current = await this.snapshot(id);
    if (known && known === current.revision) {
      if (this.watchers >= 32) throw new BridgeError('busy', '观察请求较多，请稍后重试');
      this.watchers++;
      try {
        const deadline = Date.now() + 15_000;
        while (known === current.revision && Date.now() < deadline) {
          await delay(650);
          current = await this.snapshot(id);
        }
      } finally { this.watchers--; }
      if (known === current.revision) return {unchanged: true};
    }
    const {path, ...view} = current;
    const items = await messages(path);
    this.recent.delete(id);
    this.recent.set(id, {revision: view.revision, messages: items});
    if (this.recent.size > 8) this.recent.delete(this.recent.keys().next().value!);
    if (previous && previous.revision === known) {
      let keep = 0;
      while (keep < items.length && items[keep].id === previous.messages[keep]?.id &&
             items[keep].text === previous.messages[keep].text && items[keep].role === previous.messages[keep].role) keep++;
      return {...view, base: known, keep, messages: items.slice(keep)};
    }
    return {...view, messages: items, notice: '显示桌面已记录的最近对话内容。'};
  }

  async handle(action: string, p: Json): Promise<Json> {
    if (action === 'antigravity.list') {
      const offset = Number.isSafeInteger(p.offset) && p.offset >= 0 ? p.offset : 0;
      const rows = this.index(db => db.prepare(`SELECT conversation_id AS id, title FROM conversation_summaries ORDER BY last_modified_time DESC, conversation_id LIMIT 51 OFFSET ?`).all(offset));
      return {data: rows.slice(0, 50).map(row => ({id: row.id, title: row.title || '未命名对话'})), hasMore: rows.length > 50};
    }
    if (action === 'antigravity.operation') return this.ledger.read(textRequired(p.opId, '操作标识', 100));
    const id = textRequired(p.conversationId, '会话', 36);
    if (!guid.test(id)) throw new BridgeError('invalid', 'Antigravity 会话 ID 无效');
    if (action === 'antigravity.read') return this.read(id);
    if (action === 'antigravity.watch') return this.read(id, textRequired(p.revision, '会话版本', 4096));
    if (action !== 'antigravity.send' && action !== 'antigravity.stop') throw new BridgeError('unsupported', '不支持此 Antigravity 操作');
    const text = action === 'antigravity.send' ? textRequired(p.text, '消息', 50_000) : undefined;
    const opId = textRequired(p.opId, '操作标识', 100);
    const turn = textRequired(p.turn, '对话轮次', 200);
    return this.ledger.run(opId, {action, id, text, turn}, async () => {
      if (this.writing.has(id)) throw new BridgeError('busy', '此会话正在处理另一次操作');
      const summary = this.summary(id);
      if (turnKey(summary) !== turn || !(text ? canSend(summary) : summary.status === active)) throw new BridgeError('changed', '会话状态已变化，请刷新后再操作');
      this.writing.add(id);
      try {
        const directory = join(this.root, 'daemon');
        if (text) {
          await this.write(directory, 'SendUserCascadeMessage', {cascadeId: id, items: [{text}], clientMessageId: opId.split(':')[1]});
          return {submitted: true};
        }
        await this.write(directory, 'CancelCascadeInvocation', {cascadeId: id, killBackgroundTasks: false});
        return {stopRequested: true};
      } finally { this.writing.delete(id); }
    });
  }
}
