import type {Json} from './types.js';

/**
 * The subscription protocol of docs/sync/DESIGN.md §5: a thread is a head (every field but its entries) and an ordered
 * list of entries, each with an `id` and a `rev` (SHA-256 of its body). The phone opens a thread with the revs it has and
 * gets only what differs; the connector then pushes numbered frames with what changed.
 */
export type SyncService='claude'|'antigravity';
export const SYNC_SERVICES:readonly SyncService[]=['claude','antigravity'];

export interface SyncEntry {id:string;rev:string;body:Json}
/** An entry changed in place: item-level operations as in Codex's live frames (src/connector/live.ts). */
export interface SyncPatch {id:string;rev:string;ops:Json[];fields:Json}

/** `have`: the revs this phone holds; `from`: the oldest entry it shows, kept in what is sent back. */
export interface SyncOpen {service:SyncService;threadId:string;have?:Record<string,string>;from?:string}
/**
 * `order`: the entries from the window's start to the newest; `entries`: those of them the phone lacks or holds another rev
 * of. `hasMore`: older entries exist before `order[0]`. Frames after this one carry `seq + 1` and on.
 */
export interface SyncSnapshot {epoch:string;seq:number;head:Json;order:string[];entries:SyncEntry[];hasMore:boolean}
export interface SyncPage {order:string[];entries:SyncEntry[];hasMore:boolean}

/**
 * A pushed change. `entries`: new or replaced; `patches`: changed in place. Without `order`, entries the phone does not
 * have are appended in the order given. With it, the phone keeps what it holds before `order[0]` and replaces the rest.
 * `head`: changed fields only; null removes one.
 */
export interface SyncFrame {type:'live';service:SyncService;threadId:string;epoch:string;seq:number;
  entries?:SyncEntry[];patches?:SyncPatch[];order?:string[];head?:Json;at?:number;queuedMs?:number}

export const isSyncService=(value:unknown):value is SyncService=>value==='claude'||value==='antigravity';
