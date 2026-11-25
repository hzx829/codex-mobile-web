/**
 * What the phone page and a computer's connector agree on. The connector reports its protocol and features
 * when it signs in to the relay; the relay passes them on with the computer, so a page newer than the
 * connector can tell before it offers something the connector cannot do.
 *
 * Rules (adapted from Paseo's docs/protocol-compatibility.md):
 * - Messages only grow. New fields are optional, and readers keep accepting fields they no longer send.
 * - Something new the phone needs from the connector gets a name in CONNECTOR_FEATURES. The phone checks it
 *   with connectorHas() (web/features.ts) and, when it is missing, asks for the connector to be updated
 *   instead of building a fallback for old connectors.
 * - PROTOCOL_VERSION changes only when an older page can no longer work with the connector at all.
 * - Code kept only for older connectors or pages is marked `COMPAT(<name>): <why>, remove after <date>`.
 *
 * Connectors from before this list report neither field; the phone treats them as missing every feature here.
 */
export const PROTOCOL_VERSION = 1;

export const CONNECTOR_FEATURES = [
  /** Pushes a running turn's changes as live frames (through a relay that forwards them). */
  'live',
  /** A Claude Code plan can be approved in a chosen permission mode (`implementModes` on the request). */
  'claude.implementModes',
  /** Antigravity dictation streams through the desktop Hub (`voice.stream.open` with `provider: 'antigravity'`). */
  'voice.antigravity',
  /** Antigravity supports grouped models, permission presets and approval cards (`antigravity.respond`). */
  'antigravity.composer',
  /** Antigravity supports queuing messages behind a running turn, steering and sending immediately. */
  'antigravity.queue',
  /** Claude Code sessions are followed with sync.open and sync.page and pushed as numbered frames (src/shared/sync.ts). */
  'sync.claude',
  /** Antigravity conversations are followed the same way, their messages as entries. */
  'sync.antigravity',
  /** Codex threads too, their newest turns at a time with older ones by page. */
  'sync.codex',
  /** Files download through the relay's data channel (blob.pull), as HTTP streams instead of base64 chunks. */
  'blob',
  /** Upload parts go through it too (blob.push), up to 8 MiB each. */
  'blob.upload',
  /** Images in synced messages are references (cmw-image:<sha256>) loaded through it; images to send are uploaded first. */
  'blob.image',
  /** Supports creating and browsing projects across enabled services (`projects.roots`, `projects.browse`, `projects.create`). */
  'projects.create',
] as const;
export type ConnectorFeature = typeof CONNECTOR_FEATURES[number];

/** The downloads the relay's data channel may ask a computer for (src/server/blob.ts, src/connector/blob.ts). */
export const BLOB_ACTIONS: ReadonlySet<string> = new Set(['file.download', 'claude.file.download', 'antigravity.file.download', 'blob.image']);
/** The upload parts it may carry; each still needs its file registered with the matching uploadStart first. */
export const BLOB_UPLOADS: ReadonlySet<string> = new Set(['file.uploadChunk', 'claude.file.uploadChunk', 'antigravity.file.uploadChunk', 'blob.image.put']);

const featureName = /^[a-z][\w.-]{0,63}$/i;
/** What a relay keeps from a connector's report: a sane version and at most 64 well-formed names. */
export function connectorReport(fields: {protocol?: unknown; features?: unknown}): {protocol?: number; features?: string[]} {
  const report: {protocol?: number; features?: string[]} = {};
  if (Number.isInteger(fields.protocol) && (fields.protocol as number) > 0 && (fields.protocol as number) < 10_000) report.protocol = fields.protocol as number;
  if (Array.isArray(fields.features)) report.features = [...new Set(fields.features.filter((name): name is string => typeof name === 'string' && featureName.test(name)))].slice(0, 64);
  return report;
}
