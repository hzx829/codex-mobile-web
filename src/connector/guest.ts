import {copyFileSync, existsSync, mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {BridgeError} from '../shared/types.js';
import {Desktop} from './desktop.js';
import type {ServiceBridge} from './services.js';

/**
 * Guest mode: running Codex and Claude Code on a friend's computer with their sign-in, while the
 * sessions on each side stay apart. See docs/guest-mode/DESIGN.md.
 */
export type GuestPaths = {root: string; codexHome: string; claudeConfig: string; workspace: string};

export function guestPaths(root: string): GuestPaths {
  const base = resolve(root);
  return {root: base, codexHome: join(base, 'codex-home'), claudeConfig: join(base, 'claude-config'), workspace: join(base, 'workspace')};
}

/** The sign-in file of each app, relative to its data directory. */
const LOGIN = {codex: 'auth.json', claude: '.credentials.json'} as const;
export type GuestApp = keyof typeof LOGIN;

/**
 * Copies the host's sign-in into the guest directories when the guest has none yet. The guest copy
 * then refreshes on its own and is never written back. Returns which apps have a sign-in.
 */
export function syncLogin(paths: GuestPaths, home = homedir(), copy = copyFileSync, exists = existsSync): Record<GuestApp, boolean> {
  const sources: Record<GuestApp, [from: string, to: string]> = {
    codex: [join(home, '.codex', LOGIN.codex), join(paths.codexHome, LOGIN.codex)],
    claude: [join(home, '.claude', LOGIN.claude), join(paths.claudeConfig, LOGIN.claude)],
  };
  const result = {} as Record<GuestApp, boolean>;
  for (const app of Object.keys(sources) as GuestApp[]) {
    const [from, to] = sources[app];
    if (!exists(to) && exists(from)) try {copy(from, to);} catch { /* Reported below as not signed in. */ }
    result[app] = exists(to);
  }
  return result;
}

/** Creates the guest directories and copies the sign-ins. */
export function prepareGuest(paths: GuestPaths, home = homedir()) {
  for (const dir of [paths.codexHome, paths.claudeConfig, paths.workspace]) mkdirSync(dir, {recursive: true});
  return syncLogin(paths, home);
}

/** Variables that would point Codex or Claude Code at the host's own data. */
const HOST_DATA_VARS = ['CODEX_SQLITE_HOME', 'CODEX_IPC_PATH', 'CODEX_PROFILE'];

/** Points Codex and Claude Code at the guest directories. Must run before any of them is constructed. */
export function applyGuestEnv(paths: GuestPaths, env: NodeJS.ProcessEnv = process.env) {
  for (const name of HOST_DATA_VARS) delete env[name];
  env.CODEX_HOME = paths.codexHome;
  env.CLAUDE_CONFIG_DIR = paths.claudeConfig;
}

/**
 * Guest sessions are recorded as `sdk-ts`, which the host's `claude --resume` list hides. The
 * separate CLAUDE_CONFIG_DIR is what keeps them apart; this is a second layer if one ever lands in
 * the host's ~/.claude.
 */
export const GUEST_ENTRYPOINT = 'sdk-ts';

/**
 * The host's Codex desktop app, never connected: its IPC pipe would show the guest the host's
 * threads and let the guest drive them. Every session runs on the connector's own app-server.
 */
export class NoDesktop extends Desktop {
  override async connect(): Promise<void> {throw new BridgeError('desktop_offline', '借用电脑不连接桌面应用');}
  override async refreshThread(_threadId: string) {}
}

/** Antigravity writes into the host's ~/.gemini and cannot be kept apart, so a guest computer refuses it. */
export const noAntigravity: ServiceBridge = {
  prefix: 'antigravity',
  handle: async () => {throw new BridgeError('unsupported', '借用电脑不提供 Antigravity');},
};
