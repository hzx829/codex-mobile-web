import {createHash, randomUUID} from 'node:crypto';
import {BridgeError, MAX_FRAME, textRequired, type Json} from '../shared/types.js';
import {withImageRefs, type BlobStore} from './blob-store.js';
import {isSyncService, type SyncEntry, type SyncFrame, type SyncPage, type SyncPatch, type SyncService, type SyncSnapshot} from '../shared/sync.js';

/**
 * Subscriptions to threads (docs/sync/DESIGN.md §5–6). A phone opens a thread with `sync.open` and renews it by opening
 * again; while it is open the hub checks the thread's version, and when it changed, pushes one numbered frame with only
 * what changed since the last frame. Phones that miss a frame open again with the revs they hold. The hub keeps, per open
 * thread, the revs of its latest entries and the bodies of the newest few, never earlier frames.
 */
export interface ThreadState {head: Json; entries: Json[]}
export interface ThreadSource {
  /** Changes whenever anything the phone sees may have; called often, so it must be cheap. */
  version(threadId: string): Promise<string>;
  /** The whole thread, oldest entry first; each entry has a string `id`. */
  state(threadId: string): Promise<ThreadState>;
  /** Lets the source say a thread changed, so an open one is checked before the next poll. */
  watch?(poke: (threadId: string) => void): void;
  /** How many of the newest entries a phone is sent and frames are compared over; turns default to 60. */
  window?: number;
}

const WATCH_MS = 30_000, WINDOW = 60, POLL_MS = 250, MIN_GAP_MS = 40, KEEP_BODIES = 2, PAGE = 30;

type Sent = {head: Map<string, string>; order: string[]; revs: Map<string, string>; bodies: Map<string, Json>};
type Thread = {service: SyncService; id: string; epoch: string; seq: number; until: number; version?: string; state?: ThreadState; sent?: Sent;
  running?: Promise<void>; again: boolean; timer?: NodeJS.Timeout; lastRun: number; changedAt?: number};

const revs = new WeakMap<object, string>();
/** The SHA-256 of an entry's body; sources that keep unchanged entries as the same objects get it for free. */
export function revOf(body: Json): string {
  let rev = revs.get(body);
  if (!rev) {rev = createHash('sha256').update(JSON.stringify(body)).digest('hex');revs.set(body, rev);}
  return rev;
}
const same = (left: unknown, right: unknown) => left === right || JSON.stringify(left) === JSON.stringify(right);

/**
 * Item operations that bring a turn-shaped entry (`items` with ids) from `previous` to `next`, or null when only the
 * whole entry can: items removed or reordered. Text that only grew is sent as what was appended.
 */
export function entryDiff(previous: Json, next: Json): {ops: Json[]; fields: Json} | null {
  if (previous.id !== next.id || !Array.isArray(previous.items) || !Array.isArray(next.items) || next.items.length < previous.items.length) return null;
  const ops: Json[] = [];
  for (const [index, item] of next.items.entries()) {
    const old = previous.items[index];
    if (!old) {ops.push({i: item.id, item});continue;}
    if (old.id !== item.id) return null;
    if (old === item || same(old, item)) continue;
    const {text: oldText, ...oldRest} = old, {text, ...rest} = item;
    if (typeof oldText === 'string' && typeof text === 'string' && text.length > oldText.length && text.startsWith(oldText) && same(oldRest, rest))
      ops.push({i: item.id, o: oldText.length, t: text.slice(oldText.length)});
    else ops.push({i: item.id, item});
  }
  const fields: Json = {};
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (key !== 'items' && !same(previous[key], next[key])) fields[key] = next[key] ?? null;
  }
  return {ops, fields};
}

export class ThreadHub {
  private sources = new Map<SyncService, ThreadSource>();
  private threads = new Map<string, Thread>();
  private poller?: NodeJS.Timeout;
  /** `send` pushes a frame to the relay and throws when it cannot; `timed` adds when the change arrived (web/trace.ts). */
  constructor(private send: (frame: SyncFrame) => void, private timed: () => boolean = () => false, private now = Date.now) {}

  /**
   * Where images go when the relay can serve them (src/connector/blob-store.ts): entries then carry references instead of
   * data URLs. Each entry object is changed once, so an unchanged entry keeps its rev.
   */
  images: BlobStore | null = null;
  private withRefs = new WeakMap<object, Json>();
  private shaped(state: ThreadState): ThreadState {
    const store = this.images;
    if (!store) return state;
    let changed = false;
    const entries = state.entries.map(entry => {
      let next = this.withRefs.get(entry);
      if (!next) {next = withImageRefs(store, entry);this.withRefs.set(entry, next);}
      if (next !== entry) changed = true;
      return next;
    });
    return changed ? {...state, entries} : state;
  }

  register(service: SyncService, source: ThreadSource) {this.sources.set(service, source);source.watch?.(id => this.poke(service, id));}
  get services() {return [...this.sources.keys()];}

  /** Opens or renews a thread for a phone: what it lacks of the thread now, and the frame number after which it follows. */
  async open(payload: Json): Promise<SyncSnapshot> {
    const thread = this.thread(payload, true);
    thread.until = this.now() + WATCH_MS;
    this.startPolling();
    // Phones already following get what changed first, so this answer and their frames agree on the frame number.
    await this.refresh(thread);
    const state = thread.state!, all = state.entries;
    const have: Record<string, string> = payload.have && typeof payload.have === 'object' ? payload.have : {};
    const from = typeof payload.from === 'string' ? all.findIndex(entry => entry.id === payload.from) : -1;
    const size = this.source(thread.service).window ?? WINDOW;
    const start = from >= 0 ? Math.min(from, Math.max(0, all.length - size)) : Math.max(0, all.length - size);
    const {order, entries} = this.fill(all.slice(start), have, Buffer.byteLength(JSON.stringify(state.head)));
    return {epoch: thread.epoch, seq: thread.seq, head: state.head, order, entries, hasMore: all.length > order.length};
  }

  /** Entries before `before`, newest `limit` of them; not a subscription. */
  async page(payload: Json): Promise<SyncPage> {
    const service = payload.service;
    if (!isSyncService(service) || !this.sources.has(service)) throw new BridgeError('unsupported', '这个应用暂不支持同步');
    const id = textRequired(payload.threadId, '会话', 200), before = textRequired(payload.before, '历史位置', 200);
    const limit = Math.min(100, Math.max(1, Math.floor(Number(payload.limit) || PAGE)));
    const all = this.shaped(await this.sources.get(service)!.state(id)).entries, end = all.findIndex(entry => entry.id === before);
    if (end < 0) throw new BridgeError('changed', '历史位置已变化，请重新打开会话');
    const start = Math.max(0, end - limit), {order, entries} = this.fill(all.slice(start, end), {}, 0);
    return {order, entries, hasMore: end > order.length};
  }

  /** The source says a thread changed; an open thread is checked at once instead of at the next poll. */
  poke(service: SyncService, threadId: string) {
    const thread = this.threads.get(`${service}:${threadId}`);
    if (thread) this.schedule(thread);
  }

  close() {clearInterval(this.poller);for (const thread of this.threads.values()) clearTimeout(thread.timer);this.threads.clear();}

  private source(service: SyncService) {
    const source = this.sources.get(service);
    if (!source) throw new BridgeError('unsupported', '这个应用暂不支持同步，请更新电脑连接器');
    return source;
  }
  private thread(payload: Json, create: boolean): Thread {
    const service = payload.service;
    if (!isSyncService(service)) throw new BridgeError('invalid', '应用无效');
    this.source(service);
    const id = textRequired(payload.threadId, '会话', 200), key = `${service}:${id}`;
    let thread = this.threads.get(key);
    if (!thread && create) {thread = {service, id, epoch: randomUUID(), seq: 0, until: 0, again: false, lastRun: 0};this.threads.set(key, thread);}
    return thread!;
  }
  /** The newest entries that fit a frame, oldest first; ones the phone has at the same rev cost only their ID. */
  private fill(list: Json[], have: Record<string, string>, used: number) {
    const order: string[] = [], entries: SyncEntry[] = [];
    let size = used + 4096;
    for (let index = list.length - 1; index >= 0; index--) {
      const body = list[index], rev = revOf(body), held = have[body.id] === rev;
      const bytes = (held ? 0 : Buffer.byteLength(JSON.stringify(body)) + rev.length + 32) + body.id.length + 4;
      if (size + bytes > MAX_FRAME) {
        if (!order.length) throw new BridgeError('too_large', '这一轮内容超过传输上限，请在电脑查看');
        break;
      }
      size += bytes;order.unshift(body.id);
      if (!held) entries.unshift({id: body.id, rev, body});
    }
    return {order, entries};
  }

  private startPolling() {
    if (this.poller) return;
    this.poller = setInterval(() => {
      const now = this.now();
      for (const [key, thread] of this.threads) {
        if (thread.until < now) {clearTimeout(thread.timer);this.threads.delete(key);continue;}
        this.schedule(thread);
      }
      if (!this.threads.size) {clearInterval(this.poller);this.poller = undefined;}
    }, POLL_MS);
    this.poller.unref?.();
  }
  /**
   * Checks a thread now, or right after the check under way, keeping checks at least {@link MIN_GAP_MS} apart. `changedAt`,
   * reported on traced frames, is when the source said it changed, or when a poll found it.
   */
  private schedule(thread: Thread) {
    thread.changedAt ??= this.now();
    if (thread.running) {thread.again = true;return;}
    if (thread.timer) return;
    const wait = MIN_GAP_MS - (this.now() - thread.lastRun);
    if (wait > 0) {thread.timer = setTimeout(() => {thread.timer = undefined;void this.refresh(thread).catch(() => {});}, wait);return;}
    void this.refresh(thread).catch(() => {});
  }
  /** Reads the thread if its version moved and pushes what changed. One check per thread at a time. */
  private refresh(thread: Thread): Promise<void> {
    if (thread.running) {thread.again = true;return thread.running;}
    const run = (async () => {
      try {
        do {
          thread.again = false;thread.lastRun = this.now();
          const source = this.source(thread.service), version = await source.version(thread.id);
          if (version === thread.version && thread.state) continue;
          const state = this.shaped(await source.state(thread.id));
          thread.version = version;
          this.push(thread, state);
        } while (thread.again);
      } finally {thread.running = undefined;thread.changedAt = undefined;}
    })();
    thread.running = run;
    return run;
  }
  private push(thread: Thread, state: ThreadState) {
    const size = this.source(thread.service).window ?? WINDOW;
    const window = state.entries.slice(-size), order = window.map(entry => entry.id as string);
    const head = new Map(Object.entries(state.head).map(([key, value]) => [key, JSON.stringify(value) ?? 'null']));
    const sent: Sent = {head, order, revs: new Map(window.map(entry => [entry.id, revOf(entry)])), bodies: new Map(window.slice(-KEEP_BODIES).map(entry => [entry.id, entry]))};
    const previous = thread.sent;
    thread.state = state;thread.sent = sent;
    if (!previous) return;
    const frame: SyncFrame = {type: 'live', service: thread.service, threadId: thread.id, epoch: thread.epoch, seq: thread.seq + 1};
    const headChanges: Json = {};
    for (const [key, value] of head) if (previous.head.get(key) !== value) headChanges[key] = state.head[key] ?? null;
    for (const key of previous.head.keys()) if (!head.has(key)) headChanges[key] = null;
    if (Object.keys(headChanges).length) frame.head = headChanges;
    if (!appended(previous.order, order)) frame.order = order;
    const entries: SyncEntry[] = [], patches: SyncPatch[] = [];
    for (const entry of window) {
      const rev = sent.revs.get(entry.id)!;
      if (previous.revs.get(entry.id) === rev) continue;
      const before = previous.bodies.get(entry.id), diff = before && entryDiff(before, entry);
      const patch = diff && {id: entry.id, rev, ops: diff.ops, fields: diff.fields}, whole = {id: entry.id, rev, body: entry};
      if (patch && JSON.stringify(patch).length < JSON.stringify(whole).length) patches.push(patch);
      else entries.push(whole);
    }
    if (entries.length) frame.entries = entries;
    if (patches.length) frame.patches = patches;
    if (!frame.head && !frame.order && !entries.length && !patches.length) return;
    if (this.timed() && thread.changedAt) {frame.at = thread.changedAt;frame.queuedMs = this.now() - thread.changedAt;}
    thread.seq++;
    try {this.send(frame);}
    catch {
      // A frame too large to send: phones see a new epoch and open the thread again.
      thread.epoch = randomUUID();thread.seq = 0;
      try {this.send({type: 'live', service: thread.service, threadId: thread.id, epoch: thread.epoch, seq: 0});} catch { /* Offline: they reopen on reconnect. */ }
    }
  }
}

/**
 * Whether `next` is `previous` with entries dropped from its start and others added at its end. When none of `previous` is
 * left, the phone cannot tell where `next` begins, so the order is sent and it opens the thread again.
 */
function appended(previous: string[], next: string[]) {
  if (!previous.length || !next.length) return !previous.length;
  const start = previous.indexOf(next[0]);
  if (start < 0) return false;
  const kept = previous.length - start;
  if (next.length < kept) return false;
  for (let index = 0; index < kept; index++) if (next[index] !== previous[start + index]) return false;
  return true;
}
