import type {Json} from '../../shared/types.js';
import {ROLES, TeamError, TeamStore, isAdmin, type Device, type Role, type Service, type User} from './store.js';

export type Member = {user: User; device: Device};

export const serviceOf = (action: string): Service => action.startsWith('claude.') ? 'claude' : action.startsWith('antigravity.') ? 'antigravity' : 'codex';

/** Requests that start a session; the relay records the sender as its owner. */
export const CREATE_ACTIONS = new Set(['session.create', 'session.fork', 'claude.create', 'claude.fork', 'antigravity.create']);
/** Session lists and reads, which the relay marks with each session's owner. */
export const LIST_ACTIONS = new Set(['sessions.list', 'claude.list', 'antigravity.list']);
/** Responses whose `projects` array gets team creator attribution. */
export const PROJECT_LIST_ACTIONS = new Set(['info', 'claude.list', 'antigravity.list']);
export const READ_ACTIONS = new Set(['session.read', 'claude.read', 'antigravity.read', 'sync.open']);
/** Replies whose messages may name their sender; the relay shows each member's current name. */
export const SENDER_ACTIONS = new Set([...READ_ACTIONS, 'claude.watch', 'antigravity.watch', 'sync.page']);

const list = (value: unknown): Json[] => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : [];
/** A turn's items, or a message itself. */
const messagesOf = (entry: Json): Json[] => Array.isArray(entry.items) ? list(entry.items) : [entry];
/**
 * Replaces the name the computer recorded with the member's current one, so a renamed member reads the same everywhere.
 * Reads, watches, synced snapshots and pages (`entries`) and live frames (`entries`, `patches`) all carry messages.
 */
export function refreshSenderNames(store: TeamStore, result: Json) {
  const names = new Map<string, string>();
  const messages: Json[] = [...list(result.messages), ...list(result.turns).flatMap(messagesOf),
    ...list(result.entries).flatMap(entry => entry.body && typeof entry.body === 'object' ? messagesOf(entry.body) : []),
    ...list(result.patches).flatMap(patch => list(patch.ops).flatMap(op => op.item && typeof op.item === 'object' ? [op.item] : []))];
  for (const message of messages) {
    const id = message?.sender?.id;
    if (typeof id !== 'string') continue;
    if (!names.has(id)) names.set(id, store.user(id)?.name ?? message.sender.name);
    message.sender = {id, name: names.get(id)};
  }
}
/** Requests that put a message into a session. */
export const SEND_ACTIONS = ['session.create', 'turn.send', 'turn.steerQueued', 'turn.edit', 'claude.create', 'claude.send', 'claude.steerQueued', 'claude.edit', 'antigravity.create', 'antigravity.send', 'antigravity.steerQueued'];
/** Requests that change something on a computer; each one is written to the activity log. */
export const MUTATION_ACTIONS = new Set([
  'project.create', 'projects.create', 'runtime.reload', 'session.create', 'session.fork', 'session.resume', 'session.rename', 'session.archive', 'session.unarchive',
  'turn.send', 'turn.cancelQueued', 'turn.withdrawQueued', 'turn.steerQueued', 'turn.edit', 'turn.stop', 'request.respond',
  'claude.create', 'claude.send', 'claude.stop', 'claude.respond', 'claude.project.save', 'claude.fork', 'claude.rename', 'claude.archive', 'claude.edit',
  'claude.steerQueued', 'claude.withdrawQueued', 'claude.cancelQueued',
  'antigravity.create', 'antigravity.send', 'antigravity.stop', 'antigravity.respond',
  'antigravity.steerQueued', 'antigravity.withdrawQueued', 'antigravity.cancelQueued',
]);

const text = (value: unknown) => typeof value === 'string' && value ? value : undefined;
/** The session a request or its result names: Codex calls it a thread, Claude Code and Antigravity a conversation. */
export function threadOf(payload: Json, result?: Json): string | undefined {
  return text(result?.threadId) || text(result?.conversationId) || text(payload.threadId) || text(payload.conversationId);
}
/** The session a create request made, or none when it failed. A fork's source is in the payload instead. */
export function createdThread(action: string, payload: Json, result: Json | undefined): {id: string; parent?: string} | undefined {
  if (!result || result.state === 'failed' || result.error) return undefined;
  const id = text(result.threadId) || text(result.conversationId);
  if (!id) return undefined;
  const parent = action.endsWith('.fork') ? text(payload.threadId) || text(payload.conversationId) : undefined;
  return {id, parent};
}

export const publicUser = (user: User) => ({id: user.id, name: user.name, role: user.role});

function requireAdmin(me: User) {if (!isAdmin(me)) throw new TeamError('forbidden', '只有管理员可以进行此操作');}
/** Admins manage members and admins; only an owner manages owners or makes someone an owner. */
function requireManage(me: User, target: User, role?: Role) {
  requireAdmin(me);
  if (me.role !== 'owner' && (target.role === 'owner' || role === 'owner')) throw new TeamError('forbidden', '只有所有者可以管理所有者');
}
function machineList(value: unknown): 'all' | string[] | undefined {
  if (value === undefined) return undefined;
  if (value === 'all') return 'all';
  if (Array.isArray(value) && value.every(item => typeof item === 'string' && item.length <= 80)) return value as string[];
  throw new TeamError('invalid', '电脑范围无效');
}
function role(value: unknown): Role | undefined {
  if (value === undefined) return undefined;
  if (!ROLES.includes(value as Role)) throw new TeamError('invalid', '角色无效');
  return value as Role;
}
function target(store: TeamStore, id: unknown): User {
  const user = typeof id === 'string' ? store.user(id) : undefined;
  if (!user) throw new TeamError('not_found', '成员不存在');
  return user;
}
function service(value: unknown): Service {
  if (value !== 'codex' && value !== 'claude' && value !== 'antigravity') throw new TeamError('invalid', '应用无效');
  return value;
}

export interface TeamContext {
  /** Computers connected right now, by ID. */
  online: Map<string, string>;
}

/**
 * `team.*` requests answered by the relay itself. `refresh` asks the relay to re-check every
 * signed-in device, so a revoked device or a narrowed member loses access at once.
 */
export function handleTeam(store: TeamStore, me: Member, action: string, p: Json, context: TeamContext): {result: Json; refresh?: boolean} {
  const self = me.user;
  switch (action) {
    case 'team.me':
      return {result: {user: publicUser(self), device: me.device}};
    case 'team.roster':
      return {result: {members: store.users().filter(user => user.status === 'active').map(user => ({id: user.id, name: user.name}))}};
    case 'team.devices.list': {
      const userId = p.userId === undefined ? self.id : String(p.userId);
      if (userId !== self.id) requireAdmin(self);
      return {result: {devices: store.devices(userId).map(device => ({...device, current: device.id === me.device.id}))}};
    }
    case 'team.devices.revoke': {
      const device = typeof p.deviceId === 'string' ? store.device(p.deviceId) : undefined;
      if (!device) throw new TeamError('not_found', '设备不存在');
      if (device.userId !== self.id) requireManage(self, target(store, device.userId));
      store.revokeDevice(device.id);
      return {result: {revoked: true}, refresh: true};
    }
    case 'team.devices.invite':
      return {result: store.createInvite(self.id, self.id)};
    case 'team.members.list': {
      requireAdmin(self);
      const devices = store.devices();
      return {result: {members: store.users().map(user => {
        const own = devices.filter(device => device.userId === user.id);
        return {...user, devices: own.length, lastSeenAt: Math.max(0, ...own.map(device => device.lastSeenAt || 0)) || null};
      })}};
    }
    case 'team.members.create': {
      const newRole = role(p.role) ?? 'member';
      requireAdmin(self);
      if (newRole === 'owner' && self.role !== 'owner') throw new TeamError('forbidden', '只有所有者可以添加所有者');
      const user = store.createUser({name: p.name, role: newRole, machines: machineList(p.machines)});
      return {result: {user, invite: store.createInvite(user.id, self.id)}};
    }
    case 'team.members.update': {
      const user = target(store, p.userId), newRole = role(p.role);
      requireManage(self, user, newRole);
      const status = p.status === undefined ? undefined : p.status === 'disabled' ? 'disabled' as const : p.status === 'active' ? 'active' as const : (() => {throw new TeamError('invalid', '状态无效');})();
      return {result: {user: store.updateUser(user.id, {name: p.name, role: newRole, status, machines: machineList(p.machines)})}, refresh: true};
    }
    case 'team.invites.create': {
      const user = target(store, p.userId);
      requireManage(self, user);
      if (user.status !== 'active') throw new TeamError('invalid', '成员已停用，请先恢复');
      return {result: store.createInvite(user.id, self.id)};
    }
    case 'team.machines.list': {
      requireAdmin(self);
      const known = store.machines();
      const ids = new Set([...known.map(machine => machine.id), ...context.online.keys()]);
      return {result: {machines: [...ids].map(id => {
        const machine = known.find(item => item.id === id);
        return {id, name: context.online.get(id) || machine?.name || id, online: context.online.has(id), ownToken: Boolean(machine?.ownToken), lastSeenAt: machine?.lastSeenAt ?? null};
      })}};
    }
    case 'team.machines.token': {
      requireAdmin(self);
      return {result: {token: store.createMachineToken(String(p.machineId))}};
    }
    case 'team.machines.revokeToken': {
      requireAdmin(self);
      store.revokeMachineToken(String(p.machineId));
      return {result: {revoked: true}};
    }
    case 'team.threads.claim': {
      requireAdmin(self);
      const owner = p.userId === null ? null : target(store, p.userId).id;
      if (typeof p.machineId !== 'string' || typeof p.threadId !== 'string' || !p.threadId) throw new TeamError('invalid', '会话无效');
      store.claimThread(p.machineId, service(p.service), p.threadId, owner);
      return {result: {claimed: true}};
    }
    case 'team.usage': {
      // Members see their own turns; admins everyone's, including turns started on the computers themselves.
      const since = Math.max(Number(p.since) || 0, Date.now() - 400 * 86400_000);
      const userId = isAdmin(self) ? (typeof p.userId === 'string' ? p.userId : undefined) : self.id;
      const rows = store.usage({since, until: Number(p.until) || undefined, userId, offsetMinutes: p.offsetMinutes});
      const members = store.users().filter(user => isAdmin(self) || user.id === self.id).map(user => ({id: user.id, name: user.name}));
      const machines = store.machines().map(machine => ({id: machine.id, name: context.online.get(machine.id) || machine.name}));
      return {result: {rows, members, machines}};
    }
    case 'team.activity': {
      const userId = isAdmin(self) ? (typeof p.userId === 'string' ? p.userId : undefined) : self.id;
      const machineId = typeof p.machineId === 'string' ? p.machineId : undefined;
      const members = isAdmin(self) ? store.users().map(user => ({id: user.id, name: user.name})) : [{id: self.id, name: self.name}];
      const machines = store.machines().filter(machine => store.canUse(self, machine.id)).map(machine => ({id: machine.id, name: context.online.get(machine.id) || machine.name}));
      return {result: {entries: store.activity({userId, machineId, before: Number(p.before) || undefined, limit: Number(p.limit) || undefined}), members, machines}};
    }
    default:
      throw new TeamError('unsupported', '中继暂不支持此团队操作，请更新中继');
  }
}
