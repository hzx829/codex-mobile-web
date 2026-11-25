import {DatabaseSync} from 'node:sqlite';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

export type Role = 'owner' | 'admin' | 'member';
export type Service = 'codex' | 'claude' | 'antigravity';
export const ROLES: readonly Role[] = ['owner', 'admin', 'member'];
export interface User {id: string; name: string; role: Role; status: 'active' | 'disabled'; allMachines: boolean; machines: string[]; createdAt: number}
export interface Device {id: string; userId: string; name: string; createdAt: number; lastSeenAt: number | null; revokedAt: number | null}
export interface Owner {id: string; name: string}
/** One row per day, member, computer, app and model; `userId` is null for turns started on the computer itself. */
export interface UsageRow {day: string; userId: string | null; machineId: string; service: Service; model: string; turns: number; inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null}
export interface Activity {id: number; ts: number; userId: string; userName: string; deviceId: string | null; machineId: string; service: Service; action: string; threadId: string | null; threadTitle?: string | null; detail?: string | null; state: string}

/** One invite stays usable for a day; it only turns into a device token, which the browser keeps. */
export const INVITE_TTL_MS = 24 * 3600_000;
const ACTIVITY_DAYS = 400;
const NAME_MAX = 40;

export const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');
const secret = (prefix: string, bytes: number) => prefix + randomBytes(bytes).toString('base64url');
export const isAdmin = (user: Pick<User, 'role'>) => user.role === 'owner' || user.role === 'admin';

export class TeamError extends Error {
  constructor(public code: string, message: string) {super(message);}
}

export function cleanName(value: unknown, label = '名字'): string {
  if (typeof value !== 'string') throw new TeamError('invalid', `${label}无效`);
  const name = value.replace(/\s+/g, ' ').trim();
  if (!name || name.length > NAME_MAX || /[\u0000-\u001f]/.test(name)) throw new TeamError('invalid', `${label}需为 1–${NAME_MAX} 个字符`);
  return name;
}

/**
 * The relay's own records once a team is set up: members, their devices, invites, computers,
 * who started each session and who did what. No message text is stored.
 */
export class TeamStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), {recursive: true});
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
        all_machines INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), code_hash TEXT UNIQUE NOT NULL,
        created_by TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, name TEXT NOT NULL, connector_token_hash TEXT UNIQUE,
        created_at INTEGER NOT NULL, last_seen_at INTEGER);
      CREATE TABLE IF NOT EXISTS machine_access (user_id TEXT NOT NULL REFERENCES users(id), machine_id TEXT NOT NULL, PRIMARY KEY(user_id, machine_id));
      CREATE TABLE IF NOT EXISTS threads (machine_id TEXT NOT NULL, service TEXT NOT NULL, thread_id TEXT NOT NULL, owner_id TEXT REFERENCES users(id),
        parent_thread_id TEXT, title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER, PRIMARY KEY(machine_id, service, thread_id));
      CREATE TABLE IF NOT EXISTS projects (machine_id TEXT NOT NULL, service TEXT NOT NULL, project_id TEXT NOT NULL, name TEXT NOT NULL,
        owner_id TEXT REFERENCES users(id), created_at INTEGER NOT NULL, PRIMARY KEY(machine_id, service, project_id));
      CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT NOT NULL, device_id TEXT,
        machine_id TEXT NOT NULL, service TEXT NOT NULL, action TEXT NOT NULL, thread_id TEXT, op_id TEXT, state TEXT NOT NULL, detail TEXT);
      CREATE INDEX IF NOT EXISTS activity_ts ON activity(ts);
      CREATE INDEX IF NOT EXISTS activity_user ON activity(user_id, ts);
      CREATE INDEX IF NOT EXISTS activity_thread ON activity(machine_id, service, thread_id, ts);
      CREATE TABLE IF NOT EXISTS usage (event_id TEXT NOT NULL, model TEXT NOT NULL, ts INTEGER NOT NULL, machine_id TEXT NOT NULL, service TEXT NOT NULL,
        thread_id TEXT NOT NULL, turn_id TEXT, user_id TEXT, turns INTEGER NOT NULL, input_tokens INTEGER, cached_input_tokens INTEGER,
        output_tokens INTEGER, reasoning_tokens INTEGER, PRIMARY KEY(event_id, model));
      CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
      CREATE INDEX IF NOT EXISTS usage_user ON usage(user_id, ts);`);
    if (!this.db.prepare('PRAGMA table_info(activity)').all().some(col => col.name === 'detail')) {
      this.db.exec('ALTER TABLE activity ADD COLUMN detail TEXT');
    }
    for (const table of ['activity', 'usage']) this.db.prepare(`DELETE FROM ${table} WHERE ts < ?`).run(Date.now() - ACTIVITY_DAYS * 86400_000);
  }

  /** Team mode starts with the first member; until then the relay keeps its single shared Token. */
  get enabled() {return Boolean(this.db.prepare('SELECT 1 FROM users LIMIT 1').get());}

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {const result = run();this.db.exec('COMMIT');return result;}
    catch (error) {this.db.exec('ROLLBACK');throw error;}
  }

  private toUser(row: Record<string, any>): User {
    const machines = row.all_machines ? [] : this.db.prepare('SELECT machine_id FROM machine_access WHERE user_id=? ORDER BY machine_id').all(row.id).map(r => String(r.machine_id));
    return {id: row.id, name: row.name, role: row.role, status: row.status, allMachines: Boolean(row.all_machines), machines, createdAt: row.created_at};
  }

  user(id: string): User | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id=?').get(id);
    return row ? this.toUser(row) : undefined;
  }

  users(): User[] {return this.db.prepare('SELECT * FROM users ORDER BY created_at').all().map(row => this.toUser(row));}

  userByName(name: string): User | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE name=? ORDER BY created_at LIMIT 1').get(name);
    return row ? this.toUser(row) : undefined;
  }

  createUser(input: {name: string; role: Role; machines?: 'all' | string[]}): User {
    const id = randomUUID(), name = cleanName(input.name);
    if (!ROLES.includes(input.role)) throw new TeamError('invalid', '角色无效');
    if (this.userByName(name)) throw new TeamError('exists', '已有同名成员');
    this.transaction(() => {
      this.db.prepare('INSERT INTO users (id, name, role, all_machines, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, name, input.role, input.machines === undefined || input.machines === 'all' ? 1 : 0, Date.now());
      if (Array.isArray(input.machines)) this.writeAccess(id, input.machines);
    });
    return this.user(id)!;
  }

  private writeAccess(userId: string, machines: string[]) {
    this.db.prepare('DELETE FROM machine_access WHERE user_id=?').run(userId);
    for (const machineId of new Set(machines)) this.db.prepare('INSERT INTO machine_access VALUES (?, ?)').run(userId, machineId);
  }

  updateUser(id: string, patch: {name?: string; role?: Role; status?: 'active' | 'disabled'; machines?: 'all' | string[]}): User {
    const user = this.user(id);
    if (!user) throw new TeamError('not_found', '成员不存在');
    const name = patch.name === undefined ? user.name : cleanName(patch.name);
    const role = patch.role ?? user.role, status = patch.status ?? user.status;
    if (!ROLES.includes(role)) throw new TeamError('invalid', '角色无效');
    if (status !== 'active' && status !== 'disabled') throw new TeamError('invalid', '状态无效');
    const other = this.userByName(name);
    if (other && other.id !== id) throw new TeamError('exists', '已有同名成员');
    if (user.role === 'owner' && user.status === 'active' && (role !== 'owner' || status !== 'active') && this.activeOwners() <= 1)
      throw new TeamError('last_owner', '至少要保留一位所有者');
    this.transaction(() => {
      this.db.prepare('UPDATE users SET name=?, role=?, status=? WHERE id=?').run(name, role, status, id);
      if (patch.machines !== undefined) {
        this.db.prepare('UPDATE users SET all_machines=? WHERE id=?').run(patch.machines === 'all' ? 1 : 0, id);
        this.writeAccess(id, patch.machines === 'all' ? [] : patch.machines);
      }
    });
    return this.user(id)!;
  }

  private activeOwners() {return Number(this.db.prepare("SELECT count(*) AS n FROM users WHERE role='owner' AND status='active'").get()!.n);}

  /** Admins reach every computer; members the ones granted to them, or all when nothing is listed. */
  canUse(user: User, machineId: string) {return isAdmin(user) || user.allMachines || user.machines.includes(machineId);}

  createInvite(userId: string, createdBy: string | null): {code: string; expiresAt: number} {
    if (!this.user(userId)) throw new TeamError('not_found', '成员不存在');
    const code = secret('inv_', 18), expiresAt = Date.now() + INVITE_TTL_MS;
    this.db.prepare('INSERT INTO invites (id, user_id, code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), userId, hashSecret(code), createdBy, Date.now(), expiresAt);
    return {code, expiresAt};
  }

  /** Turns a one-time invite into a long-lived token for this device; only its hash is kept. */
  redeemInvite(code: string, deviceName: string): {token: string; device: Device; user: User} {
    return this.transaction(() => {
      const invite = this.db.prepare('SELECT * FROM invites WHERE code_hash=?').get(hashSecret(code));
      if (!invite || invite.used_at || invite.revoked_at || Number(invite.expires_at) < Date.now()) throw new TeamError('invalid_invite', '邀请链接无效或已过期');
      const user = this.user(String(invite.user_id));
      if (!user || user.status !== 'active') throw new TeamError('invalid_invite', '邀请链接无效或已过期');
      this.db.prepare('UPDATE invites SET used_at=? WHERE id=?').run(Date.now(), invite.id);
      const token = secret('dev_', 32), id = randomUUID();
      let name: string;
      try {name = cleanName(deviceName, '设备名');} catch {name = '未命名设备';}
      this.db.prepare('INSERT INTO devices (id, user_id, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, user.id, name, hashSecret(token), Date.now(), Date.now());
      return {token, device: this.device(id)!, user};
    });
  }

  private toDevice(row: Record<string, any>): Device {
    return {id: row.id, userId: row.user_id, name: row.name, createdAt: row.created_at, lastSeenAt: row.last_seen_at ?? null, revokedAt: row.revoked_at ?? null};
  }

  device(id: string): Device | undefined {
    const row = this.db.prepare('SELECT * FROM devices WHERE id=?').get(id);
    return row ? this.toDevice(row) : undefined;
  }

  devices(userId?: string): Device[] {
    const rows = userId ? this.db.prepare('SELECT * FROM devices WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at').all(userId)
      : this.db.prepare('SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY created_at').all();
    return rows.map(row => this.toDevice(row));
  }

  /** The member and device behind a token, if both are still allowed in. */
  authenticate(token: string): {user: User; device: Device} | undefined {
    const row = this.db.prepare('SELECT * FROM devices WHERE token_hash=?').get(hashSecret(token));
    if (!row || row.revoked_at) return undefined;
    const user = this.user(String(row.user_id));
    if (!user || user.status !== 'active') return undefined;
    this.db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(Date.now(), row.id);
    return {user, device: this.toDevice(row)};
  }

  /** Who may use this device now, re-read after any change to members or devices. */
  session(deviceId: string): {user: User; device: Device} | undefined {
    const device = this.device(deviceId);
    if (!device || device.revokedAt) return undefined;
    const user = this.user(device.userId);
    return user && user.status === 'active' ? {user, device} : undefined;
  }

  revokeDevice(id: string) {this.db.prepare('UPDATE devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(Date.now(), id);}

  /** Computers the relay has seen. A computer with its own token can no longer sign in with the shared one. */
  seenMachine(id: string, name: string) {
    this.db.prepare(`INSERT INTO machines (id, name, created_at, last_seen_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, last_seen_at=excluded.last_seen_at`).run(id, name, Date.now(), Date.now());
  }

  machines(): {id: string; name: string; ownToken: boolean; lastSeenAt: number | null}[] {
    return this.db.prepare('SELECT * FROM machines ORDER BY name').all()
      .map(row => ({id: String(row.id), name: String(row.name), ownToken: Boolean(row.connector_token_hash), lastSeenAt: row.last_seen_at === null ? null : Number(row.last_seen_at)}));
  }

  createMachineToken(machineId: string): string {
    const token = secret('cnt_', 32);
    const changed = this.db.prepare('UPDATE machines SET connector_token_hash=? WHERE id=?').run(hashSecret(token), machineId).changes;
    if (!changed) throw new TeamError('not_found', '这台电脑还没有连接过中继');
    return token;
  }

  revokeMachineToken(machineId: string) {this.db.prepare('UPDATE machines SET connector_token_hash=NULL WHERE id=?').run(machineId);}

  /** `undefined`: no token of its own (the shared token still works); otherwise whether this one matches. */
  machineToken(machineId: string, token: string): boolean | undefined {
    const row = this.db.prepare('SELECT connector_token_hash FROM machines WHERE id=?').get(machineId);
    if (!row?.connector_token_hash) return undefined;
    return row.connector_token_hash === hashSecret(token);
  }

  /** The first record wins: a retried create never moves a session to someone else. */
  recordThread(machineId: string, service: Service, threadId: string, ownerId: string, parentThreadId?: string) {
    this.db.prepare(`INSERT INTO threads (machine_id, service, thread_id, owner_id, parent_thread_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(machine_id, service, thread_id) DO UPDATE SET owner_id=COALESCE(threads.owner_id, excluded.owner_id)`).run(machineId, service, threadId, ownerId, parentThreadId ?? null, Date.now());
  }

  claimThread(machineId: string, service: Service, threadId: string, ownerId: string | null) {
    this.db.prepare(`INSERT INTO threads (machine_id, service, thread_id, owner_id, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(machine_id, service, thread_id) DO UPDATE SET owner_id=excluded.owner_id`).run(machineId, service, threadId, ownerId, Date.now());
  }

  owners(machineId: string, service: Service, threadIds: string[]): Map<string, Owner> {
    const owners = new Map<string, Owner>();
    const read = this.db.prepare(`SELECT t.thread_id, u.id, u.name FROM threads t JOIN users u ON u.id=t.owner_id
      WHERE t.machine_id=? AND t.service=? AND t.thread_id=?`);
    for (const id of new Set(threadIds)) {
      const row = read.get(machineId, service, id);
      if (row) owners.set(id, {id: String(row.id), name: String(row.name)});
    }
    return owners;
  }

  /** Keeps the list's title next to the owner, for pages that show sessions across computers. */
  touchThreads(machineId: string, service: Service, items: {id: string; title?: unknown; updatedAt?: unknown}[]) {
    const update = this.db.prepare('UPDATE threads SET title=?, updated_at=? WHERE machine_id=? AND service=? AND thread_id=?');
    for (const item of items) {
      const title = typeof item.title === 'string' ? item.title.slice(0, 200) : null;
      const updated = typeof item.updatedAt === 'number' ? item.updatedAt : null;
      update.run(title, updated, machineId, service, item.id);
    }
  }

  /** The first record wins: a retried create never moves a project to someone else. */
  recordProject(machineId: string, service: Service, projectId: string, name: string, ownerId: string) {
    this.db.prepare(`INSERT INTO projects (machine_id, service, project_id, name, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(machine_id, service, project_id) DO UPDATE SET name=excluded.name, owner_id=COALESCE(projects.owner_id, excluded.owner_id)`)
      .run(machineId, service, projectId, name.slice(0, 120), ownerId, Date.now());
  }

  projectOwners(machineId: string, service: Service, projectIds: string[]): Map<string, Owner> {
    const owners = new Map<string, Owner>();
    const read = this.db.prepare(`SELECT p.project_id, u.id, u.name FROM projects p JOIN users u ON u.id=p.owner_id
      WHERE p.machine_id=? AND p.service=? AND p.project_id=?`);
    for (const id of new Set(projectIds)) {
      if (!id) continue;
      const row = read.get(machineId, service, id);
      if (row) owners.set(id, {id: String(row.id), name: String(row.name)});
    }
    return owners;
  }

  addActivity(entry: Omit<Activity, 'id' | 'ts' | 'userName'> & {opId?: string | null}) {
    this.db.prepare('INSERT INTO activity (ts, user_id, device_id, machine_id, service, action, thread_id, op_id, state, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), entry.userId, entry.deviceId, entry.machineId, entry.service, entry.action, entry.threadId, entry.opId ?? null, entry.state, entry.detail ?? null);
  }

  lastSender(machineId: string, service: Service, threadId: string, actions: string[]): Owner | undefined {
    const row = this.db.prepare(`SELECT u.id, u.name FROM activity a JOIN users u ON u.id=a.user_id
      WHERE a.machine_id=? AND a.service=? AND a.thread_id=? AND a.state!='failed' AND a.action IN (${actions.map(() => '?').join(',')})
      ORDER BY a.ts DESC, a.id DESC LIMIT 1`).get(machineId, service, threadId, ...actions);
    return row ? {id: String(row.id), name: String(row.name)} : undefined;
  }

  activity(filter: {userId?: string; machineId?: string; before?: number; limit?: number}): Activity[] {
    const where: string[] = [], values: (string | number)[] = [];
    if (filter.userId) {where.push('a.user_id=?');values.push(filter.userId);}
    if (filter.machineId) {where.push('a.machine_id=?');values.push(filter.machineId);}
    if (filter.before) {where.push('a.id<?');values.push(filter.before);}
    const limit = Math.min(Math.max(Number(filter.limit) || 50, 1), 200);
    return this.db.prepare(`SELECT a.*, u.name AS user_name, t.title AS thread_title FROM activity a JOIN users u ON u.id=a.user_id
      LEFT JOIN threads t ON t.machine_id=a.machine_id AND t.service=a.service AND t.thread_id=a.thread_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ${limit}`).all(...values)
      .map(row => ({id: Number(row.id), ts: Number(row.ts), userId: String(row.user_id), userName: String(row.user_name), deviceId: row.device_id === null ? null : String(row.device_id),
        machineId: String(row.machine_id), service: row.service as Service, action: String(row.action), threadId: row.thread_id === null ? null : String(row.thread_id),
        threadTitle: row.thread_title === null || row.thread_title === undefined ? null : String(row.thread_title),
        detail: row.detail === null || row.detail === undefined ? null : String(row.detail),
        state: String(row.state)}));
  }

  /**
   * Stores finished turns a computer reported and returns the IDs it may forget: stored, already
   * stored, or invalid. A turn's first model row counts the turn; further models only add tokens.
   */
  addUsage(machineId: string, events: unknown[]): string[] {
    const done: string[] = [];
    const insert = this.db.prepare(`INSERT OR IGNORE INTO usage (event_id, model, ts, machine_id, service, thread_id, turn_id, user_id, turns,
      input_tokens, cached_input_tokens, output_tokens, reasoning_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const own = this.db.prepare('INSERT OR IGNORE INTO threads (machine_id, service, thread_id, owner_id, created_at) VALUES (?, ?, ?, ?, ?)');
    const tokens = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
    this.transaction(() => {
      for (const raw of events) {
        const event = raw as Record<string, any>;
        if (typeof event?.id !== 'string' || !event.id || event.id.length > 300) continue;
        done.push(event.id);
        const service = event.service;
        if (service !== 'codex' && service !== 'claude' && service !== 'antigravity') continue;
        if (typeof event.threadId !== 'string' || !event.threadId || event.threadId.length > 200) continue;
        const ts = typeof event.ts === 'number' && Number.isFinite(event.ts) ? Math.min(event.ts, Date.now()) : Date.now();
        const user = typeof event.actor?.userId === 'string' && this.user(event.actor.userId) ? event.actor.userId as string : null;
        const id = `${machineId}:${event.id}`, turnId = typeof event.turnId === 'string' ? event.turnId.slice(0, 200) : null;
        const models = Array.isArray(event.models) ? event.models.filter((item: any) => item && typeof item.model === 'string').slice(0, 20) : [];
        if (!models.length) insert.run(id, '', ts, machineId, service, event.threadId, turnId, user, 1, null, null, null, null);
        models.forEach((item: any, index: number) => insert.run(id, item.model.slice(0, 200), ts, machineId, service, event.threadId, turnId, user, index ? 0 : 1,
          tokens(item.inputTokens), tokens(item.cachedInputTokens), tokens(item.outputTokens), tokens(item.reasoningTokens)));
        // A session whose create reply was lost still gets the sender of its first turn as owner.
        if (user) own.run(machineId, service, event.threadId, user, ts);
      }
    });
    return done;
  }

  /** Turns and tokens from `since` on, by local day (`offsetMinutes` east of UTC), member, computer, app and model. */
  usage(filter: {since: number; until?: number; userId?: string; offsetMinutes?: number}): UsageRow[] {
    const offset = Math.max(-14 * 60, Math.min(14 * 60, Math.round(Number(filter.offsetMinutes) || 0))) * 60_000;
    const where = ['ts >= ?', 'ts < ?'], values: (string | number)[] = [filter.since, filter.until ?? Date.now() + 60_000];
    if (filter.userId) {where.push('user_id = ?');values.push(filter.userId);}
    return this.db.prepare(`SELECT date((ts + ${offset}) / 1000, 'unixepoch') AS day, user_id, machine_id, service, model, SUM(turns) AS turns,
      SUM(input_tokens) AS input, SUM(cached_input_tokens) AS cached, SUM(output_tokens) AS output, SUM(reasoning_tokens) AS reasoning
      FROM usage WHERE ${where.join(' AND ')} GROUP BY day, user_id, machine_id, service, model ORDER BY day`).all(...values)
      .map(row => ({day: String(row.day), userId: row.user_id === null ? null : String(row.user_id), machineId: String(row.machine_id), service: row.service as Service, model: String(row.model),
        turns: Number(row.turns), inputTokens: row.input === null ? null : Number(row.input), cachedInputTokens: row.cached === null ? null : Number(row.cached),
        outputTokens: row.output === null ? null : Number(row.output), reasoningTokens: row.reasoning === null ? null : Number(row.reasoning)}));
  }

  close() {this.db.close();}
}
