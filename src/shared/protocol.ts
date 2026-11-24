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
] as const;
export type ConnectorFeature = typeof CONNECTOR_FEATURES[number];

const featureName = /^[a-z][\w.-]{0,63}$/i;
/** What a relay keeps from a connector's report: a sane version and at most 64 well-formed names. */
export function connectorReport(fields: {protocol?: unknown; features?: unknown}): {protocol?: number; features?: string[]} {
  const report: {protocol?: number; features?: string[]} = {};
  if (Number.isInteger(fields.protocol) && (fields.protocol as number) > 0 && (fields.protocol as number) < 10_000) report.protocol = fields.protocol as number;
  if (Array.isArray(fields.features)) report.features = [...new Set(fields.features.filter((name): name is string => typeof name === 'string' && featureName.test(name)))].slice(0, 64);
  return report;
}
