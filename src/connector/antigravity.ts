import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {open, readFile, readdir, stat} from 'node:fs/promises';
import {dirname, isAbsolute, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readProjectFile, downloadProjectFile, openProjectDownload} from './project.js';
import {setTimeout as delay} from 'node:timers/promises';
import {
  ANTIGRAVITY_PERMISSION_MODES,
  BridgeError,
  textRequired,
  type AntigravityBackgroundTask,
  type AntigravityIssue,
  type AntigravityMessage,
  type AntigravityModel,
  type AntigravityModelGroup,
  type AntigravityPermissionMode,
  type ApprovalRequest,
  type Json,
  type QueuedMessage,
} from '../shared/types.js';
import type {Ledger} from './ledger.js';
import {callHub} from './antigravity-hub.js';
import {imageBytes, validateImages} from '../shared/images.js';
import {MAX_ATTACHMENTS, type FileAttachment} from '../shared/attachments.js';
import {attachmentIds, requestFiles, scopedUpload, withAttachmentLinks} from './attachments.js';
import {sendersByText} from './message-senders.js';
import type {ThreadSource} from './thread-hub.js';

const guid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const idle = 'CASCADE_RUN_STATUS_IDLE';
const active = 'CASCADE_RUN_STATUS_RUNNING';
const canceling = 'CASCADE_RUN_STATUS_CANCELING';
const waitingStep = 'CORTEX_STEP_STATUS_WAITING';
const runningStep = 'CORTEX_STEP_STATUS_RUNNING';
const ERROR_STEP = 'CORTEX_STEP_TYPE_ERROR_MESSAGE';
const USER_INPUT_STEP = 'CORTEX_STEP_TYPE_USER_INPUT';
const PLANNER_RESPONSE_STEP = 'CORTEX_STEP_TYPE_PLANNER_RESPONSE';
const NEXT_INVOCATION = 'MESSAGE_DELIVERY_STRATEGY_NEXT_INVOCATION';
const SEND_MODES = ['queue', 'steer', 'now'] as const;
type SendMode = typeof SEND_MODES[number];
function sendMode(value: unknown): SendMode {
  if (value === undefined || value === null || value === '') return 'queue';
  if (!SEND_MODES.includes(value as SendMode)) throw new BridgeError('invalid', '发送方式无效');
  return value as SendMode;
}
// The full transcript keeps tool output too, so read a larger tail of it.
const tailSize = 4 * 1024 * 1024;
const WAITING_STEP_WINDOW = 25;
const TASK_OUTPUT_LIMIT = 32 * 1024;
type Summary = {id: string; title: string; status: string; notIdle: number | null; modified: string; steps: number; userStep: number | null; userTime: string | null; workspaces: string};
const columns = 'conversation_id AS id, title, status, not_fully_idle AS notIdle, last_modified_time AS modified, step_count AS steps, last_user_input_step_index AS userStep, last_user_input_time AS userTime, workspace_uris AS workspaces';
const workspaceEntries = "json_each(CASE WHEN json_valid(workspace_uris) THEN workspace_uris ELSE '[]' END)";
const turnKey = (summary: Summary) => JSON.stringify([summary.userStep, summary.userTime]);
// `not_fully_idle` also stays set while a background command is running after the turn ended; desktop still accepts messages then.
const canSend = (summary: Summary) => summary.status === idle;
const hasConfiguredModel = (config: Json | null | undefined): boolean =>
  Boolean(config?.plannerConfig && (config.plannerConfig.planModel || config.plannerConfig.requestedModel));

const PERMISSION_PRESET_SET = new Set<string>(ANTIGRAVITY_PERMISSION_MODES);
const isPermissionPreset = (value: unknown): value is AntigravityPermissionMode =>
  typeof value === 'string' && PERMISSION_PRESET_SET.has(value);

const PRESET_TO_AUTO_EXECUTION: Partial<Record<AntigravityPermissionMode, string>> = {
  AGENT_PERMISSION_PRESET_REQUEST_REVIEW: 'CASCADE_COMMANDS_AUTO_EXECUTION_OFF',
  AGENT_PERMISSION_PRESET_AUTO: 'CASCADE_COMMANDS_AUTO_EXECUTION_AUTO',
  AGENT_PERMISSION_PRESET_TURBO: 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER',
};

const CONFIRM_INTERACTION_LABELS: Record<string, string> = {
  mcp: '允许调用 MCP 工具',
  openBrowserUrl: '允许打开网页',
  readUrlContent: '允许读取网页内容',
  runExtensionCode: '允许运行扩展代码',
  executeBrowserJavascript: '允许在浏览器中执行脚本',
  captureBrowserScreenshot: '允许截取浏览器画面',
  clickBrowserPixel: '允许点击浏览器页面',
  sendCommandInput: '允许向终端发送输入',
  browserAction: '允许执行浏览器操作',
  confirmBrowserSetup: '确认浏览器环境设置',
  openBrowserSetup: '打开浏览器环境设置',
};

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
const readPermissionMode = (value: unknown): AntigravityPermissionMode | undefined => {
  if (value === undefined || value === '') return undefined;
  if (!isPermissionPreset(value)) throw new BridgeError('invalid', '权限模式无效');
  return value;
};
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

/**
 * Parses `GetCascadeModelConfigData` into a flat backwards-compatible model list plus grouped models
 * (model family + thinking effort variants), preserving the desktop's recommended sort order.
 */
export function parseAntigravityModels(result: Json): {
  models: AntigravityModel[];
  groups?: AntigravityModelGroup[];
  defaultModel?: string;
} {
  if (!Array.isArray(result?.clientModelConfigs)) throw new BridgeError('unavailable', '桌面尚未提供模型列表，请稍后重试');
  const sortLabels: string[] = Array.isArray(result.clientModelSorts)
    ? result.clientModelSorts.flatMap((sort: Json) => Array.isArray(sort?.groups) ? sort.groups.flatMap((g: Json) => Array.isArray(g?.modelLabels) ? g.modelLabels : []) : [])
    : [];
  const sortRank = new Map<string, number>();
  sortLabels.forEach((label, index) => { if (typeof label === 'string' && !sortRank.has(label)) sortRank.set(label, index); });

  const groupedRaw: Record<string, Json> | null = result.groupedModels && typeof result.groupedModels === 'object' && !Array.isArray(result.groupedModels)
    ? result.groupedModels : null;
  const defaultId = typeof result.defaultOverrideModelConfig?.modelOrAlias?.model === 'string'
    ? result.defaultOverrideModelConfig.modelOrAlias.model : undefined;

  type EnabledConfig = {id: string; label: string; modelId?: string; description?: string; supportsImages?: boolean; order: number};
  const enabled: EnabledConfig[] = [];
  result.clientModelConfigs.forEach((config: Json, index: number) => {
    const id = config?.modelOrAlias?.model;
    if (config?.disabled || typeof id !== 'string' || !id || typeof config.label !== 'string' || !config.label) return;
    const rank = sortRank.get(config.label);
    enabled.push({
      id,
      label: config.label,
      ...(typeof config.modelId === 'string' && config.modelId ? {modelId: config.modelId} : {}),
      ...(typeof config.tagDescription === 'string' && config.tagDescription ? {description: config.tagDescription} : {}),
      ...(typeof config.supportsImages === 'boolean' ? {supportsImages: config.supportsImages} : {}),
      order: rank ?? (sortRank.size + index),
    });
  });
  enabled.sort((a, b) => a.order - b.order);

  // Match each config against `groupedModels` (where config.modelId === `${groupKey}-${thinkingSuffix}`).
  const groupKeys = groupedRaw ? Object.keys(groupedRaw) : [];
  const models: AntigravityModel[] = [];
  const groupMap = new Map<string, {
    id: string;
    label: string;
    description?: string;
    allowedEfforts: string[];
    variants: Record<string, string>;
    supportsImages?: boolean;
    order: number;
  }>();
  const standaloneGroups: (AntigravityModelGroup & {order: number})[] = [];

  for (const item of enabled) {
    let matchedGroup: string | undefined;
    let matchedEffort: string | undefined;
    if (groupedRaw && item.modelId) {
      for (const key of groupKeys) {
        if (!item.modelId.startsWith(key + '-')) continue;
        const suffix = item.modelId.slice(key.length + 1);
        const levels: Json[] = Array.isArray(groupedRaw[key]?.supportedThinkingLevels) ? groupedRaw[key].supportedThinkingLevels : [];
        if (levels.some(level => level?.thinkingSuffix === suffix)) {
          matchedGroup = key;
          matchedEffort = suffix;
          break;
        }
      }
    }

    const entry: AntigravityModel = {
      id: item.id,
      label: item.label,
      ...(item.description ? {description: item.description} : {}),
      ...(item.supportsImages !== undefined ? {supportsImages: item.supportsImages} : {}),
      ...(matchedGroup ? {group: matchedGroup, groupLabel: String(groupedRaw![matchedGroup]?.displayName || matchedGroup), effort: matchedEffort} : {}),
    };
    models.push(entry);

    if (matchedGroup && matchedEffort) {
      let group = groupMap.get(matchedGroup);
      if (!group) {
        const meta = groupedRaw![matchedGroup];
        const allowedEfforts = (Array.isArray(meta?.supportedThinkingLevels) ? meta.supportedThinkingLevels : [])
          .map((level: Json) => level?.thinkingSuffix)
          .filter((suffix: unknown): suffix is string => typeof suffix === 'string' && Boolean(suffix));
        group = {
          id: matchedGroup,
          label: typeof meta?.displayName === 'string' && meta.displayName ? meta.displayName : matchedGroup,
          ...(item.description ? {description: item.description} : {}),
          allowedEfforts,
          variants: {},
          ...(item.supportsImages !== undefined ? {supportsImages: item.supportsImages} : {}),
          order: item.order,
        };
        groupMap.set(matchedGroup, group);
      }
      group.variants[matchedEffort] = item.id;
      if (item.supportsImages === true) group.supportsImages = true;
      if (!group.description && item.description) group.description = item.description;
      group.order = Math.min(group.order, item.order);
    } else if (groupedRaw) {
      standaloneGroups.push({
        id: item.id,
        label: item.label,
        ...(item.description ? {description: item.description} : {}),
        supportsImages: item.supportsImages === true,
        order: item.order,
      });
    }
  }

  let groups: AntigravityModelGroup[] | undefined;
  if (groupedRaw) {
    const built: (AntigravityModelGroup & {order: number})[] = [...standaloneGroups];
    for (const group of groupMap.values()) {
      const efforts = group.allowedEfforts.filter(suffix => Boolean(group.variants[suffix]));
      if (!efforts.length) continue;
      const defaultFromOverride = defaultId ? efforts.find(suffix => group.variants[suffix] === defaultId) : undefined;
      const defaultEffort = defaultFromOverride || (efforts.includes('medium') ? 'medium' : efforts[0]);
      built.push({
        id: group.id,
        label: group.label,
        ...(group.description ? {description: group.description} : {}),
        efforts,
        defaultEffort,
        variants: group.variants,
        supportsImages: group.supportsImages === true,
        order: group.order,
      });
    }
    built.sort((a, b) => a.order - b.order);
    groups = built.map(({order: _order, ...group}) => group);
  }

  const defaultModel = defaultId && models.some(m => m.id === defaultId) ? defaultId : undefined;
  return {models, ...(groups?.length ? {groups} : {}), ...(defaultModel ? {defaultModel} : {})};
}

function rememberScopeOf(filter: unknown): 'session' | 'project' | 'user' {
  if (filter === 'PERMISSION_SCOPE_WORKSPACE' || filter === 'PERMISSION_SCOPE_PROJECT') return 'project';
  if (filter === 'PERMISSION_SCOPE_GLOBAL') return 'user';
  return 'session';
}

function permissionScopeForRemember(filter: unknown): string {
  if (filter === 'PERMISSION_SCOPE_WORKSPACE' || filter === 'PERMISSION_SCOPE_PROJECT' || filter === 'PERMISSION_SCOPE_GLOBAL' || filter === 'PERMISSION_SCOPE_CONVERSATION') {
    return filter;
  }
  return 'PERMISSION_SCOPE_CONVERSATION';
}

function interactionDetail(step: Json, branch: string): string {
  if (branch === 'runCommand') {
    const cmd = step.runCommand?.commandLine || step.runCommand?.command || '';
    const cwd = step.runCommand?.cwd || '';
    return [cmd, cwd ? `目录：${cwd}` : ''].filter(Boolean).join('\n');
  }
  if (branch === 'mcp') {
    const mcp = step.mcpTool || {};
    const name = [mcp.serverName, mcp.toolName].filter(Boolean).join(' / ');
    return [name, typeof mcp.argumentsJson === 'string' ? mcp.argumentsJson : ''].filter(Boolean).join('\n');
  }
  if (branch === 'openBrowserUrl' || branch === 'readUrlContent') {
    return String(step[branch]?.url || step.openBrowserUrl?.url || step.readUrlContent?.url || '');
  }
  if (branch === 'sendCommandInput') {
    return String(step.sendCommandInput?.input || '');
  }
  return '';
}

/** Extracts waiting-for-user steps into the same `ApprovalRequest` shape Claude Code uses. */
export function extractAntigravityRequests(steps: Json[], stepOffset: number): ApprovalRequest[] {
  const requests: ApprovalRequest[] = [];
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (!step || step.status !== waitingStep) continue;
    const ri = step.requestedInteraction;
    if (!ri || typeof ri !== 'object') continue;
    const stepIndex = Number.isSafeInteger(step.stepIndex) ? step.stepIndex : stepOffset + index;
    const id = String(stepIndex);

    if (ri.permission && typeof ri.permission === 'object') {
      const spec = ri.permission;
      const action = typeof spec.resource?.action === 'string' ? spec.resource.action : '';
      const target = typeof spec.resource?.target === 'string' ? spec.resource.target : '';
      const title = typeof spec.actionDescription === 'string' && spec.actionDescription.trim()
        ? spec.actionDescription.trim()
        : action ? `允许 ${action}` : '需要权限确认';
      const detail = [target, typeof spec.reason === 'string' ? spec.reason.trim() : ''].filter(Boolean).join('\n');
      const canRemember = spec.persistSuggestionType !== 'PERSIST_SUGGESTION_TYPE_BLOCKED';
      requests.push({
        id,
        kind: 'permission',
        tool: action || 'permission',
        title,
        detail,
        canRemember,
        ...(canRemember ? {rememberScope: rememberScopeOf(spec.approvalScopeFilter)} : {}),
      });
      continue;
    }

    if (ri.runCommand !== undefined) {
      requests.push({
        id,
        kind: 'permission',
        tool: 'run_command',
        title: '允许运行命令',
        detail: interactionDetail(step, 'runCommand'),
        canRemember: false,
      });
      continue;
    }

    if (ri.filePermission && typeof ri.filePermission === 'object') {
      const spec = ri.filePermission;
      const path = typeof spec.absolutePathUri === 'string' ? localWorkspace(spec.absolutePathUri) || spec.absolutePathUri : '';
      const reason = spec.blockReason === 'BLOCK_REASON_OUTSIDE_WORKSPACE' ? '位于当前工作区之外'
        : spec.blockReason === 'BLOCK_REASON_GITIGNORED' ? '位于 .gitignore 忽略范围' : '';
      requests.push({
        id,
        kind: 'permission',
        tool: 'file_permission',
        title: spec.isDirectory ? '允许访问目录' : '允许访问文件',
        detail: [path, reason].filter(Boolean).join('\n'),
        canRemember: true,
        rememberScope: 'session',
      });
      continue;
    }

    if (ri.askQuestion && typeof ri.askQuestion === 'object') {
      const rawQuestions: Json[] = Array.isArray(ri.askQuestion.questions) ? ri.askQuestion.questions : [];
      requests.push({
        id,
        kind: 'question',
        tool: 'ask_question',
        title: 'Antigravity 需要你的回答',
        detail: '',
        canRemember: false,
        questions: rawQuestions.map((q: Json) => ({
          question: String(q?.question || ''),
          header: '',
          multiSelect: Boolean(q?.isMultiSelect),
          options: (Array.isArray(q?.options) ? q.options : []).map((opt: Json) => ({
            label: String(opt?.text || opt?.id || ''),
            description: '',
          })),
        })),
      });
      continue;
    }

    const confirmBranch = Object.keys(CONFIRM_INTERACTION_LABELS).find(key => ri[key] !== undefined);
    if (confirmBranch) {
      requests.push({
        id,
        kind: 'permission',
        tool: confirmBranch,
        title: CONFIRM_INTERACTION_LABELS[confirmBranch],
        detail: interactionDetail(step, confirmBranch),
        canRemember: false,
      });
      continue;
    }

    requests.push({
      id,
      kind: 'notice',
      tool: Object.keys(ri)[0] || 'interaction',
      title: '桌面正在等待确认',
      detail: '此交互类型暂不支持在手机处理，请在电脑上的 Antigravity 完成。',
      canRemember: false,
    });
  }
  return requests;
}

function tailText(text: string, limit = TASK_OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  return '…\n' + text.slice(-limit);
}

function terminalBlockOf(step: Json): Json | null {
  const blocks = step?.generic?.result?.stepRenderInfo?.contentBlocks;
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks) {
    if (block?.terminal && typeof block.terminal === 'object') return block.terminal;
  }
  return null;
}

function stepTitleOf(step: Json): string {
  const td = step?.taskDetails;
  if (typeof td?.title === 'string' && td.title.trim()) return td.title.trim();
  const summary = step?.generic?.args?.toolSummary;
  if (typeof summary === 'string' && summary.trim()) return summary.trim();
  const parts = step?.generic?.result?.stepRenderInfo?.titleParts;
  if (Array.isArray(parts)) {
    const joined = parts.map((p: Json) => typeof p?.text === 'string' ? p.text : '').join('').trim();
    if (joined) return joined;
  }
  const toolName = step?.metadata?.toolCall?.name;
  if (typeof toolName === 'string' && toolName.trim()) return toolName.trim();
  return '后台任务';
}

function stepIndexOf(step: Json, fallback: number): number {
  if (Number.isSafeInteger(step?.stepIndex)) return step.stepIndex;
  const sourceIdx = step?.metadata?.sourceTrajectoryStepInfo?.stepIndex;
  if (Number.isSafeInteger(sourceIdx)) return sourceIdx;
  return fallback;
}

function isBackgroundTaskStep(step: Json, conversationRunning: boolean): boolean {
  if (!step || step.status !== runningStep) return false;
  const td = step.taskDetails && typeof step.taskDetails === 'object' ? step.taskDetails : null;
  return Boolean(td && (td.movedToBackgroundAt || td.id || td.logUri)) || !conversationRunning;
}

/** Extracts still-running background tasks (e.g. background commands) from Antigravity trajectory steps. */
export function extractAntigravityBackgroundTasks(
  steps: Json[],
  stepOffset: number,
  conversationRunning = false,
): AntigravityBackgroundTask[] {
  const tasks: AntigravityBackgroundTask[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (!isBackgroundTaskStep(step, conversationRunning)) continue;
    const td = step.taskDetails && typeof step.taskDetails === 'object' ? step.taskDetails : null;
    const stepIndex = stepIndexOf(step, stepOffset + index);
    const id = typeof td?.id === 'string' && td.id ? td.id : String(stepIndex);
    if (seen.has(id)) continue;
    seen.add(id);
    const terminal = terminalBlockOf(step);
    const command = typeof terminal?.command === 'string' && terminal.command.trim() ? terminal.command.trim()
      : typeof td?.description === 'string' && td.description.trim() ? td.description.trim()
      : typeof step.runCommand?.commandLine === 'string' && step.runCommand.commandLine.trim() ? step.runCommand.commandLine.trim()
      : typeof step.runCommand?.command === 'string' && step.runCommand.command.trim() ? step.runCommand.command.trim()
      : typeof step.generic?.args?.CommandLine === 'string' && step.generic.args.CommandLine.trim() ? step.generic.args.CommandLine.trim()
      : '';
    const cwd = typeof terminal?.cwd === 'string' && terminal.cwd.trim() ? terminal.cwd.trim()
      : typeof step.runCommand?.cwd === 'string' && step.runCommand.cwd.trim() ? step.runCommand.cwd.trim()
      : '';
    const rawOutput = typeof td?.progress === 'string' && td.progress ? td.progress
      : typeof terminal?.output === 'string' && terminal.output ? terminal.output
      : '';
    const output = rawOutput ? tailText(rawOutput) : '';
    const startedAt = typeof td?.movedToBackgroundAt === 'string' && td.movedToBackgroundAt ? td.movedToBackgroundAt
      : typeof step.metadata?.startedAt === 'string' && step.metadata.startedAt ? step.metadata.startedAt
      : typeof step.metadata?.createdAt === 'string' && step.metadata.createdAt ? step.metadata.createdAt
      : undefined;
    tasks.push({
      id,
      stepIndex,
      title: stepTitleOf(step),
      ...(command ? {command} : {}),
      ...(cwd ? {cwd} : {}),
      ...(output ? {output} : {}),
      ...(startedAt ? {startedAt} : {}),
    });
  }
  return tasks;
}

function extractTaskLogPaths(steps: Json[], conversationRunning: boolean): Map<string, string> {
  const paths = new Map<string, string>();
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (!isBackgroundTaskStep(step, conversationRunning)) continue;
    const td = step.taskDetails && typeof step.taskDetails === 'object' ? step.taskDetails : null;
    const path = localWorkspace(td?.logUri);
    if (!path) continue;
    const stepIndex = stepIndexOf(step, index);
    const id = typeof td?.id === 'string' && td.id ? td.id : String(stepIndex);
    paths.set(id, path);
  }
  return paths;
}

async function readTaskLogTail(path: string): Promise<string> {
  const file = await open(path, 'r').catch(() => null);
  if (!file) return '';
  try {
    const {size} = await file.stat();
    if (!size) return '';
    const start = Math.max(0, size - TASK_OUTPUT_LIMIT);
    const data = Buffer.alloc(size - start);
    const {bytesRead} = await file.read(data, 0, data.length, start);
    const text = data.toString('utf8', 0, bytesRead);
    return start > 0 ? '…\n' + text : text;
  } catch {
    return '';
  } finally { await file.close(); }
}

async function statTaskLogs(paths: string[]): Promise<string> {
  if (!paths.length) return '';
  const stats = await Promise.all(paths.slice(0, 16).map(async path => {
    const info = await stat(path, {bigint: true}).catch(() => null);
    return info ? `${info.mtimeNs}:${info.size}` : '';
  }));
  return stats.join(',');
}

/** Builds the native `CascadeUserInteraction` response payload for a waiting step. */
export function buildAntigravityInteraction(
  trajectoryId: string,
  stepIndex: number,
  step: Json,
  decision: 'allow' | 'allowSession' | 'deny',
  answers?: Record<string, string>,
): Json {
  const ri = step?.requestedInteraction;
  if (!ri || typeof ri !== 'object') throw new BridgeError('changed', '该确认请求已不存在，请刷新查看');
  const base = {trajectoryId, stepIndex};
  const allow = decision !== 'deny';

  if (ri.permission && typeof ri.permission === 'object') {
    const scope = !allow ? 'PERMISSION_SCOPE_ONCE'
      : decision === 'allowSession' ? permissionScopeForRemember(ri.permission.approvalScopeFilter)
      : 'PERMISSION_SCOPE_ONCE';
    return {...base, permission: {allow, scope}};
  }
  if (ri.runCommand !== undefined) {
    const commandLine = String(step.runCommand?.commandLine || step.runCommand?.command || '');
    return {...base, runCommand: {confirm: allow, ...(commandLine ? {proposedCommandLine: commandLine, submittedCommandLine: commandLine} : {})}};
  }
  if (ri.filePermission && typeof ri.filePermission === 'object') {
    return {
      ...base,
      filePermission: {
        allow,
        scope: decision === 'allowSession' ? 'PERMISSION_SCOPE_CONVERSATION' : 'PERMISSION_SCOPE_ONCE',
        ...(typeof ri.filePermission.absolutePathUri === 'string' ? {absolutePathUri: ri.filePermission.absolutePathUri} : {}),
      },
    };
  }
  if (ri.askQuestion && typeof ri.askQuestion === 'object') {
    if (!allow) return {...base, askQuestion: {responses: [], cancelled: true}};
    const rawQuestions: Json[] = Array.isArray(ri.askQuestion.questions) ? ri.askQuestion.questions : [];
    const responses = rawQuestions.map((q: Json) => {
      const text = String(q?.question || '');
      const rawAnswer = answers?.[text] ?? '';
      const parts = rawAnswer.split(',').map(part => part.trim()).filter(Boolean);
      const options: Json[] = Array.isArray(q?.options) ? q.options : [];
      const selectedOptionIds: string[] = [];
      const freeText: string[] = [];
      for (const part of parts) {
        const match = options.find(opt => String(opt?.text || opt?.id || '') === part || String(opt?.id || '') === part);
        if (match?.id !== undefined) selectedOptionIds.push(String(match.id));
        else freeText.push(part);
      }
      return {
        question: text,
        options,
        isMultiSelect: Boolean(q?.isMultiSelect),
        selectedOptionIds,
        writeInResponse: freeText.join(', '),
        skipped: !selectedOptionIds.length && !freeText.length,
      };
    });
    return {...base, askQuestion: {responses, cancelled: false}};
  }
  const confirmBranch = Object.keys(CONFIRM_INTERACTION_LABELS).find(key => ri[key] !== undefined);
  if (confirmBranch) {
    return {...base, [confirmBranch]: {confirm: allow}};
  }
  throw new BridgeError('unsupported', '暂不支持在手机回应此交互类型，请在电脑上处理');
}

function readIssue(step: Json): AntigravityIssue {
  const error = typeof step.error === 'string' ? step.error : '';
  const attempt = /^API error \(attempt (\d+)\):/i.exec(error);
  if (attempt) return {kind: 'retry', attempt: Number(attempt[1]),
    connection: /\b(?:eof|connection (?:reset|refused|closed|timed out)|wsarecv|proxyconnect)\b/i.test(error)};
  if (/^The stream was interrupted\b/i.test(error)) return {kind: 'interrupted'};
  return {kind: 'error'};
}

function cleanIssueText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length > limit ? trimmed.slice(0, limit - 1) + '…' : trimmed;
}

function readHubIssue(step: Json): AntigravityIssue {
  const errorMessage = step?.errorMessage && typeof step.errorMessage === 'object' ? step.errorMessage : null;
  const err = errorMessage?.error && typeof errorMessage.error === 'object' ? errorMessage.error : null;
  const shortError = typeof err?.shortError === 'string' ? err.shortError : '';
  const userMessage = typeof err?.userErrorMessage === 'string' ? err.userErrorMessage : '';
  const raw = shortError || userMessage;
  if (raw) {
    const parsed = readIssue({error: raw});
    if (parsed.kind !== 'error') return parsed;
  }
  if (errorMessage?.shouldShowUser !== true) return {kind: 'error'};
  const message = cleanIssueText(userMessage, 500);
  const firstLine = cleanIssueText(shortError.split(/\r?\n/, 1)[0], 300);
  const safeDetail = firstLine && !/https?:\/\/|127\.0\.0\.1|localhost:\d/i.test(firstLine)
    && (!message || (firstLine !== message && !firstLine.includes(message)))
    ? firstLine
    : '';
  const errorId = cleanIssueText(err?.errorId, 100);
  return {
    kind: 'error',
    ...(message ? {message} : {}),
    ...(safeDetail ? {detail: safeDetail} : {}),
    ...(errorId ? {errorId} : {}),
  };
}

export type HubIssueState = {
  issue: AntigravityIssue | null;
  issueStep: number;
  clearStep: number;
};

const EMPTY_HUB_ISSUE: HubIssueState = {issue: null, issueStep: -1, clearStep: -1};

/** Extracts the active error/retry issue from Antigravity trajectory tail steps (including errors omitted from transcript files). */
export function extractAntigravityIssue(steps: Json[], stepOffset: number): HubIssueState {
  let issue: AntigravityIssue | null = null;
  let issueStep = -1;
  let clearStep = -1;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (!step || typeof step !== 'object') continue;
    const stepIndex = stepIndexOf(step, stepOffset + index);
    if (step.type === USER_INPUT_STEP || step.type === PLANNER_RESPONSE_STEP) {
      issue = null;
      issueStep = -1;
      if (stepIndex > clearStep) clearStep = stepIndex;
    } else if (step.type === ERROR_STEP) {
      issue = readHubIssue(step);
      issueStep = stepIndex;
    }
  }
  return {issue, issueStep, clearStep};
}

function mergeAntigravityIssue(
  transcriptState: {issue: AntigravityIssue | null; issueStep: number; clearStep: number},
  hubState: HubIssueState,
): AntigravityIssue | null {
  const hubValid = hubState.issue && hubState.issueStep > transcriptState.clearStep ? hubState : null;
  const txValid = transcriptState.issue && transcriptState.issueStep > hubState.clearStep ? transcriptState : null;
  if (hubValid && txValid) return hubValid.issueStep >= txValid.issueStep ? hubValid.issue : txValid.issue;
  if (hubValid) return hubValid.issue;
  if (txValid) return txValid.issue;
  return null;
}

async function transcript(path: string): Promise<{messages: AntigravityMessage[]; issue: AntigravityIssue | null; issueStep: number; clearStep: number}> {
  const file = await open(path, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!file) return {messages: [], issue: null, issueStep: -1, clearStep: -1};
  try {
    const {size} = await file.stat();
    const start = Math.max(0, size - tailSize);
    const data = Buffer.alloc(size - start);
    const {bytesRead} = await file.read(data, 0, data.length, start);
    const lines = data.toString('utf8', 0, bytesRead).split('\n');
    if (start) lines.shift(); // The first line may start in the middle of a UTF-8 character.
    const result = new Map<string, AntigravityMessage>();
    let issue: AntigravityIssue | null = null;
    let issueStep = -1;
    let clearStep = -1;
    for (const line of lines) {
      let step;
      try { step = JSON.parse(line); } catch { continue; }
      if (!Number.isSafeInteger(step?.step_index)) continue;
      const id = String(step.step_index);
      if (step.type === 'USER_INPUT' && typeof step.content === 'string') {
        issue = null;
        issueStep = -1;
        if (step.step_index > clearStep) clearStep = step.step_index;
        const text = /^\s*<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>(?:\s*<ADDITIONAL_METADATA>|\s*$)/.exec(step.content)?.[1] ?? step.content;
        result.set(id, {id, role: 'user', text: text.trim()});
      } else if (step.type === 'PLANNER_RESPONSE') {
        issue = null;
        issueStep = -1;
        if (step.step_index > clearStep) clearStep = step.step_index;
        if (typeof step.content === 'string' && step.content.trim()) result.set(id, {id, role: 'assistant', text: step.content});
        const tools = Array.isArray(step.tool_calls) ? step.tool_calls.map((tool: Json) => tool?.name).filter((n: unknown) => typeof n === 'string') : [];
        if (tools.length) result.set(id + '-tools', {id: id + '-tools', role: 'tool', text: tools.join('、')});
      } else if (step.type === 'ERROR_MESSAGE') {
        issue = readIssue(step);
        issueStep = step.step_index;
      }
    }
    return {messages: [...result.values()].slice(-100), issue, issueStep, clearStep};
  } finally { await file.close(); }
}

/** Checks of a followed conversation; see AntigravityBridge.followedSnapshot. */
const FOLLOW_CHECK_MS = 200, FOLLOW_FULL_MS = 1300;
type Snapshot = Awaited<ReturnType<AntigravityBridge['snapshot']>>;
type LiveState = {
  permissionMode?: AntigravityPermissionMode;
  defaultPermissionMode?: AntigravityPermissionMode;
  requests: ApprovalRequest[];
  backgroundTasks: AntigravityBackgroundTask[];
  taskLogPaths: string[];
  hubIssue: HubIssueState;
};

type QueuedAntigravityPayload = {
  text: string;
  images?: string[];
  fileNames?: string[];
  model?: string;
  permissionMode?: AntigravityPermissionMode;
};

export type AntigravityBridgeOptions = {
  cancelTimeoutMs?: number;
  cancelPollMs?: number;
  dispatchGraceMs?: number;
  queueIntervalMs?: number;
};

export class AntigravityBridge {
  private writing = new Set<string>();
  private watchers = 0;
  private recent = new Map<string, {revision: string; baseRevision: string; live: LiveState; messages: AntigravityMessage[]}>();
  /** Bumped when a conversation's queue changes, so watching phones update without waiting for a transcript write. */
  private queueVersions = new Map<string, number>();
  private queueListeners: ((id: string) => void)[] = [];
  /** Conversations a phone follows (src/connector/thread-hub.ts): their last snapshot, as the watch loop below keeps it. */
  private followed = new Map<string, {snapshot: Snapshot; checkedAt: number; fullAt: number; stale: boolean}>();
  private views = new Map<string, {revision: string; value: Promise<{head: Json; entries: Json[]}>}>();
  /** Guards automatic draining right after a turn is dispatched while desktop SQLite still reports the prior idle summary. */
  private dispatchedTurn = new Map<string, {previousTurnKey: string; at: number}>();
  private queueTimer: NodeJS.Timeout;
  private closed = false;
  private cancelTimeoutMs: number;
  private cancelPollMs: number;
  private dispatchGraceMs: number;
  constructor(private root: string, private ledger: Ledger, private hub = callHub,
    private projectsDir = join(dirname(root), 'config', 'projects'), options: AntigravityBridgeOptions = {}) {
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? 8000;
    this.cancelPollMs = options.cancelPollMs ?? 150;
    this.dispatchGraceMs = options.dispatchGraceMs ?? 15_000;
    const intervalMs = options.queueIntervalMs ?? 1500;
    this.queueTimer = setInterval(() => {
      try {
        if (!this.closed) for (const id of new Set(this.queue.queued().map(message => message.threadId))) this.drainSoon(id);
      } catch {}
    }, intervalMs);
    this.queueTimer.unref?.();
  }

  private get queue() { return this.ledger.antigravityQueue; }
  get busy() { return this.writing.size > 0 || Boolean(this.queue.queued().length); }
  close() { this.closed = true; clearInterval(this.queueTimer); }
  private queueChanged(id: string) {
    this.queueVersions.set(id, (this.queueVersions.get(id) || 0) + 1);
    const followed = this.followed.get(id);if (followed) followed.stale = true;
    for (const listener of this.queueListeners) listener(id);
  }
  private drainSoon(id: string) { if (!this.closed) setImmediate(() => { this.drain(id).catch(() => {}); }); }

  private isAwaitingDispatch(id: string, summary: Summary): boolean {
    const pending = this.dispatchedTurn.get(id);
    if (!pending) return false;
    if (summary.status !== idle || turnKey(summary) !== pending.previousTurnKey || Date.now() - pending.at >= this.dispatchGraceMs) {
      this.dispatchedTurn.delete(id);
      return false;
    }
    return true;
  }

  private async hasWaitingRequests(id: string, summary: Summary): Promise<boolean> {
    if (!summary.notIdle && summary.status === idle) return false;
    const tailOffset = Math.max(0, summary.steps - WAITING_STEP_WINDOW);
    const tail = await this.fetchSteps(id, tailOffset);
    return extractAntigravityRequests(tail, tailOffset).length > 0;
  }

  private queuedViews(id: string): QueuedMessage[] {
    return this.queue.queued(id).map(message => ({
      id: message.id,
      text: message.payload.text || '',
      imageCount: message.payload.images?.length || 0,
      ...(message.payload.fileNames?.length ? {fileNames: message.payload.fileNames} : {}),
      imageBytes: (message.payload.images || []).reduce((sum: number, url: string) => sum + imageBytes(url), 0),
      state: message.state,
      ...(message.error ? {error: message.error} : {}),
    }));
  }

  private async sendToHub(
    id: string,
    summary: Summary,
    payload: {text: string; images?: string[]; model?: string; permissionMode?: AntigravityPermissionMode},
    opId: string,
    opts?: {deliveryStrategy?: typeof NEXT_INVOCATION; expectedTurn?: string},
  ): Promise<void> {
    const directory = this.daemonDir();
    const images = payload.images || [];
    const message: Json = {
      cascadeId: id,
      items: [{text: payload.text}],
      ...(images.length ? {media: antigravityMedia(images)} : {}),
      clientMessageId: opId.split(':')[1],
      ...(opts?.deliveryStrategy ? {deliveryStrategy: opts.deliveryStrategy} : {}),
    };
    const explicitConfig = Boolean(payload.model || payload.permissionMode);
    let base = await this.conversationConfig(summary, explicitConfig);
    if (payload.model) {
      base = await this.withModel(base, payload.model);
    } else if (!hasConfiguredModel(base)) {
      base = await this.withDefaultModel(base);
    }
    const cascadeConfig = payload.permissionMode ? this.withPermission(base, payload.permissionMode) : base;
    if (cascadeConfig && Object.keys(cascadeConfig).length) {
      message.cascadeConfig = cascadeConfig;
    }
    if (opts?.expectedTurn !== undefined) {
      const latest = this.summary(id);
      if (turnKey(latest) !== opts.expectedTurn || !canSend(latest)) {
        throw new BridgeError('changed', '会话状态已变化，请刷新后再发送');
      }
    }
    if (payload.permissionMode) {
      await this.hub(directory, 'UpdateConversationAnnotations', {
        cascadeId: id,
        annotations: {permissionPreset: payload.permissionMode},
        mergeAnnotations: true,
      }).catch(() => {});
    }
    await this.hub(directory, 'SendUserCascadeMessage', message);
    if (!opts?.deliveryStrategy) {
      this.dispatchedTurn.set(id, {previousTurnKey: turnKey(summary), at: Date.now()});
    }
    // Antigravity reports no tokens; the turn still counts for whoever sent it.
    this.ledger.recordUsage({id: `antigravity:${id}:${opId}`, service: 'antigravity', threadId: id, turnId: opId, opId, models: []});
    this.ledger.recordSender({service: 'antigravity', threadId: id, opId, kind: 'text', text: payload.text});
  }

  private async cancelAndWaitForIdle(id: string): Promise<Summary> {
    const initial = this.summary(id);
    if (initial.status === idle) return initial;
    if (initial.status !== canceling) {
      await this.hub(this.daemonDir(), 'CancelCascadeInvocation', {cascadeId: id, killBackgroundTasks: false});
    }
    const deadline = Date.now() + this.cancelTimeoutMs;
    while (Date.now() < deadline) {
      const latest = this.summary(id);
      if (latest.status === idle) return latest;
      await delay(Math.min(this.cancelPollMs, Math.max(10, deadline - Date.now())));
    }
    const final = this.summary(id);
    if (final.status === idle) return final;
    throw new BridgeError('active', '当前任务未能及时停止，请稍后重试');
  }

  /** Drains queued messages for one conversation (or all conversations); safe to call repeatedly. */
  async drainQueue(id?: string): Promise<void> {
    const ids = id ? [id] : [...new Set(this.queue.queued().map(message => String(message.threadId)))];
    for (const target of ids) await this.drain(target);
  }

  /**
   * Sends the first queued message once the conversation is idle without pending approval requests, one per turn.
   * A failed or uncertain message pauses the queue until the phone removes it.
   */
  private async drain(id: string): Promise<void> {
    const head = this.queue.queued(id)[0];
    if (!head || head.state !== 'queued' || this.writing.has(id) || this.closed) return;
    let summary: Summary;
    try { summary = this.summary(id); } catch { return; }
    if (!canSend(summary) || this.isAwaitingDispatch(id, summary)) return;
    this.writing.add(id);
    try {
      const currentHead = this.queue.queued(id)[0];
      if (!currentHead || currentHead.id !== head.id || currentHead.state !== 'queued') return;
      summary = this.summary(id);
      if (!canSend(summary) || this.isAwaitingDispatch(id, summary)) return;
      if (await this.hasWaitingRequests(id, summary)) return;
      this.queue.sending(head.id);
      this.queueChanged(id);
      try {
        await this.sendToHub(id, summary, head.payload as QueuedAntigravityPayload, head.id);
        this.queue.finishQueued(head.id, {conversationId: id, submitted: true});
      } catch (error) {
        this.queue.finishQueued(
          head.id,
          {},
          error instanceof BridgeError ? error : new BridgeError('unexpected', '排队消息发送结果待核实，不会自动重发', true),
        );
      }
      this.queueChanged(id);
    } finally { this.writing.delete(id); }
  }

  private daemonDir() { return join(this.root, 'daemon'); }

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
    for (const row of rows.slice(0, 8)) {
      // Some desktop conversations keep the user step at -1 although their first step is the user's message.
      const config = await this.turnConfig({...row, userStep: row.userStep != null && row.userStep >= 0 ? row.userStep : 0}).catch(() => null);
      if (hasConfiguredModel(config)) return config;
    }
    return null;
  }

  private async recentUserStepIndices(id: string, exclude: number | null): Promise<number[]> {
    const logs = join(this.root, 'brain', id, '.system_generated', 'logs');
    let raw = '';
    for (const name of ['transcript.jsonl', 'transcript_full.jsonl']) {
      const file = await open(join(logs, name), 'r').catch(() => null);
      if (!file) continue;
      try {
        const {size} = await file.stat();
        const start = Math.max(0, size - tailSize);
        const data = Buffer.alloc(size - start);
        const {bytesRead} = await file.read(data, 0, data.length, start);
        raw = data.toString('utf8', 0, bytesRead);
        if (start) raw = raw.slice(raw.indexOf('\n') + 1);
        break;
      } finally { await file.close(); }
    }
    const found: number[] = [];
    const seen = new Set<number>();
    if (exclude != null) seen.add(exclude);
    for (const line of raw.split('\n')) {
      if (!line.includes('"USER_INPUT"')) continue;
      try {
        const step = JSON.parse(line);
        if (step?.type === 'USER_INPUT' && Number.isSafeInteger(step.step_index) && step.step_index >= 0 && !seen.has(step.step_index)) {
          seen.add(step.step_index);
          found.push(step.step_index);
        }
      } catch {}
    }
    const recent = found.slice(-10);
    if (!seen.has(0)) recent.unshift(0);
    return recent;
  }

  private async earlierTurnConfig(summary: Summary): Promise<Json | null> {
    const candidates = await this.recentUserStepIndices(summary.id, summary.userStep);
    if (!candidates.length) return null;
    const result = await this.hub(this.daemonDir(), 'GetTrajectoryTurns', {cascadeId: summary.id, stepIndices: candidates}).catch(() => null);
    const turns: Json[] = Array.isArray(result?.turns) ? result.turns : [];
    const sorted = [...turns].sort((a, b) => (Number(b?.startStepIndex) || 0) - (Number(a?.startStepIndex) || 0));
    for (const turn of sorted) {
      const config = turn?.firstStep?.userInput?.userConfig;
      if (hasConfiguredModel(config)) return config;
    }
    return null;
  }

  /**
   * Resolves the conversation's `cascadeConfig` so every message carries a valid `planModel` (otherwise later
   * background-task wakeups fail with `plan model not specified`). Falls back to earlier turns or project config if
   * the latest user step had no `userConfig`.
   */
  private async conversationConfig(summary: Summary, strict = false): Promise<Json | null> {
    let primary: Json | null = null;
    if (strict) primary = await this.turnConfig(summary);
    else primary = await this.turnConfig(summary).catch(() => null);
    if (hasConfiguredModel(primary)) return primary;
    const earlier = await this.earlierTurnConfig(summary);
    if (earlier) return earlier;
    const fallback = await this.latestConfig(singleWorkspace(summary.workspaces)).catch(() => null);
    if (fallback) return fallback;
    return primary && Object.keys(primary).length ? primary : null;
  }

  private async withDefaultModel(config: Json | null): Promise<Json | null> {
    const catalog = await this.modelCatalog().catch(() => null);
    const fallbackModel = catalog?.defaultModel || catalog?.models[0]?.id;
    if (!fallbackModel) return config;
    const plannerConfig = {...config?.plannerConfig, planModel: fallbackModel};
    delete plannerConfig.requestedModel;
    delete plannerConfig.modelName;
    return {...config, plannerConfig};
  }

  private async withModel(config: Json | null, model: string | undefined): Promise<Json | null> {
    if (!model) return config;
    const {models} = await this.modelCatalog();
    if (!models.some(option => option.id === model)) throw new BridgeError('invalid', '所选模型已不可用，请重新选择');
    const plannerConfig = {...config?.plannerConfig, planModel: model};
    delete plannerConfig.requestedModel;
    delete plannerConfig.modelName;
    return {...config, plannerConfig};
  }

  private withPermission(config: Json | null, permissionMode: AntigravityPermissionMode | undefined): Json | null {
    if (!permissionMode) return config;
    const plannerConfig = {...config?.plannerConfig};
    const toolConfig = {...plannerConfig.toolConfig};
    const runCommand = {...toolConfig.runCommand};
    const autoCommandConfig = {...runCommand.autoCommandConfig};
    const policy = PRESET_TO_AUTO_EXECUTION[permissionMode];
    if (policy) autoCommandConfig.autoExecutionPolicy = policy;
    else delete autoCommandConfig.autoExecutionPolicy;
    runCommand.autoCommandConfig = autoCommandConfig;
    toolConfig.runCommand = runCommand;
    plannerConfig.toolConfig = toolConfig;
    return {...config, plannerConfig};
  }

  private async defaultPermissionMode(): Promise<AntigravityPermissionMode | undefined> {
    const settings = await this.hub(this.daemonDir(), 'GetPermissionSettings', {}).catch(() => null);
    return isPermissionPreset(settings?.globalPreset) ? settings.globalPreset : undefined;
  }

  private async trajectoryMeta(id: string): Promise<{trajectoryId?: string; permissionMode?: AntigravityPermissionMode}> {
    const all = await this.hub(this.daemonDir(), 'GetAllCascadeTrajectories', {}).catch(() => null);
    const entry = all?.trajectorySummaries?.[id];
    if (!entry || typeof entry !== 'object') return {};
    return {
      ...(typeof entry.trajectoryId === 'string' && entry.trajectoryId ? {trajectoryId: entry.trajectoryId} : {}),
      ...(isPermissionPreset(entry.annotations?.permissionPreset) ? {permissionMode: entry.annotations.permissionPreset} : {}),
    };
  }

  private async fetchSteps(id: string, stepOffset: number): Promise<Json[]> {
    const result = await this.hub(this.daemonDir(), 'GetCascadeTrajectorySteps', {cascadeId: id, stepOffset}).catch(() => null);
    return Array.isArray(result?.steps) ? result.steps : [];
  }

  private async taskDirOffsets(id: string): Promise<number[]> {
    const names = await readdir(join(this.root, 'brain', id, '.system_generated', 'tasks')).catch(() => [] as string[]);
    const offsets: number[] = [];
    for (const name of names) {
      const match = /^task-(\d+)\.log$/i.exec(name);
      if (!match) continue;
      const stepIndex = Number(match[1]);
      if (Number.isSafeInteger(stepIndex) && stepIndex >= 0) offsets.push(stepIndex);
    }
    return offsets.sort((a, b) => a - b);
  }

  private async liveSteps(
    id: string,
    summary: Summary,
    opts?: {scanOlder?: boolean; previousBackgroundTasks?: AntigravityBackgroundTask[]; previousLogPaths?: string[]},
  ): Promise<{requests: ApprovalRequest[]; backgroundTasks: AntigravityBackgroundTask[]; taskLogPaths: string[]; hubIssue: HubIssueState}> {
    const activeOrWaiting = summary.status === active || Boolean(summary.notIdle);
    const conversationRunning = summary.status === active;
    const tailOffset = Math.max(0, summary.steps - WAITING_STEP_WINDOW);
    const tail = await this.fetchSteps(id, tailOffset);
    const hubIssue = extractAntigravityIssue(tail, tailOffset);
    if (!activeOrWaiting) {
      return {requests: [], backgroundTasks: [], taskLogPaths: [], hubIssue};
    }
    let requests = extractAntigravityRequests(tail, tailOffset);
    let backgroundTasks = extractAntigravityBackgroundTasks(tail, tailOffset, conversationRunning);
    let logPathMap = extractTaskLogPaths(tail, conversationRunning);

    if (summary.notIdle && tailOffset > 0) {
      if (opts?.scanOlder === false) {
        const seen = new Set(backgroundTasks.map(task => task.id));
        const keptOlder = (opts.previousBackgroundTasks || []).filter(task => task.stepIndex < tailOffset && !seen.has(task.id));
        backgroundTasks = [...keptOlder, ...backgroundTasks];
      } else {
        const olderTaskSteps = (await this.taskDirOffsets(id)).filter(idx => idx < tailOffset);
        const olderOffset = olderTaskSteps.length
          ? olderTaskSteps[0]
          : (!conversationRunning && !backgroundTasks.length && !requests.length ? 0 : null);
        if (olderOffset !== null) {
          const wider = await this.fetchSteps(id, olderOffset);
          if (wider.length) {
            requests = extractAntigravityRequests(wider, olderOffset);
            backgroundTasks = extractAntigravityBackgroundTasks(wider, olderOffset, conversationRunning);
            logPathMap = extractTaskLogPaths(wider, conversationRunning);
          }
        }
      }
    }

    const taskLogPaths = new Set<string>(opts?.scanOlder === false ? (opts.previousLogPaths || []) : []);
    const tasksDir = join(this.root, 'brain', id, '.system_generated', 'tasks');
    backgroundTasks = await Promise.all(backgroundTasks.map(async task => {
      const logPath = logPathMap.get(task.id) || join(tasksDir, `task-${task.stepIndex}.log`);
      taskLogPaths.add(logPath);
      const diskTail = await readTaskLogTail(logPath);
      if (diskTail && (!task.output || diskTail.length > task.output.length)) {
        return {...task, output: diskTail};
      }
      return task;
    }));

    return {requests, backgroundTasks, taskLogPaths: [...taskLogPaths], hubIssue};
  }

  private async create(p: Json): Promise<Json> {
    const project = textRequired(p.project, '项目', 4096);
    const files = requestFiles(p.files), text = messageText(p.text, files);
    const opId = textRequired(p.opId, '操作标识', 100);
    const model = p.model !== undefined && p.model !== '' ? textRequired(p.model, '模型', 200) : undefined;
    const permissionMode = readPermissionMode(p.permissionMode);
    const images = readImages(p.images);
    checkCount(images, files);
    const path = localWorkspace(project);
    if (!path) throw new BridgeError('invalid', '请选择这台电脑上的项目');
    return this.ledger.run(opId, {
      action: 'antigravity.create', project, text, ...attached(images, files),
      ...(model ? {model} : {}), ...(permissionMode ? {permissionMode} : {}),
    }, async () => {
      const prompt = await withAttachmentLinks(this.ledger, newScope(path), text, files);
      const desktop = (await this.desktopProjects()).find(item => sameFolder(item.path, path));
      let baseConfig = await this.withModel(await this.latestConfig(path), model);
      if (!hasConfiguredModel(baseConfig)) baseConfig = await this.withDefaultModel(baseConfig);
      const config = this.withPermission(baseConfig, permissionMode);
      const directory = this.daemonDir();
      const started = await this.hub(directory, 'StartCascade', {workspaceUris: [project], source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
        trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE', ...(desktop ? {projectEnvConfig: {projectId: desktop.id}} : {})});
      const id = started.cascadeId;
      if (typeof id !== 'string' || !guid.test(id)) throw new BridgeError('uncertain', '桌面未返回新会话，请在电脑核实', true);
      if (permissionMode) {
        await this.hub(directory, 'UpdateConversationAnnotations', {cascadeId: id, annotations: {permissionPreset: permissionMode}, mergeAnnotations: true}).catch(() => {});
      }
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

  private async respond(p: Json): Promise<Json> {
    const id = textRequired(p.conversationId, '会话', 36);
    if (!guid.test(id)) throw new BridgeError('invalid', 'Antigravity 会话 ID 无效');
    const requestId = textRequired(p.requestId, '确认标识', 64);
    const stepIndex = Number(requestId);
    if (!Number.isSafeInteger(stepIndex) || stepIndex < 0) throw new BridgeError('invalid', '确认标识无效');
    const decision = p.decision;
    if (decision !== 'allow' && decision !== 'allowSession' && decision !== 'deny') throw new BridgeError('invalid', '确认决定无效');
    const answers = p.answers && typeof p.answers === 'object' && !Array.isArray(p.answers) ? p.answers as Record<string, string> : undefined;
    const opId = textRequired(p.opId, '操作标识', 100);
    return this.ledger.run(opId, {action: 'antigravity.respond', id, requestId, decision, ...(answers ? {answers} : {})}, async () => {
      if (this.writing.has(id)) throw new BridgeError('busy', '此会话正在处理另一次操作');
      const summary = this.summary(id);
      this.writing.add(id);
      try {
        const [{trajectoryId}, stepRes] = await Promise.all([
          this.trajectoryMeta(id),
          this.hub(this.daemonDir(), 'GetCascadeTrajectorySteps', {cascadeId: id, stepOffset: stepIndex}),
        ]);
        const steps = Array.isArray(stepRes?.steps) ? stepRes.steps : [];
        const step = steps.find((item: Json, idx: number) => (Number.isSafeInteger(item?.stepIndex) ? item.stepIndex : stepIndex + idx) === stepIndex);
        if (!step || step.status !== waitingStep) {
          throw new BridgeError('changed', '该确认请求已在桌面处理或已过期，请刷新查看');
        }
        const interaction = buildAntigravityInteraction(trajectoryId || id, stepIndex, step, decision, answers);
        await this.hub(this.daemonDir(), 'HandleCascadeUserInteraction', {cascadeId: id, interaction});
        void summary;
        return {responded: true};
      } finally { this.writing.delete(id); }
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

  private async modelCatalog() {
    const result = await this.hub(this.daemonDir(), 'GetCascadeModelConfigData', {});
    return parseAntigravityModels(result);
  }

  private async turnConfig(summary: Summary): Promise<Json> {
    if (summary.userStep == null || summary.userStep < 0) return {};
    const {turns} = await this.hub(this.daemonDir(), 'GetTrajectoryTurns', {cascadeId: summary.id, stepIndices: [summary.userStep]});
    const user = turns?.find((turn: Json) => (turn.startStepIndex ?? 0) === summary.userStep)?.firstStep?.userInput;
    if (!user) throw new BridgeError('changed', '无法读取原会话的模型设置，请刷新后重试');
    return user.userConfig ?? {};
  }

  private async snapshot(
    id: string,
    live?: LiveState,
    opts?: {scanOlder?: boolean; previousBackgroundTasks?: AntigravityBackgroundTask[]; previousLogPaths?: string[]},
  ) {
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
    const cwd = singleWorkspace(summary.workspaces);
    const activeOrWaiting = summary.status === active || Boolean(summary.notIdle);
    let resolved = live;
    if (!resolved) {
      const [meta, globalPreset, stepState] = await Promise.all([
        this.trajectoryMeta(id),
        this.defaultPermissionMode(),
        activeOrWaiting || summary.steps > 0
          ? this.liveSteps(id, summary, opts)
          : Promise.resolve({requests: [], backgroundTasks: [], taskLogPaths: [], hubIssue: EMPTY_HUB_ISSUE}),
      ]);
      resolved = {
        permissionMode: meta.permissionMode,
        defaultPermissionMode: globalPreset,
        requests: stepState.requests,
        backgroundTasks: stepState.backgroundTasks,
        taskLogPaths: stepState.taskLogPaths,
        hubIssue: stepState.hubIssue,
      };
    }
    const {permissionMode, defaultPermissionMode, requests, backgroundTasks, taskLogPaths, hubIssue} = resolved;
    const queuedMessages = this.queuedViews(id);
    const queueVersion = this.queueVersions.get(id) || 0;
    const queueFingerprint = queuedMessages.map(item => `${item.id}:${item.state}:${item.error || ''}`).join('|');
    const taskLogStat = await statTaskLogs(taskLogPaths);
    const requestFingerprint = requests.map(req => `${req.id}:${req.kind}:${req.title}`).join('|');
    const taskFingerprint = backgroundTasks.map(task => `${task.id}:${task.title}:${task.output?.length ?? 0}:${task.output?.slice(-64) ?? ''}`).join('|');
    const issueFingerprint = hubIssue.issue ? JSON.stringify([hubIssue.issueStep, hubIssue.issue]) : `clear:${hubIssue.clearStep}`;
    const baseRevision = JSON.stringify([
      summary.modified, summary.steps, summary.status, summary.notIdle, turnKey(summary), summary.title, cwd,
      String(file?.mtimeNs), String(file?.size), taskLogStat, queueVersion, queueFingerprint,
    ]);
    const revision = JSON.stringify([baseRevision, permissionMode || '', defaultPermissionMode || '', requestFingerprint, taskFingerprint, issueFingerprint]);
    return {
      path, revision, baseRevision, live: resolved, turn: turnKey(summary), title: summary.title || '未命名对话', cwd,
      running: summary.status === active, canSend: canSend(summary) && !requests.length,
      notIdle: Boolean(summary.notIdle),
      supportsModelSelection: true, supportsImages: true, supportsQueue: true,
      ...(permissionMode ? {permissionMode} : {}),
      ...(defaultPermissionMode ? {defaultPermissionMode} : {}),
      requests,
      backgroundTasks,
      queuedMessages,
    };
  }

  private async read(id: string, known?: string) {
    const previous = this.recent.get(id);
    let current;
    if (known && previous && previous.revision === known) {
      const local = await this.snapshot(id, previous.live);
      current = local.baseRevision === previous.baseRevision && !local.running && local.canSend
        ? local
        : await this.snapshot(id);
    } else {
      current = await this.snapshot(id);
    }
    if (known && known === current.revision) {
      if (this.watchers >= 32) throw new BridgeError('busy', '观察请求较多，请稍后重试');
      this.watchers++;
      try {
        const deadline = Date.now() + 15_000;
        let ticks = 0;
        while (known === current.revision && Date.now() < deadline) {
          await delay(650);
          ticks++;
          const wasRunning = current.running;
          const nextLocal = await this.snapshot(id, current.live);
          const activeOrWaiting = nextLocal.running || !nextLocal.canSend;
          if (nextLocal.baseRevision !== current.baseRevision) {
            current = await this.snapshot(id);
          } else if (activeOrWaiting && ticks % 2 === 0) {
            current = await this.snapshot(id, undefined, {
              scanOlder: false,
              previousBackgroundTasks: current.live.backgroundTasks,
              previousLogPaths: current.live.taskLogPaths,
            });
          } else {
            current = nextLocal;
          }
          if (wasRunning && !current.running && current.canSend && this.queue.queued(id).length) {
            this.drainSoon(id);
          }
        }
      } finally { this.watchers--; }
      if (known === current.revision) return {unchanged: true};
    }
    const {path, baseRevision, live, ...view} = current;
    const tx = await transcript(path);
    const items = tx.messages;
    const issue = mergeAntigravityIssue(tx, live.hubIssue);
    // Messages sent from the phone carry their sender, matched by the exact text the connector sent.
    const records = this.ledger.senders('antigravity', id);
    if (records.length) {
      const senders = sendersByText(items.filter(item => item.role === 'user'), records);
      for (const item of items) {const sender = senders.get(item.id);if (sender) item.sender = sender;}
    }
    this.recent.delete(id);
    this.recent.set(id, {revision: view.revision, baseRevision, live, messages: items});
    if (this.recent.size > 8) this.recent.delete(this.recent.keys().next().value!);
    if (previous && previous.revision === known) {
      let keep = 0;
      while (keep < items.length && items[keep].id === previous.messages[keep]?.id &&
             items[keep].text === previous.messages[keep].text && items[keep].role === previous.messages[keep].role &&
             // A message matched to its sender after the phone first got it is sent again with the name.
             items[keep].sender?.id === previous.messages[keep].sender?.id) keep++;
      return {...view, issue, base: known, keep, messages: items.slice(keep)};
    }
    return {...view, issue, messages: items, notice: '显示桌面已记录的最近对话内容。'};
  }

  /**
   * How a followed conversation is checked, as the watch loop in {@link read} does: a cheap local snapshot (the desktop's
   * index and the transcript's size) at most every {@link FOLLOW_CHECK_MS}, and the desktop's live steps again when the
   * index moved, or every {@link FOLLOW_FULL_MS} while a turn runs or waits. A queue change is checked at once.
   */
  private async followedSnapshot(id: string): Promise<Snapshot> {
    const now = Date.now(), previous = this.followed.get(id);
    if (previous && !previous.stale && now - previous.checkedAt < FOLLOW_CHECK_MS) return previous.snapshot;
    let current: Snapshot, fullAt = previous?.fullAt ?? now;
    if (!previous) current = await this.snapshot(id);
    else {
      const local = await this.snapshot(id, previous.snapshot.live);
      if (local.baseRevision !== previous.snapshot.baseRevision) {current = await this.snapshot(id);fullAt = now;}
      else if ((local.running || !local.canSend) && now - previous.fullAt >= FOLLOW_FULL_MS) {
        current = await this.snapshot(id, undefined, {scanOlder: false, previousBackgroundTasks: previous.snapshot.live.backgroundTasks, previousLogPaths: previous.snapshot.live.taskLogPaths});
        fullAt = now;
      } else current = local;
      // A turn that just ended sends the next queued message at once, as watching did.
      if (previous.snapshot.running && !current.running && current.canSend && this.queue.queued(id).length) this.drainSoon(id);
    }
    this.followed.set(id, {snapshot: current, checkedAt: now, fullAt, stale: false});
    if (this.followed.size > 16) this.followed.delete(this.followed.keys().next().value!);
    return current;
  }

  /** The conversation as the subscription hub sends it: its messages as entries, built once per revision. */
  private followedView(id: string, current: Snapshot): Promise<{head: Json; entries: Json[]}> {
    const cached = this.views.get(id);
    if (cached?.revision === current.revision) return cached.value;
    const value = (async () => {
      const {path, baseRevision: _, live, revision: ___, ...head} = current;
      const tx = await transcript(path);
      const messages = tx.messages;
      const issue = mergeAntigravityIssue(tx, live.hubIssue);
      const records = this.ledger.senders('antigravity', id);
      if (records.length) {
        const senders = sendersByText(messages.filter(item => item.role === 'user'), records);
        for (const item of messages) {const sender = senders.get(item.id);if (sender) item.sender = sender;}
      }
      return {head: {id, ...head, issue}, entries: messages};
    })();
    this.views.delete(id);this.views.set(id, {revision: current.revision, value});
    if (this.views.size > 8) this.views.delete(this.views.keys().next().value!);
    value.catch(() => {if (this.views.get(id)?.value === value) this.views.delete(id);});
    return value;
  }

  /** What the subscription hub follows: a conversation's messages, pushed as they change. */
  readonly syncSource: ThreadSource = {
    // Messages are short; a phone gets all the transcript tail holds, as it did before.
    window: 2000,
    version: async id => (await this.followedSnapshot(id)).revision,
    state: async id => this.followedView(id, await this.followedSnapshot(id)),
    watch: poke => {this.queueListeners.push(poke);},
  };

  async handle(action: string, p: Json): Promise<Json> {
    if (action === 'antigravity.create') return this.create(p);
    if (action === 'antigravity.respond') return this.respond(p);
    if (action === 'antigravity.models' && !p.conversationId) {
      const project = p.project ? localWorkspace(textRequired(p.project, '项目', 4096)) : '';
      const [catalog, config, defaultPermissionMode] = await Promise.all([
        this.modelCatalog(),
        this.latestConfig(project).catch(() => null),
        this.defaultPermissionMode(),
      ]);
      return {
        ...catalog,
        current: config?.plannerConfig?.planModel ?? null,
        supportsImages: true,
        ...(defaultPermissionMode ? {defaultPermissionMode} : {}),
      };
    }
    if (action === 'antigravity.list') {
      const [named, defaultPermissionMode] = await Promise.all([this.desktopProjects(), this.defaultPermissionMode()]);
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
        return {
          data:rows.slice(0,50).map(row=>({id:row.id,title:row.title||'未命名对话',
            running:row.status===active,updatedAt:Date.parse(String(row.modified))||0})),
          hasMore:rows.length>50,
          projects,
          ...(defaultPermissionMode ? {defaultPermissionMode} : {}),
        };
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
        : p.stream === true ? openProjectDownload(cwd, path, textRequired(p.revision, '文件版本', 64), p.range) as unknown as Promise<Json>
        : downloadProjectFile(cwd, path, textRequired(p.revision, '文件版本', 64), p.offset);
    }
    if (action === 'antigravity.models') {
      const summary = this.summary(id);
      const [catalog, config, defaultPermissionMode] = await Promise.all([
        this.modelCatalog(),
        this.conversationConfig(summary).catch(() => null),
        this.defaultPermissionMode(),
      ]);
      return {
        ...catalog,
        current: config?.plannerConfig?.planModel ?? null,
        supportsImages: true,
        ...(defaultPermissionMode ? {defaultPermissionMode} : {}),
      };
    }
    if (action === 'antigravity.read') return this.read(id);
    if (action === 'antigravity.watch') return this.read(id, textRequired(p.revision, '会话版本', 4096));
    if (action === 'antigravity.steerQueued' || action === 'antigravity.withdrawQueued' || action === 'antigravity.cancelQueued') {
      const queuedId = textRequired(p.queuedId, '排队消息', 100);
      const opId = textRequired(p.opId, '操作标识', 100);
      const delivery = action === 'antigravity.steerQueued' ? sendMode(p.mode ?? 'steer') : undefined;
      if (delivery === 'queue') throw new BridgeError('invalid', '发送方式无效');
      return this.ledger.run(opId, {action, id, queuedId, ...(delivery === 'now' ? {delivery} : {})}, async () => {
        if (action !== 'antigravity.steerQueued') {
          const msg = this.queue.cancelQueued(id, queuedId);
          this.queueChanged(id);
          this.drainSoon(id);
          return action === 'antigravity.withdrawQueued'
            ? {queuedId, kind: 'queue_withdrawn', message: {text: msg.text || '', images: msg.images || [], model: msg.model, permissionMode: msg.permissionMode}}
            : {queuedId, kind: 'queue_cancelled'};
        }
        const message = this.queue.queued(id).find(item => item.id === queuedId);
        if (!message) throw new BridgeError('changed', '消息已经发送或移出队列，请刷新');
        if (message.state !== 'queued') throw new BridgeError('active', '这条消息暂不能追加，请核实发送状态');
        if (this.writing.has(id)) throw new BridgeError('busy', '此会话正在处理另一次操作');
        const summary = this.summary(id);
        if (delivery === 'steer') {
          if (summary.status !== active) throw new BridgeError('changed', '当前没有正在运行的任务，消息会按顺序发送');
          this.writing.add(id);
          try {
            this.queue.sending(queuedId);
            this.queueChanged(id);
            try {
              // Steer into the running turn keeping that turn's model/permission settings, as Codex and Claude Code do.
              await this.sendToHub(id, summary, {text: message.payload.text || '', images: message.payload.images || []}, queuedId, {deliveryStrategy: NEXT_INVOCATION});
            } catch (error) {
              const failure = error instanceof BridgeError ? error : new BridgeError('unexpected', '追加结果待核实，不会自动重发', true);
              this.queue.finishQueued(queuedId, {}, failure);
              throw failure;
            }
            this.queue.finishQueued(queuedId, {conversationId: id, submitted: true, kind: 'steer_accepted'});
            return {queuedId, kind: 'steer_accepted'};
          } finally { this.writing.delete(id); this.queueChanged(id); }
        }
        this.writing.add(id);
        try {
          // Cancel the current reply first; only mark the queued entry 'sending' once the turn is idle and ready to submit.
          const ready = summary.status === idle ? summary : await this.cancelAndWaitForIdle(id);
          const fresh = this.queue.queued(id).find(item => item.id === queuedId);
          if (!fresh || fresh.state !== 'queued') throw new BridgeError('changed', '消息已经发送或移出队列，请刷新');
          this.queue.sending(queuedId);
          this.queueChanged(id);
          try {
            await this.sendToHub(id, ready, fresh.payload as QueuedAntigravityPayload, queuedId);
          } catch (error) {
            const failure = error instanceof BridgeError ? error : new BridgeError('unexpected', '立即发送结果待核实，不会自动重发', true);
            this.queue.finishQueued(queuedId, {}, failure);
            throw failure;
          }
          this.queue.finishQueued(queuedId, {conversationId: id, submitted: true, kind: 'sent_now'});
          return {queuedId, kind: 'sent_now'};
        } finally { this.writing.delete(id); this.queueChanged(id); }
      });
    }
    if (action !== 'antigravity.send' && action !== 'antigravity.stop') throw new BridgeError('unsupported', '不支持此 Antigravity 操作');
    const sending = action === 'antigravity.send';
    const delivery = sending ? sendMode(p.mode) : undefined;
    const killBackgroundTasks = !sending && p.killBackgroundTasks === true;
    const files = sending ? requestFiles(p.files) : [], text = sending ? messageText(p.text, files) : undefined;
    const opId = textRequired(p.opId, '操作标识', 100);
    const turn = sending
      ? (p.turn !== undefined && p.turn !== '' ? textRequired(p.turn, '对话轮次', 200) : undefined)
      : textRequired(p.turn, '对话轮次', 200);
    const model = sending && p.model !== undefined ? textRequired(p.model, '模型', 200) : undefined;
    const permissionMode = sending ? readPermissionMode(p.permissionMode) : undefined;
    const images = sending ? readImages(p.images) : [];
    checkCount(images, files);
    return this.ledger.run(opId, {
      action, id, text, ...(turn !== undefined ? {turn} : {}), ...attached(images, files),
      ...(model ? {model} : {}), ...(permissionMode ? {permissionMode} : {}),
      ...(delivery && delivery !== 'queue' ? {delivery} : {}),
      ...(killBackgroundTasks ? {killBackgroundTasks: true} : {}),
    }, async () => {
      if (this.writing.has(id)) throw new BridgeError('busy', '此会话正在处理另一次操作');
      const summary = this.summary(id);
      if (!sending) {
        const canStop = summary.status === active || (killBackgroundTasks && Boolean(summary.notIdle));
        if (turnKey(summary) !== turn || !canStop) throw new BridgeError('changed', '会话状态已变化，请刷新后再操作');
        this.writing.add(id);
        try {
          await this.hub(this.daemonDir(), 'CancelCascadeInvocation', {cascadeId: id, killBackgroundTasks});
          return {stopRequested: true};
        } finally { this.writing.delete(id); }
      }
      this.writing.add(id);
      try {
        if (delivery === 'queue') {
          const behind = !canSend(summary) || this.queue.queued(id).length > 0 || await this.hasWaitingRequests(id, summary);
          if (behind) {
            if (model) {
              const {models} = await this.modelCatalog();
              if (!models.some(option => option.id === model)) throw new BridgeError('invalid', '所选模型已不可用，请重新选择');
            }
            const prompt = await withAttachmentLinks(this.ledger, conversationScope(id), text!, files);
            this.queue.enqueue(opId, id, {
              text: prompt,
              ...(images.length ? {images} : {}),
              ...(files.length ? {fileNames: files.map(file => file.name)} : {}),
              ...(model ? {model} : {}),
              ...(permissionMode ? {permissionMode} : {}),
            });
            this.queueChanged(id);
            return {conversationId: id, kind: 'queued'};
          }
          if (turn !== undefined && turnKey(summary) !== turn) throw new BridgeError('changed', '会话状态已变化，请刷新后再操作');
          const prompt = await withAttachmentLinks(this.ledger, conversationScope(id), text!, files);
          await this.sendToHub(id, summary, {text: prompt, images, model, permissionMode}, opId, {expectedTurn: turn});
          return {submitted: true, kind: 'turn_accepted'};
        }
        if (delivery === 'steer') {
          const running = summary.status === active;
          if (!running && !canSend(summary)) throw new BridgeError('changed', '会话正在切换状态，请稍后重试');
          const prompt = await withAttachmentLinks(this.ledger, conversationScope(id), text!, files);
          await this.sendToHub(id, summary, {text: prompt, images, model, permissionMode}, opId, running ? {deliveryStrategy: NEXT_INVOCATION} : undefined);
          return {submitted: true, kind: running ? 'steer_accepted' : 'turn_accepted'};
        }
        // Immediate send ('now'): validate model and attachments before interrupting any running turn.
        if (model) {
          const {models} = await this.modelCatalog();
          if (!models.some(option => option.id === model)) throw new BridgeError('invalid', '所选模型已不可用，请重新选择');
        }
        const prompt = await withAttachmentLinks(this.ledger, conversationScope(id), text!, files);
        const ready = summary.status === idle ? summary : await this.cancelAndWaitForIdle(id);
        await this.sendToHub(id, ready, {text: prompt, images, model, permissionMode}, opId);
        return {submitted: true, kind: 'sent_now'};
      } finally { this.writing.delete(id); }
    });
  }
}
