import {spawn} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {AntigravityBridge} from '../connector/antigravity.js';
import {ClaudeCodeBridge, sdkQuery} from '../connector/claude-code.js';
import {ClaudeRuntime} from '../connector/claude-runtime.js';
import {Control} from '../connector/control.js';
import {Ledger, actorOf, requestActor} from '../connector/ledger.js';
import {
  LocalControlServer,
  SESSION_DAEMON_FILE,
  discoverAndRequest,
  globalControlDir,
  postControlRequest,
  readLocalControl,
} from '../connector/local-control.js';
import {
  AntigravitySessionDriver,
  ClaudeSessionDriver,
  CodexSessionDriver,
  SessionHub,
  type SessionDriver,
} from '../connector/session-hub.js';
import type {
  SessionSendResult,
  SessionStartResult,
  SessionWaitBaseline,
  SessionWaitResult,
  UnifiedSessionSnapshot,
  UnifiedSessionSummary,
} from '../shared/sessions.js';
import {BridgeError, type Json} from '../shared/types.js';

export interface CliIo {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  stdinText?: () => Promise<string>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  spawnDaemon?: boolean;
}

const DEFAULT_DAEMON_IDLE_MS = 10 * 60_000;

const HELP_TEXT = `cmw-session — 跨原生应用（Antigravity / Claude Code / Codex）统一双向会话控制 CLI

用法：
  cmw-session start [--to antigravity|claude|codex] [--cwd <目录>] [--prompt <文本> | --prompt-file <路径> | --stdin]
                    [--autonomy turbo|auto|default|review] [--model <模型>] [--wait] [--until turn_end|fully_idle]
                    [--timeout <秒>] [--actor <发起方名称>] [--json]
  cmw-session wait <sessionId> [--to antigravity|claude|codex] [--until turn_end|fully_idle]
                   [--timeout <秒>] [--after-send] [--after-assistant <消息ID>] [--json]
  cmw-session get <sessionId> [--to antigravity|claude|codex] [--json]
  cmw-session send <sessionId> [--to antigravity|claude|codex] [--mode queue|steer|now]
                   [--prompt <文本> | --prompt-file <路径> | --stdin] [--autonomy turbo|auto|default|review]
                   [--wait] [--timeout <秒>] [--json]
  cmw-session respond <sessionId> <requestId> <allow|allowSession|deny> [--to antigravity|claude|codex]
                      [--answer "<问题>=<答案>"] [--json]
  cmw-session stop <sessionId> [--to antigravity|claude|codex] [--kill-background] [--json]
  cmw-session list [--to antigravity|claude|codex|all] [--cwd <目录>] [--search <关键词>] [--limit <数量>] [--json]
  cmw-session daemon-stop [--json]

默认行为：
  • --to 默认为 antigravity（传 --to claude 即投递给本机 Claude Code，--to codex 投递给 Codex）
  • start 的 --cwd 默认为当前工作目录，--autonomy 默认为 turbo（最高自动权限，尽量不打断）
  • 自动识别调用方身份（Antigravity / Claude Code / Codex），优先通过运行中的连接器共享状态；
    连接器未启动或版本较旧时，Antigravity 直连本机 Hub，Claude Code / Codex 自动拉起空闲自退出的本机守护进程保持会话存活
`;

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string[]>;
  booleans: Set<string>;
}

const BOOLEAN_FLAGS = new Set([
  'help', 'h', 'json', 'wait', 'stdin', 'after-send', 'kill-background', 'daemon', 'no-daemon', 'exact-cwd',
]);

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 2) {
        const key = arg.slice(2, eq);
        const val = arg.slice(eq + 1);
        const list = flags.get(key) || [];
        list.push(val);
        flags.set(key, list);
        continue;
      }
      const key = arg.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        booleans.add(key);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new BridgeError('invalid', `参数 --${key} 缺少取值`);
      }
      const list = flags.get(key) || [];
      list.push(next);
      flags.set(key, list);
      i++;
      continue;
    }
    if (arg === '-h') {
      booleans.add('help');
      continue;
    }
    positionals.push(arg);
  }
  return {positionals, flags, booleans};
}

function flagLast(parsed: ParsedArgs, name: string): string | undefined {
  const values = parsed.flags.get(name);
  return values?.length ? values[values.length - 1] : undefined;
}

/** Detects which native agent app invoked `cmw-session` from standard environment markers. */
export function detectDefaultActorName(env: NodeJS.ProcessEnv, targetService?: string): string {
  if (env.CMW_ACTOR_NAME?.trim()) return env.CMW_ACTOR_NAME.trim();
  if (env.ANTIGRAVITY_CONVERSATION_ID || env.ANTIGRAVITY_LS_ADDRESS) return 'Antigravity';
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_CODE_SESSION_ID) return 'Claude Code';
  if (env.CODEX_THREAD_ID || env.CODEX_SANDBOX || env.CODEX_CI) return 'Codex';
  return targetService === 'claude' ? 'Antigravity' : 'Claude Code';
}

async function defaultReadStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function resolvePrompt(
  parsed: ParsedArgs,
  trailingPositionals: string[],
  readStdin: () => Promise<string>,
): Promise<string> {
  const inline = flagLast(parsed, 'prompt');
  if (inline !== undefined) return inline;
  const promptFile = flagLast(parsed, 'prompt-file');
  if (promptFile !== undefined) {
    return await readFile(resolve(promptFile), 'utf8');
  }
  if (parsed.booleans.has('stdin')) {
    return await readStdin();
  }
  if (trailingPositionals.length > 0) {
    return trailingPositionals.join(' ');
  }
  const piped = await readStdin();
  if (piped.trim()) return piped;
  throw new BridgeError('invalid', '请通过 --prompt、--prompt-file 或标准输入提供任务内容');
}

function parseAnswers(rawList: string[] | undefined): Record<string, string> | undefined {
  if (!rawList?.length) return undefined;
  const out: Record<string, string> = {};
  for (const entry of rawList) {
    const idx = entry.indexOf('=');
    if (idx <= 0) throw new BridgeError('invalid', `--answer 格式应为 "<问题>=<答案>"，收到：${entry}`);
    out[entry.slice(0, idx).trim()] = entry.slice(idx + 1).trim();
  }
  return out;
}

function needsPersistentRuntime(action: string, payload: Json): boolean {
  const svc = payload.service || 'antigravity';
  if (svc !== 'claude' && svc !== 'codex') return false;
  return action === 'agent.session.start'
    || action === 'agent.session.send'
    || action === 'agent.session.wait'
    || action === 'agent.session.respond'
    || action === 'agent.session.stop';
}

/**
 * Starts a lightweight loopback `LocalControlServer` (`~/.codex-mobile-web/session-daemon.json`) that keeps
 * `ClaudeRuntime` / `Control` child processes alive across separate CLI invocations (`start` -> `wait` -> `send`)
 * when no full `codex-mobile-web` connector with `agent.session.*` is running. Exits automatically once idle.
 */
export async function startInProcessSessionDaemon(options: {
  homeDir: string;
  env?: NodeJS.ProcessEnv;
  idleTimeoutMs?: number;
  queryLoader?: () => Promise<any>;
}): Promise<{close: () => void; port: number}> {
  const env = options.env || process.env;
  const controlDir = globalControlDir(options.homeDir);
  mkdirSync(controlDir, {recursive: true});
  const ledger = new Ledger(join(controlDir, 'cli-operations.sqlite'));
  const safety = {home: options.homeDir, dataDir: controlDir, env};

  const agRoot = env.CMW_ANTIGRAVITY_HOME || join(options.homeDir, '.gemini', 'antigravity');
  const agBridge = new AntigravityBridge(agRoot, ledger);

  const claudeRuntime = new ClaudeRuntime(options.queryLoader ?? sdkQuery, undefined, undefined, undefined, 'bypassPermissions');
  const claudeBridge = new ClaudeCodeBridge(
    ledger,
    env.CLAUDE_CONFIG_DIR || join(options.homeDir, '.claude'),
    undefined,
    undefined,
    claudeRuntime,
  );

  let codexControl: Control | undefined;
  let codexStarting: Promise<Control> | undefined;
  const ensureCodex = async (): Promise<Control> => {
    if (codexControl) return codexControl;
    if (!codexStarting) {
      codexStarting = (async () => {
        const ctrl = new Control(ledger);
        await ctrl.start().catch(() => {});
        codexControl = ctrl;
        hub.register(new CodexSessionDriver(ctrl, safety));
        return ctrl;
      })();
    }
    return codexStarting;
  };

  const hub = new SessionHub([
    new AntigravitySessionDriver(agBridge, safety),
    new ClaudeSessionDriver(claudeBridge, safety),
  ]);

  let inFlight = 0;
  let lastActivityAt = Date.now();
  let closed = false;

  const shutdown = () => {
    if (closed) return;
    closed = true;
    clearInterval(idleTimer);
    server.close();
    try {agBridge.close();} catch {}
    try {claudeBridge.close();} catch {}
    try {codexControl?.close();} catch {}
    try {ledger.close();} catch {}
  };

  const server = new LocalControlServer({
    dataDir: controlDir,
    fileName: SESSION_DAEMON_FILE,
    getStatus: async () => ({
      relay: 'unreachable',
      connector: 'offline',
      teamMode: false,
      ownToken: false,
      machineId: 'session-daemon',
      machineName: 'SessionDaemon',
      services: ['antigravity', 'claude', 'codex'],
      activeTasks: [
        ...claudeBridge.activeTasks(),
        ...agBridge.activeTasks(),
        ...(codexControl?.activeTasks() || []),
      ],
      pendingUsage: 0,
    }),
    handleRequest: async (action, payload, actor) => {
      if (action === 'daemon.shutdown') {
        setImmediate(shutdown);
        return {stopped: true};
      }
      inFlight++;
      lastActivityAt = Date.now();
      try {
        if (payload?.service === 'codex' || payload?.service === 'all') {
          await ensureCodex();
        }
        return await requestActor.run(actorOf(actor), () => hub.handle(action, payload));
      } finally {
        inFlight--;
        lastActivityAt = Date.now();
      }
    },
  });

  const record = await server.start();
  const idleLimit = options.idleTimeoutMs ?? DEFAULT_DAEMON_IDLE_MS;
  const checkInterval = Math.min(30_000, Math.max(250, Math.floor(idleLimit / 4)));
  const idleTimer = setInterval(() => {
    if (closed || inFlight > 0) return;
    if (claudeBridge.busy || claudeRuntime.hasBackground || agBridge.busy || (codexControl?.activeTasks().length || 0) > 0) {
      lastActivityAt = Date.now();
      return;
    }
    if (Date.now() - lastActivityAt >= idleLimit) {
      shutdown();
    }
  }, checkInterval);
  idleTimer.unref?.();

  return {close: shutdown, port: record.port};
}

async function ensureSpawnedDaemon(homeDir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const controlDir = globalControlDir(homeDir);
  const existing = await readLocalControl(controlDir, SESSION_DAEMON_FILE);
  if (existing) {
    const probe = await postControlRequest(existing, 'agent.session.list', {service: 'antigravity', limit: 1}, {timeoutMs: 1500}).catch(() => null);
    if (probe !== null) return;
  }
  const scriptPath = fileURLToPath(import.meta.url);
  const daemonArgs = [...process.execArgv, '--disable-warning=ExperimentalWarning', scriptPath, '--daemon', '--home-dir', homeDir];
  let spawnedViaWmi = false;
  if (process.platform === 'win32') {
    try {
      const cmdLine = [process.execPath, ...daemonArgs]
        .map(part => `"${String(part).replace(/"/g, '\\"')}"`)
        .join(' ');
      const psScript = `
        $ErrorActionPreference = 'Stop'
        $envBlock = [string[]]@(Get-ChildItem env: | Where-Object { $_.Name -and $_.Name -notlike '=*' -and $null -ne $_.Value } | ForEach-Object { "$($_.Name)=$($_.Value)" })
        $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; EnvironmentVariables = $envBlock }
        $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:CMW_DAEMON_CMD; CurrentDirectory = $env:CMW_DAEMON_CWD; ProcessStartupInformation = $startup }
        if (-not $r -or $r.ReturnValue -ne 0) { exit 1 }
      `;
      const psExe = join(process.env.SystemRoot || 'C:\\Windows', 'System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        const helper = spawn(psExe, ['-NoProfile', '-NonInteractive', '-Command', psScript], {
          windowsHide: true,
          stdio: 'ignore',
          env: {...env, CMW_DAEMON_CMD: cmdLine, CMW_DAEMON_CWD: homeDir},
        });
        helper.on('error', rejectSpawn);
        helper.on('exit', code => (code === 0 ? resolveSpawn() : rejectSpawn(new Error(`WMI exit ${code}`))));
      });
      spawnedViaWmi = true;
    } catch {
      spawnedViaWmi = false;
    }
  }
  if (!spawnedViaWmi) {
    const child = spawn(process.execPath, daemonArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {...env},
    });
    child.unref();
  }

  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    await delay(80);
    const rec = await readLocalControl(controlDir, SESSION_DAEMON_FILE);
    if (!rec) continue;
    try {
      const res = await fetch(`http://127.0.0.1:${rec.port}/status`, {
        headers: {Authorization: `Bearer ${rec.secret}`},
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return;
    } catch {}
  }
  throw new BridgeError('unavailable', '未能启动本机会话守护进程，请检查 Node 环境后重试');
}

async function executeFallbackAction(
  action: string,
  payload: Json,
  opts: {homeDir: string; env: NodeJS.ProcessEnv; actor: Json},
): Promise<Json> {
  const controlDir = globalControlDir(opts.homeDir);
  mkdirSync(controlDir, {recursive: true});
  const ledger = new Ledger(join(controlDir, 'cli-operations.sqlite'));
  const targetService = payload.service || 'antigravity';
  const safety = {home: opts.homeDir, dataDir: controlDir, env: opts.env};
  const closers: (() => void)[] = [];
  try {
    const drivers: SessionDriver[] = [];
    const needAgForCaller = Boolean(opts.env.ANTIGRAVITY_PROJECT_ID || payload.callerProjectId);
    if (targetService === 'antigravity' || targetService === 'all' || needAgForCaller) {
      const agRoot = opts.env.CMW_ANTIGRAVITY_HOME || join(opts.homeDir, '.gemini', 'antigravity');
      const ag = new AntigravityBridge(agRoot, ledger);
      closers.push(() => ag.close());
      drivers.push(new AntigravitySessionDriver(ag, safety));
    }
    if (targetService === 'claude' || targetService === 'all') {
      const runtime = new ClaudeRuntime(sdkQuery, undefined, undefined, undefined, 'bypassPermissions');
      const claude = new ClaudeCodeBridge(ledger, opts.env.CLAUDE_CONFIG_DIR || join(opts.homeDir, '.claude'), undefined, undefined, runtime);
      closers.push(() => claude.close());
      drivers.push(new ClaudeSessionDriver(claude, safety));
    }
    if (targetService === 'codex' || targetService === 'all') {
      const control = new Control(ledger);
      closers.push(() => control.close());
      await control.start().catch(() => {});
      drivers.push(new CodexSessionDriver(control, safety));
    }
    const hub = new SessionHub(drivers);
    return await requestActor.run(actorOf(opts.actor), () => hub.handle(action, payload));
  } finally {
    for (const close of closers) {
      try {close();} catch {}
    }
    try {ledger.close();} catch {}
  }
}

export async function dispatchSessionAction(
  action: string,
  payload: Json,
  opts: {
    dataDir?: string;
    homeDir: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    actor: Json;
    spawnDaemon?: boolean;
  },
): Promise<Json> {
  // 1. Prefer the full running `codex-mobile-web` Connector when reachable and up-to-date.
  try {
    const viaConnector = await discoverAndRequest(action, payload, {
      dataDir: opts.dataDir,
      homeDir: opts.homeDir,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      actor: opts.actor,
    });
    if (viaConnector !== null) return viaConnector;
  } catch (error) {
    if (!(error instanceof BridgeError) || error.code !== 'unsupported') {
      throw error;
    }
  }

  // 2. Check if a standalone `session-daemon` is already active for this user.
  const controlDir = globalControlDir(opts.homeDir);
  const existingDaemon = await readLocalControl(controlDir, SESSION_DAEMON_FILE);
  if (existingDaemon) {
    const viaDaemon = await postControlRequest(existingDaemon, action, payload, {
      timeoutMs: opts.timeoutMs,
      actor: opts.actor,
    });
    if (viaDaemon !== null) return viaDaemon;
  }

  // 3. If targeting Claude Code or Codex (whose SDK/app-server processes must outlive `start`), auto-spawn `session-daemon`.
  if (opts.spawnDaemon !== false && needsPersistentRuntime(action, payload)) {
    await ensureSpawnedDaemon(opts.homeDir, opts.env);
    const spawnedRecord = await readLocalControl(controlDir, SESSION_DAEMON_FILE);
    if (spawnedRecord) {
      const viaSpawned = await postControlRequest(spawnedRecord, action, payload, {
        timeoutMs: opts.timeoutMs,
        actor: opts.actor,
      });
      if (viaSpawned !== null) return viaSpawned;
    }
  }

  // 4. Direct in-process execution (used for Antigravity Hub RPCs and read-only `list`/`get` calls).
  return executeFallbackAction(action, payload, opts);
}

function formatRequestsBlock(session: UnifiedSessionSnapshot): string[] {
  if (!session.requests.length) return [];
  const lines: string[] = ['', '--- PENDING REQUESTS ---'];
  for (const req of session.requests) {
    lines.push(`- request_id: ${req.id} | kind: ${req.kind} | tool: ${req.tool} | title: ${req.title}`);
    if (req.detail) lines.push(`  detail: ${req.detail.replace(/\r?\n/g, ' ')}`);
    for (const q of req.questions || []) {
      lines.push(`  question: ${q.question}`);
      if (q.options?.length) {
        lines.push(`  options: ${q.options.map(o => o.label).join(' | ')}`);
      }
    }
    lines.push(`  respond_cmd: cmw-session respond ${session.sessionId} ${req.id} allow --to ${session.service}`);
  }
  return lines;
}

function formatBackgroundBlock(session: UnifiedSessionSnapshot): string[] {
  if (!session.backgroundTasks.length) return [];
  const lines: string[] = ['', '--- BACKGROUND TASKS ---'];
  for (const task of session.backgroundTasks) {
    lines.push(`- task_id: ${task.id} | title: ${task.title}${task.command ? ` | cmd: ${task.command}` : ''}`);
  }
  return lines;
}

function formatSnapshot(header: string, session: UnifiedSessionSnapshot, extraLines: string[] = []): string {
  const lines: string[] = [
    header,
    `service: ${session.service}`,
    `session_id: ${session.sessionId}`,
    `title: ${session.title}`,
    `cwd: ${session.cwd}`,
    `phase: ${session.phase}`,
    ...(session.autonomy ? [`autonomy: ${session.autonomy}`] : []),
    ...extraLines,
  ];
  if (session.error) {
    lines.push('', '--- ERROR ---', session.error);
  }
  lines.push(...formatRequestsBlock(session));
  lines.push(...formatBackgroundBlock(session));
  if (session.lastAssistantReply) {
    lines.push('', '--- ASSISTANT REPLY ---', session.lastAssistantReply);
  }
  return lines.join('\n');
}

function waitFlagsForBaseline(baseline: SessionWaitBaseline): string {
  return baseline.lastAssistantId
    ? `--after-assistant ${baseline.lastAssistantId}`
    : '--after-send';
}

export async function runSessionCli(argv: string[], io: CliIo = {}): Promise<number> {
  const out = io.stdout ?? ((text: string) => process.stdout.write(text + '\n'));
  const err = io.stderr ?? ((text: string) => process.stderr.write(text + '\n'));
  const env = io.env ?? process.env;
  const readStdin = io.stdinText ?? defaultReadStdin;

  let jsonMode = false;
  try {
    const parsed = parseArgs(argv);
    jsonMode = parsed.booleans.has('json');
    const homeDir = flagLast(parsed, 'home-dir') || io.homeDir || homedir();
    const baseCwd = io.cwd ?? process.cwd();

    if (parsed.booleans.has('daemon')) {
      const idleSec = Number(flagLast(parsed, 'idle-sec') || 600);
      await startInProcessSessionDaemon({
        homeDir,
        env,
        idleTimeoutMs: Math.max(1000, Math.floor(idleSec * 1000)),
      });
      return 0;
    }

    const cmd = parsed.positionals[0];
    if (!cmd || cmd === 'help' || parsed.booleans.has('help')) {
      out(HELP_TEXT.trimEnd());
      return 0;
    }

    if (cmd === 'daemon-stop') {
      const rec = await readLocalControl(globalControlDir(homeDir), SESSION_DAEMON_FILE);
      if (rec) {
        await postControlRequest(rec, 'daemon.shutdown', {}, {timeoutMs: 3000}).catch(() => null);
      }
      out(jsonMode ? JSON.stringify({stopped: Boolean(rec)}) : `[DAEMON STOPPED: ${Boolean(rec)}]`);
      return 0;
    }

    const service = flagLast(parsed, 'to') || flagLast(parsed, 'service') || 'antigravity';
    const dataDir = flagLast(parsed, 'data-dir');
    const exactCwd = parsed.booleans.has('exact-cwd');
    const callerProjectId = !exactCwd && env.ANTIGRAVITY_PROJECT_ID?.trim() ? env.ANTIGRAVITY_PROJECT_ID.trim() : undefined;
    const actorName = flagLast(parsed, 'actor') || detectDefaultActorName(env, service);
    const actorId = `agent:${actorName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'caller'}`;
    const actor = {userId: actorId, name: actorName};
    const timeoutSec = Number(flagLast(parsed, 'timeout') || (cmd === 'wait' || parsed.booleans.has('wait') ? 1800 : 45));
    const timeoutMs = Math.max(1000, Math.floor((Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : 60) * 1000));
    const spawnDaemon = io.spawnDaemon !== false && !parsed.booleans.has('no-daemon');

    const call = (action: string, payload: Json) =>
      dispatchSessionAction(action, payload, {
        dataDir,
        homeDir,
        env,
        timeoutMs: timeoutMs + 5_000,
        actor,
        spawnDaemon,
      });

    if (cmd === 'list') {
      const cwd = flagLast(parsed, 'cwd');
      const search = flagLast(parsed, 'search');
      const limit = flagLast(parsed, 'limit') ? Number(flagLast(parsed, 'limit')) : 20;
      const res = await call('agent.session.list', {
        service,
        ...(cwd ? {cwd: resolve(baseCwd, cwd)} : {}),
        ...(exactCwd ? {exactCwd: true} : {}),
        ...(callerProjectId ? {callerProjectId} : {}),
        ...(search ? {search} : {}),
        limit,
      });
      if (jsonMode) {
        out(JSON.stringify(res, null, 2));
        return 0;
      }
      const sessions: UnifiedSessionSummary[] = Array.isArray(res.sessions) ? res.sessions : [];
      if (!sessions.length) {
        out(`[SESSIONS: 0] (service=${service})`);
        return 0;
      }
      const lines = [`[SESSIONS: ${sessions.length}]`];
      for (const s of sessions) {
        const stateTag = s.running ? 'running' : s.background ? 'background' : 'idle';
        const time = s.updatedAt ? new Date(s.updatedAt).toISOString() : '-';
        lines.push(`- [${s.service}] ${s.sessionId} | ${stateTag} | ${s.title} | ${time}${s.cwd ? ` | ${s.cwd}` : ''}`);
      }
      out(lines.join('\n'));
      return 0;
    }

    if (cmd === 'start') {
      const rawCwd = flagLast(parsed, 'cwd');
      const cwd = rawCwd ? resolve(baseCwd, rawCwd) : baseCwd;
      const prompt = await resolvePrompt(parsed, parsed.positionals.slice(1), readStdin);
      const autonomy = flagLast(parsed, 'autonomy') || 'turbo';
      const model = flagLast(parsed, 'model');
      const effort = flagLast(parsed, 'effort');
      const wait = parsed.booleans.has('wait');
      const until = flagLast(parsed, 'until');
      const res = await call('agent.session.start', {
        service,
        cwd,
        ...(exactCwd ? {exactCwd: true} : {}),
        ...(callerProjectId ? {callerProjectId} : {}),
        prompt,
        autonomy,
        ...(model ? {model} : {}),
        ...(effort ? {effort} : {}),
        ...(wait ? {wait: true, timeoutMs, ...(until ? {until} : {})} : {}),
      }) as unknown as SessionStartResult;

      if (jsonMode) {
        out(JSON.stringify(res, null, 2));
        return 0;
      }
      if (res.waitResult) {
        out(formatSnapshot(
          `[SESSION START+WAIT: ${res.waitResult.stopReason.toUpperCase()}]`,
          res.waitResult.session,
          [
            ...(res.alignedFrom ? [`aligned_from: ${res.alignedFrom}`] : []),
            `elapsed_sec: ${(res.waitResult.elapsedMs / 1000).toFixed(1)}`,
          ],
        ));
        return 0;
      }
      const nextWait = `cmw-session wait ${res.sessionId} --to ${res.service} ${waitFlagsForBaseline(res.baseline)}`;
      out(formatSnapshot('[SESSION STARTED]', res.session, [
        ...(res.alignedFrom ? [`aligned_from: ${res.alignedFrom}`] : []),
        ...(res.projectCreated ? ['project_registered: true'] : []),
        `next_wait_cmd: ${nextWait}`,
      ]));
      return 0;
    }

    if (cmd === 'get') {
      const sessionId = parsed.positionals[1] || flagLast(parsed, 'id');
      if (!sessionId) throw new BridgeError('invalid', '缺少 <sessionId>');
      const snap = await call('agent.session.get', {service, sessionId}) as unknown as UnifiedSessionSnapshot;
      if (jsonMode) {
        out(JSON.stringify(snap, null, 2));
        return 0;
      }
      out(formatSnapshot('[SESSION STATUS]', snap));
      return 0;
    }

    if (cmd === 'wait') {
      const sessionId = parsed.positionals[1] || flagLast(parsed, 'id');
      if (!sessionId) throw new BridgeError('invalid', '缺少 <sessionId>');
      const until = flagLast(parsed, 'until');
      const afterAssistant = flagLast(parsed, 'after-assistant');
      const afterSend = parsed.booleans.has('after-send') || Boolean(afterAssistant);
      const baseline: SessionWaitBaseline | undefined = afterSend
        ? {userCount: 1, ...(afterAssistant ? {lastAssistantId: afterAssistant} : {}), startedAt: Date.now()}
        : undefined;
      const res = await call('agent.session.wait', {
        service,
        sessionId,
        timeoutMs,
        ...(until ? {until} : {}),
        ...(baseline ? {baseline} : {}),
      }) as unknown as SessionWaitResult;
      if (jsonMode) {
        out(JSON.stringify(res, null, 2));
        return 0;
      }
      out(formatSnapshot(
        `[SESSION WAIT: ${res.stopReason.toUpperCase()}]`,
        res.session,
        [`elapsed_sec: ${(res.elapsedMs / 1000).toFixed(1)}`],
      ));
      return 0;
    }

    if (cmd === 'send') {
      const sessionId = parsed.positionals[1] || flagLast(parsed, 'id');
      if (!sessionId) throw new BridgeError('invalid', '缺少 <sessionId>');
      const prompt = await resolvePrompt(parsed, parsed.positionals.slice(2), readStdin);
      const mode = flagLast(parsed, 'mode') || 'queue';
      const autonomy = flagLast(parsed, 'autonomy');
      const model = flagLast(parsed, 'model');
      const effort = flagLast(parsed, 'effort');
      const wait = parsed.booleans.has('wait');
      const until = flagLast(parsed, 'until');
      const res = await call('agent.session.send', {
        service,
        sessionId,
        prompt,
        mode,
        ...(autonomy ? {autonomy} : {}),
        ...(model ? {model} : {}),
        ...(effort ? {effort} : {}),
        ...(wait ? {wait: true, timeoutMs, ...(until ? {until} : {})} : {}),
      }) as unknown as SessionSendResult;
      if (jsonMode) {
        out(JSON.stringify(res, null, 2));
        return 0;
      }
      if (res.waitResult) {
        out(formatSnapshot(
          `[SESSION SEND+WAIT: ${res.waitResult.stopReason.toUpperCase()}]`,
          res.waitResult.session,
          [`delivery: ${res.kind}`, `elapsed_sec: ${(res.waitResult.elapsedMs / 1000).toFixed(1)}`],
        ));
        return 0;
      }
      const nextWait = `cmw-session wait ${res.sessionId} --to ${res.service} ${waitFlagsForBaseline(res.baseline)}`;
      out(formatSnapshot('[SESSION MESSAGE SENT]', res.session, [
        `delivery: ${res.kind}`,
        `next_wait_cmd: ${nextWait}`,
      ]));
      return 0;
    }

    if (cmd === 'respond') {
      const sessionId = parsed.positionals[1];
      const requestId = parsed.positionals[2];
      const decision = parsed.positionals[3];
      if (!sessionId || !requestId || !decision) {
        throw new BridgeError('invalid', '用法：cmw-session respond <sessionId> <requestId> <allow|allowSession|deny> [--answer "问题=答案"]');
      }
      const answers = parseAnswers(parsed.flags.get('answer'));
      const res = await call('agent.session.respond', {
        service,
        sessionId,
        requestId,
        decision,
        ...(answers ? {answers} : {}),
      });
      if (jsonMode) {
        out(JSON.stringify(res, null, 2));
        return 0;
      }
      const snap = res.session as UnifiedSessionSnapshot;
      const nextWait = `cmw-session wait ${sessionId} --to ${service} ${waitFlagsForBaseline(res.baseline as SessionWaitBaseline)}`;
      out(formatSnapshot('[SESSION RESPONDED]', snap, [`next_wait_cmd: ${nextWait}`]));
      return 0;
    }

    if (cmd === 'stop') {
      const sessionId = parsed.positionals[1] || flagLast(parsed, 'id');
      if (!sessionId) throw new BridgeError('invalid', '缺少 <sessionId>');
      const killBackgroundTasks = parsed.booleans.has('kill-background');
      const res = await call('agent.session.stop', {
        service,
        sessionId,
        ...(killBackgroundTasks ? {killBackgroundTasks: true} : {}),
      });
      if (jsonMode) {
        out(JSON.stringify(res, null, 2));
        return 0;
      }
      out(formatSnapshot('[SESSION STOP REQUESTED]', res.session as UnifiedSessionSnapshot));
      return 0;
    }

    throw new BridgeError('invalid', `未知子命令：${cmd}（运行 cmw-session --help 查看说明）`);
  } catch (error) {
    const code = error instanceof BridgeError ? error.code : 'cli_error';
    const message = (error as Error)?.message || '执行失败';
    if (jsonMode) {
      err(JSON.stringify({error: {code, message}}, null, 2));
    } else {
      err(`[ERROR:${code}] ${message}`);
    }
    return 1;
  }
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMain) {
  runSessionCli(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
