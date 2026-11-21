import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {open, readFile, readdir, stat} from 'node:fs/promises';
import {dirname, isAbsolute, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readProjectFile, downloadProjectFile} from './project.js';
import {setTimeout as delay} from 'node:timers/promises';
import {BridgeError, textRequired, type AntigravityIssue, type AntigravityMessage, type AntigravityModel, type Json} from '../shared/types.js';
import type {Ledger} from './ledger.js';
import {callHub} from './antigravity-hub.js';
import {validateImages} from '../shared/images.js';
import {MAX_ATTACHMENTS, type FileAttachment} from '../shared/attachments.js';
import {attachmentIds, requestFiles, scopedUpload, withAttachmentLinks} from './attachments.js';
import {sendersByText} from './message-senders.js';

const guid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const idle = 'CASCADE_RUN_STATUS_IDLE';
const active = 'CASCADE_RUN_STATUS_RUNNING';
// The full transcript keeps tool output too, so read a larger tail of it.
const tailSize = 4 * 1024 * 1024;
type Summary = {id: string; title: string; status: string; notIdle: number | null; modified: string; steps: number; userStep: number | null; userTime: string | null; workspaces: string};
const columns = 'conversation_id AS id, title, status, not_fully_idle AS notIdle, last_modified_time AS modified, step_count AS steps, last_user_input_step_index AS userStep, last_user_input_time AS userTime, workspace_uris AS workspaces';
const workspaceEntries = "json_each(CASE WHEN json_valid(workspace_uris) THEN workspace_uris ELSE '[]' END)";
const turnKey = (summary: Summary) => JSON.stringify([summary.userStep, summary.userTime]);
const canSend = (summary: Summary) => summary.status === idle && !summary.notIdle;

function localWorkspace(value: unknown) {
  if(typeof value!=='string')return '';
  try {const url=new URL(value);return url.host?'':fileURLToPath(url);} catch {return '';}
}
const sameFolder = (a: string, b: string) => Boolean(a) && a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
function singleWorkspace(value: string) {
  try {const roots=JSON.parse(value);return Array.isArray(roots)&&roots.length===1?localWorkspace(roots[0]):'';} catch {return '';}
}

/** Phone images (data URLs) as the desktop's `media` items: `exa.codeium_common_pb.Media` with inline bytes. */
export function antigravityMedia(images: string[]): Json[] {
  return images.map(url => ({mimeType: url.slice(5, url.indexOf(';')), inlineData: url.slice(url.indexOf(',') + 1)}));
}
const readImages = (value: unknown) => value === undefined ? [] : validateImages(value);
// The ledger keeps what each operation asked for; image hashes and upload IDs are enough to tell two requests apart.
const attached = (images: string[], files: FileAttachment[]) => ({
  ...(images.length ? {images: images.map(url => createHash('sha256').update(url).digest('hex'))} : {}),
  ...(files.length ? {files: attachmentIds(files)} : {}),
});
/** With files the links carry the message, so the typed text may be empty. */
const messageText = (value: unknown, files: FileAttachment[]) => files.length && (value === undefined || value === '') ? '' : textRequired(value, '消息', 50_000);
function checkCount(images: string[], files: FileAttachment[]) {
  if (images.length + files.length > MAX_ATTACHMENTS) throw new BridgeError('invalid', `图片和文件合计最多添加 ${MAX_ATTACHMENTS} 个`);
}
const newScope = (path: string) => `antigravity-new:${path}`, conversationScope = (id: string) => `antigravity:${id}`;

function readIssue(step: Json): AntigravityIssue {
  const error = typeof step.error === 'string' ? step.error : '';
  const attempt = /^API error \(attempt (\d+)\):/i.exec(error);
  if (attempt) return {kind: 'retry', attempt: Number(attempt[1]),
    connection: /\b(?:eof|connection (?:reset|refused|closed|timed out)|wsarecv|proxyconnect)\b/i.test(error)};
  if (/^The stream was interrupted\b/i.test(error)) return {kind: 'interrupted'};
  return {kind: 'error'};
}

async function transcript(path: string): Promise<{messages: AntigravityMessage[]; issue: AntigravityIssue | null}> {
  const file = await open(path, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!file) return {messages: [], issue: null};
  try {
    const {size} = await file.stat();
    const start = Math.max(0, size - tailSize);
    const data = Buffer.alloc(size - start);
    const {bytesRead} = await file.read(data, 0, data.length, start);
    const lines = data.toString('utf8', 0, bytesRead).split('\n');
    if (start) lines.shift(); // The first line may start in the middle of a UTF-8 character.
    const result = new Map<string, AntigravityMessage>();
    let issue: AntigravityIssue | null = null;
    for (const line of lines) {
      let step;
      try { step = JSON.parse(line); } catch { continue; }
      if (!Number.isSafeInteger(step?.step_index)) continue;
      const id = String(step.step_index);
      if (step.type === 'USER_INPUT' && typeof step.content === 'string') {
        issue = null;
        const text = /^\s*<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>(?:\s*<ADDITIONAL_METADATA>|\s*$)/.exec(step.content)?.[1] ?? step.content;
        result.set(id, {id, role: 'user', text: text.trim()});
      } else if (step.type === 'PLANNER_RESPONSE') {
        issue = null;
        if (typeof step.content === 'string' && step.content.trim()) result.set(id, {id, role: 'assistant', text: step.content});
        const tools = Array.isArray(step.tool_calls) ? step.tool_calls.map((tool: Json) => tool?.name).filter((n: unknown) => typeof n === 'string') : [];
        if (tools.length) result.set(id + '-tools', {id: id + '-tools', role: 'tool', text: tools.join('、')});
      } else if (step.type === 'ERROR_MESSAGE') {
        issue = readIssue(step);
      }
    }
    return {messages: [...result.values()].slice(-100), issue};
  } finally { await file.close(); }
}

export class AntigravityBridge {
  private writing = new Set<string>();
  private watchers = 0;
  private recent = new Map<string, {revision: string; messages: AntigravityMessage[]}>();
  constructor(private root: string, private ledger: Ledger, private hub = callHub,
    private projectsDir = join(dirname(root), 'config', 'projects')) {}

  /** Desktop projects (`~/.gemini/config/projects`); a new conversation needs its project's ID to show under that project. */
  private async desktopProjects(): Promise<{id: string; name: string; path: string}[]> {
    const names = await readdir(this.projectsDir).catch(() => [] as string[]);
    const projects = await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => {
      try {
        const project = JSON.parse(await readFile(join(this.projectsDir, name), 'utf8'));
        const resources = Array.isArray(project?.projectResources?.resources) ? project.projectResources.resources : [];
        const roots = resources.map((item: Json) => localWorkspace(item?.folderUri ?? item?.gitFolder?.folderUri)).filter(Boolean);
        return typeof project.id === 'string' && roots.length === 1 ? [{id: project.id, name: typeof project.name === 'string' ? project.name : '', path: roots[0] as string}] : [];
      } catch { return []; }
    }));
    return projects.flat();
  }

  /** Settings of the latest message in this project (else anywhere), which the desktop sends with every message. */
  private async latestConfig(path: string): Promise<Json | null> {
    const rows = this.index(db => db.prepare(`SELECT ${columns} FROM conversation_summaries WHERE step_count > 0
      ORDER BY last_modified_time DESC LIMIT 20`).all()) as Summary[];
    rows.sort((a, b) => Number(sameFolder(singleWorkspace(b.workspaces), path)) - Number(sameFolder(singleWorkspace(a.workspaces), path)));
    for (const row of rows.slice(0, 4)) {
      // Some desktop conversations keep the user step at -1 although their first step is the user's message.
      const config = await this.turnConfig({...row, userStep: row.userStep != null && row.userStep >= 0 ? row.userStep : 0}).catch(() => null);
      if (config?.plannerConfig) return config;
    }
    return null;
  }

  private async withModel(config: Json | null, model: string | undefined): Promise<Json | null> {
    if (!model) return config;
    const models = await this.models();
    if (!models.some(option => option.id === model)) throw new BridgeError('invalid', '所选模型已不可用，请重新选择');
    const plannerConfig = {...config?.plannerConfig, planModel: model};
    delete plannerConfig.requestedModel;
    delete plannerConfig.modelName;
    return {...config, plannerConfig};
  }

  private async create(p: Json): Promise<Json> {
    const project = textRequired(p.project, '项目', 4096);
    const files = requestFiles(p.files), text = messageText(p.text, files);
    const opId = textRequired(p.opId, '操作标识', 100);
    const model = p.model !== undefined && p.model !== '' ? textRequired(p.model, '模型', 200) : undefined;
    const images = readImages(p.images);
    checkCount(images, files);
    const path = localWorkspace(project);
    if (!path) throw new BridgeError('invalid', '请选择这台电脑上的项目');
    return this.ledger.run(opId, {action: 'antigravity.create', project, text, ...attached(images, files), ...(model ? {model} : {})}, async () => {
      const prompt = await withAttachmentLinks(this.ledger, newScope(path), text, files);
      const desktop = (await this.desktopProjects()).find(item => sameFolder(item.path, path));
      const config = await this.withModel(await this.latestConfig(path), model);
      const directory = join(this.root, 'daemon');
      const started = await this.hub(directory, 'StartCascade', {workspaceUris: [project], source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
        trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE', ...(desktop ? {projectEnvConfig: {projectId: desktop.id}} : {})});
      const id = started.cascadeId;
      if (typeof id !== 'string' || !guid.test(id)) throw new BridgeError('uncertain', '桌面未返回新会话，请在电脑核实', true);
      const message: Json = {cascadeId: id, items: [{text: prompt}], ...(images.length ? {media: antigravityMedia(images)} : {}),
        clientMessageId: opId.split(':')[1], ...(config ? {cascadeConfig: config} : {})};
      try {
        await this.hub(directory, 'SendUserCascadeMessage', message);
      } catch (error) {
        // The conversation exists either way: open it, and its history shows whether the message arrived.
        if (error instanceof BridgeError && error.uncertain) return {conversationId: id, submitted: false, uncertain: true};
        await this.hub(directory, 'DeleteCascadeTrajectory', {cascadeId: id}).catch(() => {});
        throw error;
      }
      this.ledger.recordUsage({id: `antigravity:${id}:${opId}`, service: 'antigravity', threadId: id, turnId: opId, opId, models: []});
      this.ledger.recordSender({service: 'antigravity', threadId: id, opId, kind: 'text', text: prompt});
      return {conversationId: id, submitted: true};
    });
  }

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

  private async models(): Promise<AntigravityModel[]> {
    const result = await this.hub(join(this.root, 'daemon'), 'GetCascadeModelConfigData', {});
    if (!Array.isArray(result.clientModelConfigs)) throw new BridgeError('unavailable', '桌面尚未提供模型列表，请稍后重试');
    return result.clientModelConfigs.flatMap((config: Json) => {
      const id = config.modelOrAlias?.model;
      return !config.disabled && typeof id === 'string' && id && typeof config.label === 'string' && config.label
        ? [{id, label: config.label}] : [];
    });
  }

  private async turnConfig(summary: Summary): Promise<Json> {
    if (summary.userStep == null || summary.userStep < 0) return {};
    const {turns} = await this.hub(join(this.root, 'daemon'), 'GetTrajectoryTurns', {cascadeId: summary.id, stepIndices: [summary.userStep]});
    const user = turns?.find((turn: Json) => (turn.startStepIndex ?? 0) === summary.userStep)?.firstStep?.userInput;
    if (!user) throw new BridgeError('changed', '无法读取原会话的模型设置，请刷新后重试');
    return user.userConfig ?? {};
  }

  private async snapshot(id: string) {
    const summary = this.summary(id);
    // transcript.jsonl cuts long steps short ("<truncated N bytes>"); transcript_full.jsonl keeps them whole.
    const logs = join(this.root, 'brain', id, '.system_generated', 'logs');
    let path = '', file = null;
    for (const name of ['transcript_full.jsonl', 'transcript.jsonl']) {
      path = join(logs, name);
      file = await stat(path, {bigint: true}).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
        return null;
      });
      if (file) break;
    }
    const cwd=singleWorkspace(summary.workspaces);
    const revision = JSON.stringify([summary.modified, summary.steps, summary.status, summary.notIdle, turnKey(summary), summary.title, cwd, String(file?.mtimeNs), String(file?.size)]);
    return {path, revision, turn: turnKey(summary), title: summary.title || '未命名对话', cwd, running: summary.status === active,
      canSend: canSend(summary), supportsModelSelection: true, supportsImages: true};
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
    const {messages: items, issue} = await transcript(path);
    // Messages sent from the phone carry their sender, matched by the exact text the connector sent.
    const records = this.ledger.senders('antigravity', id);
    if (records.length) {
      const senders = sendersByText(items.filter(item => item.role === 'user'), records);
      for (const item of items) {const sender = senders.get(item.id);if (sender) item.sender = sender;}
    }
    this.recent.delete(id);
    this.recent.set(id, {revision: view.revision, messages: items});
    if (this.recent.size > 8) this.recent.delete(this.recent.keys().next().value!);
    if (previous && previous.revision === known) {
      let keep = 0;
      while (keep < items.length && items[keep].id === previous.messages[keep]?.id &&
             items[keep].text === previous.messages[keep].text && items[keep].role === previous.messages[keep].role) keep++;
      return {...view, issue, base: known, keep, messages: items.slice(keep)};
    }
    return {...view, issue, messages: items, notice: '显示桌面已记录的最近对话内容。'};
  }

  async handle(action: string, p: Json): Promise<Json> {
    if (action === 'antigravity.create') return this.create(p);
    if (action === 'antigravity.models' && !p.conversationId) {
      const project = p.project ? localWorkspace(textRequired(p.project, '项目', 4096)) : '';
      const [models, config] = await Promise.all([this.models(), this.latestConfig(project).catch(() => null)]);
      return {models, current: config?.plannerConfig?.planModel ?? null, supportsImages: true};
    }
    if (action === 'antigravity.list') {
      const named = await this.desktopProjects();
      const offset = Number.isSafeInteger(p.offset) && p.offset >= 0 ? p.offset : 0;
      const project=p.project?textRequired(p.project,'项目',4096):null;
      const search=p.search?textRequired(p.search,'搜索内容',200):null;
      return this.index(db=>{
        const rows=db.prepare(`SELECT conversation_id AS id, title, status, last_modified_time AS modified FROM conversation_summaries
          WHERE (? IS NULL OR EXISTS (SELECT 1 FROM ${workspaceEntries} AS workspace WHERE workspace.value=?))
          AND (? IS NULL OR instr(lower(coalesce(nullif(title,''),'未命名对话')),lower(?))>0)
          ORDER BY last_modified_time DESC, conversation_id LIMIT 51 OFFSET ?`).all(project,project,search,search,offset);
        const projects=!offset&&!search?db.prepare(`SELECT DISTINCT workspace.value AS uri FROM conversation_summaries, ${workspaceEntries} AS workspace WHERE workspace.type='text' ORDER BY uri`).all().flatMap(({uri})=>{
          const path=localWorkspace(uri),name=named.find(item=>sameFolder(item.path,path))?.name;return path?[{id:uri,path,...(name?{name}:{})}]:[];
        }):undefined;
        return {data:rows.slice(0,50).map(row=>({id:row.id,title:row.title||'未命名对话',
          running:row.status===active,updatedAt:Date.parse(String(row.modified))||0})),hasMore:rows.length>50,projects};
      });
    }
    if (action === 'antigravity.operation') return this.ledger.read(textRequired(p.opId, '操作标识', 100));
    if (action === 'antigravity.file.uploadStart' || action === 'antigravity.file.uploadChunk') {
      const stage = action === 'antigravity.file.uploadChunk' ? 'chunk' : 'start';
      // Before a conversation exists, its files belong to the project it will start in.
      if (p.conversationId === undefined) {
        const path = localWorkspace(textRequired(p.project, '项目', 4096));
        if (!path) throw new BridgeError('invalid', '请选择这台电脑上的项目');
        return scopedUpload(this.ledger, stage, newScope(path), async () => path, p);
      }
      const id = textRequired(p.conversationId, '会话', 36);
      if (!guid.test(id)) throw new BridgeError('invalid', 'Antigravity 会话 ID 无效');
      return scopedUpload(this.ledger, stage, conversationScope(id), async () => {
        const cwd = singleWorkspace(this.summary(id).workspaces);
        if (!cwd) throw new BridgeError('invalid', '这条会话没有唯一的本机项目目录，无法保存附件');
        return cwd;
      }, p);
    }
    const id = textRequired(p.conversationId, '会话', 36);
    if (!guid.test(id)) throw new BridgeError('invalid', 'Antigravity 会话 ID 无效');
    if (action === 'antigravity.file.read' || action === 'antigravity.file.download') {
      const path = textRequired(p.path, '文件路径', 4096);
      if (/^[\\/]{2}/.test(path)) throw new BridgeError('invalid', '请选择本机文件');
      const row = this.index(db => db.prepare('SELECT workspace_uris FROM conversation_summaries WHERE conversation_id=?').get(id));
      if (!row) throw new BridgeError('missing', '桌面上找不到这条 Antigravity 会话');
      const cwd=isAbsolute(path)?'':singleWorkspace(String(row.workspace_uris));
      return action === 'antigravity.file.read' ? readProjectFile(cwd, path)
        : downloadProjectFile(cwd, path, textRequired(p.revision, '文件版本', 64), p.offset);
    }
    if (action === 'antigravity.models') {
      const summary = this.summary(id);
      const [models, config] = await Promise.all([this.models(), this.turnConfig(summary).catch(() => null)]);
      return {models, current: config?.plannerConfig?.planModel ?? null, supportsImages: true};
    }
    if (action === 'antigravity.read') return this.read(id);
    if (action === 'antigravity.watch') return this.read(id, textRequired(p.revision, '会话版本', 4096));
    if (action !== 'antigravity.send' && action !== 'antigravity.stop') throw new BridgeError('unsupported', '不支持此 Antigravity 操作');
    const sending = action === 'antigravity.send';
    const files = sending ? requestFiles(p.files) : [], text = sending ? messageText(p.text, files) : undefined;
    const opId = textRequired(p.opId, '操作标识', 100);
    const turn = textRequired(p.turn, '对话轮次', 200);
    const model = sending && p.model !== undefined ? textRequired(p.model, '模型', 200) : undefined;
    const images = sending ? readImages(p.images) : [];
    checkCount(images, files);
    return this.ledger.run(opId, {action, id, text, turn, ...attached(images, files), ...(model ? {model} : {})}, async () => {
      if (this.writing.has(id)) throw new BridgeError('busy', '此会话正在处理另一次操作');
      const summary = this.summary(id);
      if (turnKey(summary) !== turn || !(sending ? canSend(summary) : summary.status === active)) throw new BridgeError('changed', '会话状态已变化，请刷新后再操作');
      this.writing.add(id);
      try {
        const directory = join(this.root, 'daemon');
        if (sending) {
          const prompt = await withAttachmentLinks(this.ledger, conversationScope(id), text!, files);
          const message: Json = {cascadeId: id, items: [{text: prompt}], ...(images.length ? {media: antigravityMedia(images)} : {}), clientMessageId: opId.split(':')[1]};
          if (model) {
            message.cascadeConfig = await this.withModel(await this.turnConfig(summary), model);
            const latest = this.summary(id);
            if (turnKey(latest) !== turn || !canSend(latest)) throw new BridgeError('changed', '会话状态已变化，请刷新后再发送');
          }
          await this.hub(directory, 'SendUserCascadeMessage', message);
          // Antigravity reports no tokens; the turn still counts for whoever sent it.
          this.ledger.recordUsage({id: `antigravity:${id}:${opId}`, service: 'antigravity', threadId: id, turnId: opId, opId, models: []});
          this.ledger.recordSender({service: 'antigravity', threadId: id, opId, kind: 'text', text: prompt});
          return {submitted: true};
        }
        await this.hub(directory, 'CancelCascadeInvocation', {cascadeId: id, killBackgroundTasks: false});
        return {stopRequested: true};
      } finally { this.writing.delete(id); }
    });
  }
}
