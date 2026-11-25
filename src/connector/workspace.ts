import {execFile} from 'node:child_process';
import {lstat, mkdir, readdir, realpath, rm, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename, dirname, isAbsolute, join, normalize, relative, resolve, sep, toNamespacedPath} from 'node:path';
import {promisify} from 'node:util';
import {mergeProjectPaths, projectPathKey} from '../shared/project-paths.js';
import {BridgeError, bridgeServices, textRequired, type BridgeService, type Json, type ProjectBrowseEntry, type ProjectCreateResult, type ProjectCreateServiceOutcome, type ProjectInfo, type ProjectRootInfo} from '../shared/types.js';
import type {Actor, Ledger} from './ledger.js';
import {guestWorkspace} from './project.js';

const exec = promisify(execFile);
const MAX_BROWSE_ENTRIES = 200;
const RESERVED_WIN_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$) *(?:\.|$)/i;

export function defaultProjectRoot(home = homedir()): string {
  return join(home, 'Documents', 'Projects');
}

export function validateFolderName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name.length > 80 ||
    /[\\/:*?"<>|\x00-\x1f]/.test(name) ||
    /[. ]$/.test(name) ||
    RESERVED_WIN_NAME.test(name)
  ) {
    throw new BridgeError('invalid', '请输入有效的项目文件夹名称');
  }
  return name;
}

export function isUncPath(path: string): boolean {
  return /^[/\\]{2}(?![?.][/\\])/.test(path) || /^\\\\\?\\UNC\\/i.test(path);
}

/** True when `target` is equal to or inside `base` (case-insensitive on Windows). */
export function isInsideOrEqual(target: string, base: string): boolean {
  const a = toNamespacedPath(normalize(base));
  const b = toNamespacedPath(normalize(target));
  const rel = relative(a, b);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

export function isStrictlyInside(target: string, base: string): boolean {
  const a = toNamespacedPath(normalize(base));
  const b = toNamespacedPath(normalize(target));
  const rel = relative(a, b);
  return Boolean(rel) && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel);
}

/** Resolves the canonical realpath of an existing path, or of its nearest existing ancestor + trailing segments. */
export async function canonicalizeMaybeMissing(targetPath: string): Promise<{canonical: string; exists: boolean}> {
  if (!isAbsolute(targetPath) || targetPath.includes('\0') || isUncPath(targetPath)) {
    throw new BridgeError('invalid', '请使用本机的绝对目录路径（不支持网络共享路径）');
  }
  const normalized = resolve(targetPath);
  try {
    return {canonical: await realpath(normalized), exists: true};
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  const missing: string[] = [];
  let cursor = normalized;
  while (true) {
    const entry = await lstat(cursor).catch(error => {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw error;
    });
    if (entry) {
      if (entry.isSymbolicLink()) {
        throw new BridgeError('forbidden', '目标路径包含失效的符号链接');
      }
      const realBase = await realpath(cursor);
      return {canonical: join(realBase, ...missing.reverse()), exists: false};
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new BridgeError('invalid', '找不到目标磁盘或上级目录');
    }
    missing.push(basename(cursor));
    cursor = parent;
  }
}

export interface SafetyOptions {
  home?: string;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Extra protected prefixes (used by tests or custom homes). */
  extraProtected?: string[];
}

function protectedSubtrees(opts: SafetyOptions = {}): string[] {
  const home = opts.home || homedir();
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const list: string[] = [
    env.CODEX_HOME || join(home, '.codex'),
    env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
    join(home, '.gemini'),
  ];
  if (opts.dataDir) list.push(opts.dataDir);
  if (platform === 'win32') {
    if (env.SystemRoot) list.push(env.SystemRoot);
    if (env.ProgramFiles) list.push(env.ProgramFiles);
    if (env['ProgramFiles(x86)']) list.push(env['ProgramFiles(x86)']);
    if (env.ProgramData) list.push(env.ProgramData);
    if (env.LOCALAPPDATA) {
      list.push(
        join(env.LOCALAPPDATA, 'Claude-Data'),
        join(env.LOCALAPPDATA, 'Programs', 'antigravity'),
        join(env.LOCALAPPDATA, 'OpenAI'),
      );
    }
  } else {
    list.push('/etc', '/usr', '/bin', '/sbin', '/var', '/System', '/Library');
  }
  if (opts.extraProtected) list.push(...opts.extraProtected);
  return list.filter(Boolean).map(item => resolve(item));
}

function isProtectedInternalSegment(canonical: string): boolean {
  const segments = canonical.split(/[\\/]+/).filter(Boolean).map(s => s.toLowerCase());
  if (segments.includes('.git')) return true;
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] === '.claude' && segments[i + 1] === 'worktrees') return true;
  }
  return false;
}

/**
 * Verifies a directory may be registered or configured as a project / project root.
 * Blocks filesystem roots, user home directory itself, OS system dirs, agent/connector data dirs, UNC paths, and git/worktree internals.
 */
export async function assertSafeProjectPath(targetPath: string, opts: SafetyOptions = {}): Promise<string> {
  const {canonical} = await canonicalizeMaybeMissing(targetPath);
  const home = await realpath(opts.home || homedir()).catch(() => resolve(opts.home || homedir()));

  if (dirname(canonical) === canonical) {
    throw new BridgeError('forbidden', '不能直接使用磁盘根目录作为项目目录，请选择子文件夹');
  }
  if (projectPathKey(canonical) === projectPathKey(home)) {
    throw new BridgeError('forbidden', '不能直接使用用户主目录作为项目目录，请选择具体的项目子文件夹');
  }
  if (isProtectedInternalSegment(canonical)) {
    throw new BridgeError('forbidden', '不能将 .git 或 worktree 内部目录作为项目目录');
  }
  const blocked = protectedSubtrees(opts);
  for (const prefix of blocked) {
    const resolvedPrefix = await realpath(prefix).catch(() => prefix);
    if (isInsideOrEqual(canonical, resolvedPrefix)) {
      throw new BridgeError('forbidden', '不能选择系统目录或应用配置/数据目录作为项目目录');
    }
  }
  return canonical;
}

/** Lighter check for browsing directories (admins/personal users may browse home or drive roots to reach a subfolder). */
async function assertSafeBrowsePath(targetPath: string, opts: SafetyOptions = {}): Promise<string> {
  const {canonical} = await canonicalizeMaybeMissing(targetPath);
  if (isProtectedInternalSegment(canonical)) {
    throw new BridgeError('forbidden', '无法浏览内部目录');
  }
  const blocked = protectedSubtrees(opts);
  for (const prefix of blocked) {
    const resolvedPrefix = await realpath(prefix).catch(() => prefix);
    if (isInsideOrEqual(canonical, resolvedPrefix)) {
      throw new BridgeError('forbidden', '无法浏览系统目录或应用数据目录');
    }
  }
  return canonical;
}

export interface WorkspaceOptions extends SafetyOptions {
  projectRoots?: string[];
  guestRoot?: () => string | undefined;
  runGitInit?: (cwd: string) => Promise<void>;
}

async function defaultGitInit(cwd: string): Promise<void> {
  await exec('git', ['init'], {cwd, timeout: 10_000, windowsHide: true});
}

export class WorkspaceManager {
  private readonly configuredRaw: string[];
  private readonly guestRootFn: () => string | undefined;
  private readonly runGitInit: (cwd: string) => Promise<void>;
  private readonly safety: SafetyOptions;

  constructor(options: WorkspaceOptions = {}) {
    this.configuredRaw = mergeProjectPaths((options.projectRoots || []).map(item => resolve(item)));
    this.guestRootFn = options.guestRoot ?? guestWorkspace;
    this.runGitInit = options.runGitInit ?? defaultGitInit;
    this.safety = {
      home: options.home,
      dataDir: options.dataDir,
      env: options.env,
      platform: options.platform,
      extraProtected: options.extraProtected,
    };
  }

  private get defaultRootPath(): string {
    return defaultProjectRoot(this.safety.home);
  }

  private allowOutside(actor?: Actor): boolean {
    if (this.guestRootFn()) return false;
    // Unauthenticated personal mode (no team actor) and team admins/owners may attach outside roots.
    if (!actor) return true;
    return actor.role === 'owner' || actor.role === 'admin';
  }

  private async effectiveRoots(): Promise<{roots: ProjectRootInfo[]; configured: boolean; guest: boolean}> {
    const guest = this.guestRootFn();
    if (guest) {
      const canonical = await realpath(guest).catch(() => resolve(guest));
      return {
        guest: true,
        configured: true,
        roots: [{path: canonical, label: basename(canonical) || canonical, isDefault: true, configured: true}],
      };
    }
    const valid: string[] = [];
    for (const candidate of this.configuredRaw) {
      try {
        const canonical = await assertSafeProjectPath(candidate, this.safety);
        if ((await stat(canonical)).isDirectory()) valid.push(canonical);
      } catch {
        /* Skip removed or invalid configured roots so remaining roots stay usable. */
      }
    }
    if (valid.length) {
      const unique = mergeProjectPaths(valid);
      return {
        guest: false,
        configured: true,
        roots: unique.map((path, index) => ({
          path,
          label: basename(path) || path,
          isDefault: index === 0,
          configured: true,
        })),
      };
    }
    const fallback = (await canonicalizeMaybeMissing(this.defaultRootPath)).canonical;
    return {
      guest: false,
      configured: false,
      roots: [{path: fallback, label: basename(fallback) || fallback, isDefault: true, configured: false}],
    };
  }

  async roots(actor?: Actor): Promise<{
    roots: ProjectRootInfo[];
    allowOutsideRoots: boolean;
    configured: boolean;
    guest: boolean;
    defaultRoot: string;
  }> {
    const info = await this.effectiveRoots();
    return {
      roots: info.roots,
      allowOutsideRoots: this.allowOutside(actor),
      configured: info.configured,
      guest: info.guest,
      defaultRoot: info.roots[0]?.path || this.defaultRootPath,
    };
  }

  async browse(requestedPath: unknown, actor?: Actor): Promise<{
    path: string;
    parent: string | null;
    exists: boolean;
    entries: ProjectBrowseEntry[];
    allowOutsideRoots: boolean;
    configured: boolean;
  }> {
    const info = await this.effectiveRoots();
    const allowOutside = this.allowOutside(actor);
    const raw = typeof requestedPath === 'string' && requestedPath.trim() ? requestedPath.trim() : info.roots[0].path;
    const {canonical, exists} = await canonicalizeMaybeMissing(raw);

    if (!allowOutside) {
      const matched = info.roots.some(root => isInsideOrEqual(canonical, root.path));
      if (!matched) {
        throw new BridgeError(
          'forbidden',
          info.configured
            ? '只能浏览管理员配置的团队项目根目录内的文件夹'
            : '当前电脑尚未配置团队项目根目录，只能使用默认项目目录，请联系管理员在电脑托盘中配置',
        );
      }
    } else {
      await assertSafeBrowsePath(canonical, this.safety);
    }

    const parentCandidate = dirname(canonical);
    let parent: string | null = null;
    if (parentCandidate !== canonical) {
      if (allowOutside) {
        try {
          await assertSafeBrowsePath(parentCandidate, this.safety);
          parent = parentCandidate;
        } catch {
          parent = null;
        }
      } else if (info.roots.some(root => isInsideOrEqual(parentCandidate, root.path))) {
        parent = parentCandidate;
      }
    }

    if (!exists) {
      // Unconfigured default ~/Documents/Projects may not exist until the first project is created.
      if (!info.configured && projectPathKey(canonical) === projectPathKey(info.roots[0].path)) {
        return {path: canonical, parent: null, exists: false, entries: [], allowOutsideRoots: allowOutside, configured: info.configured};
      }
      throw new BridgeError('not_found', '找不到该目录');
    }

    const dirStat = await stat(canonical).catch(() => null);
    if (!dirStat?.isDirectory()) throw new BridgeError('invalid', '请选择文件夹');

    const dirents = await readdir(canonical, {withFileTypes: true}).catch(error => {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'EACCES' || code === 'EPERM') throw new BridgeError('forbidden', '连接器没有权限浏览该目录');
      throw error;
    });

    const dirs = dirents
      .filter(entry => {
        if (!entry.isDirectory()) return false;
        if (entry.name.startsWith('.') || entry.name.startsWith('$')) return false;
        if (entry.name.toLowerCase() === 'system volume information' || entry.name === 'node_modules') return false;
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}));

    const entries: ProjectBrowseEntry[] = [];
    for (const entry of dirs) {
      if (entries.length >= MAX_BROWSE_ENTRIES) break;
      const full = join(canonical, entry.name);
      try {
        const safe = await assertSafeProjectPath(full, this.safety);
        if (!allowOutside && !info.roots.some(root => isInsideOrEqual(safe, root.path))) continue;
        const isGit = await stat(join(safe, '.git')).then(s => s.isDirectory() || s.isFile(), () => false);
        entries.push({name: entry.name, path: safe, isGit});
      } catch {
        /* Protected subdirectories (e.g. ~/.codex, Windows) are omitted from browse results. */
      }
    }

    return {path: canonical, parent, exists: true, entries, allowOutsideRoots: allowOutside, configured: info.configured};
  }

  async prepareDirectory(
    input: {mode: 'new' | 'existing'; parentPath?: unknown; folderName?: unknown; path?: unknown; initGit?: boolean},
    actor?: Actor,
  ): Promise<{path: string; created: boolean; gitInit?: boolean; gitNotice?: string}> {
    const info = await this.effectiveRoots();
    const allowOutside = this.allowOutside(actor);

    if (input.mode === 'existing') {
      const raw = typeof input.path === 'string' ? input.path.trim() : '';
      if (!raw) throw new BridgeError('invalid', '请选择电脑上的已有文件夹');
      const canonical = await assertSafeProjectPath(raw, this.safety);
      const entry = await stat(canonical).catch(() => null);
      if (!entry?.isDirectory()) throw new BridgeError('invalid', '所选路径不存在或不是文件夹');
      if (!allowOutside) {
        const insideAllowed = info.configured
          ? info.roots.some(root => isInsideOrEqual(canonical, root.path))
          : isStrictlyInside(canonical, info.roots[0].path);
        if (!insideAllowed) {
          throw new BridgeError(
            'forbidden',
            info.configured
              ? '只能关联管理员配置的团队项目根目录内的文件夹'
              : '当前电脑尚未配置团队项目根目录，成员只能使用默认项目目录内的子文件夹，请联系管理员在电脑托盘中配置',
          );
        }
      }
      return {path: canonical, created: false};
    }

    const folderName = validateFolderName(input.folderName);
    const parentRaw = typeof input.parentPath === 'string' && input.parentPath.trim()
      ? input.parentPath.trim()
      : info.roots[0].path;
    const {canonical: parentCanonical, exists: parentExists} = await canonicalizeMaybeMissing(parentRaw);

    if (!allowOutside) {
      const insideRoot = info.roots.some(root => isInsideOrEqual(parentCanonical, root.path));
      if (!insideRoot) {
        throw new BridgeError(
          'forbidden',
          info.configured
            ? '只能在管理员配置的团队项目根目录下新建文件夹'
            : '当前电脑尚未配置团队项目根目录，成员只能在默认项目目录下新建文件夹',
        );
      }
    } else {
      await assertSafeBrowsePath(parentCanonical, this.safety);
    }

    if (!parentExists) {
      if (!info.configured && projectPathKey(parentCanonical) === projectPathKey(info.roots[0].path)) {
        await assertSafeProjectPath(parentCanonical, this.safety);
        await mkdir(parentCanonical, {recursive: true});
      } else {
        throw new BridgeError('not_found', '保存位置目录不存在，请重新选择');
      }
    } else {
      const pStat = await stat(parentCanonical).catch(() => null);
      if (!pStat?.isDirectory()) throw new BridgeError('invalid', '保存位置不是有效的文件夹');
    }

    const realParent = await realpath(parentCanonical);
    if (!allowOutside && !info.roots.some(root => isInsideOrEqual(realParent, root.path))) {
      throw new BridgeError('forbidden', '保存位置超出允许的项目根目录范围');
    }

    const target = join(realParent, folderName);
    await assertSafeProjectPath(target, this.safety);

    try {
      await mkdir(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'EEXIST') {
        throw new BridgeError('exists', '同名文件夹已存在，请更换文件夹名称，或改用“已有文件夹”关联');
      }
      if (code === 'EACCES' || code === 'EPERM') {
        throw new BridgeError('forbidden', '连接器没有权限在该位置创建文件夹');
      }
      throw error;
    }

    const finalPath = await realpath(target);
    await assertSafeProjectPath(finalPath, this.safety);
    if (!allowOutside && !info.roots.some(root => isInsideOrEqual(finalPath, root.path))) {
      throw new BridgeError('forbidden', '新建目录超出允许的项目根目录范围');
    }

    if (input.initGit !== false) {
      try {
        await this.runGitInit(finalPath);
        return {path: finalPath, created: true, gitInit: true};
      } catch {
        return {path: finalPath, created: true, gitInit: false, gitNotice: '已创建目录，但电脑未自动初始化 Git 仓库'};
      }
    }
    return {path: finalPath, created: true, gitInit: false};
  }
}

export type ProjectRegistrar = (
  opId: string,
  input: {name: string; path: string; initClaudeMd?: string},
) => Promise<{project: ProjectInfo; notice?: string}>;

export type ProjectUpdater = (
  opId: string,
  input: {id?: string; projectId?: string; path?: string; name: string},
) => Promise<{project: ProjectInfo; notice?: string}>;

export type ProjectRemover = (
  input: {id?: string; projectId?: string; path?: string},
) => Promise<{removed: true; notice?: string}>;

export interface ProjectCoordinatorOptions {
  workspace: WorkspaceManager;
  ledger: Ledger;
  availableServices: readonly BridgeService[];
  registrars: Partial<Record<BridgeService, ProjectRegistrar>>;
  updaters?: Partial<Record<BridgeService, ProjectUpdater>>;
  removers?: Partial<Record<BridgeService, ProjectRemover>>;
  onChanged?: () => void;
}

/**
 * Coordinates `projects.roots`, `projects.browse`, `projects.create`, `projects.update`, and `projects.remove` across enabled services
 * with opId idempotency, safety checks, partial-failure reporting, and automatic rollback if all services fail on a freshly created folder.
 */
export function createProjectsHandler(options: ProjectCoordinatorOptions) {
  const {workspace, ledger, availableServices, registrars, updaters = {}, removers = {}, onChanged} = options;
  const availableSet = new Set<BridgeService>(availableServices);

  return async function handleProjects(
    action: 'projects.roots' | 'projects.browse' | 'projects.create' | 'projects.update' | 'projects.remove',
    p: Json,
    actor?: Actor,
  ): Promise<Json> {
    if (action === 'projects.roots') {
      const info = await workspace.roots(actor);
      return {...info, services: [...availableServices]};
    }
    if (action === 'projects.browse') {
      return workspace.browse(p.path, actor);
    }
    if (action === 'projects.update' || action === 'projects.remove') {
      const opId = textRequired(p.opId, '操作标识', 100);
      const svc = typeof p.service === 'string' && bridgeServices.includes(p.service as BridgeService)
        ? p.service as BridgeService
        : (() => { throw new BridgeError('invalid', '目标应用无效'); })();
      if (!availableSet.has(svc)) {
        throw new BridgeError('unsupported', `这台电脑暂不支持 ${svc}`);
      }
      const id = typeof p.id === 'string' && p.id.trim() ? p.id.trim().slice(0, 4096) : undefined;
      const projectId = typeof p.projectId === 'string' && p.projectId.trim() ? p.projectId.trim().slice(0, 200) : undefined;
      const path = typeof p.path === 'string' && p.path.trim() ? p.path.trim().slice(0, 4096) : undefined;
      if (!id && !projectId && !path) throw new BridgeError('invalid', '缺少项目标识');
      if (action === 'projects.update') {
        const updater = updaters[svc];
        if (!updater) throw new BridgeError('unsupported', `这台电脑暂不支持修改 ${svc} 项目`);
        const name = textRequired(p.name, '项目名称', 80);
        return ledger.run(opId, {
          action: 'projects.update',
          service: svc,
          ...(id ? {id} : {}),
          ...(projectId ? {projectId} : {}),
          ...(path ? {path} : {}),
          name,
        }, async () => {
          const result = await updater(opId, {id, projectId, path, name});
          onChanged?.();
          return {service: svc, ...result};
        });
      }
      const remover = removers[svc];
      if (!remover) throw new BridgeError('unsupported', `这台电脑暂不支持移除 ${svc} 项目`);
      return ledger.run(opId, {
        action: 'projects.remove',
        service: svc,
        ...(id ? {id} : {}),
        ...(projectId ? {projectId} : {}),
        ...(path ? {path} : {}),
      }, async () => {
        const result = await remover({id, projectId, path});
        onChanged?.();
        return {service: svc, ...result};
      });
    }
    const opId = textRequired(p.opId, '操作标识', 100);
    const mode = p.mode === 'existing' ? 'existing' : p.mode === 'new' ? 'new' : (() => {
      throw new BridgeError('invalid', '项目创建方式无效');
    })();
    const rawServices = Array.isArray(p.services) ? p.services : [...availableServices];
    const requested: BridgeService[] = [];
    for (const item of rawServices) {
      if (typeof item !== 'string' || !bridgeServices.includes(item as BridgeService)) {
        throw new BridgeError('invalid', '目标应用无效');
      }
      const svc = item as BridgeService;
      if (!availableSet.has(svc) || !registrars[svc]) {
        throw new BridgeError('unsupported', `这台电脑暂不支持为 ${svc} 注册项目`);
      }
      if (!requested.includes(svc)) requested.push(svc);
    }
    if (!requested.length) throw new BridgeError('invalid', '请至少选择一个目标应用');

    const fallbackName = mode === 'existing' && typeof p.path === 'string'
      ? p.path.trim().replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).at(-1) || ''
      : typeof p.folderName === 'string' ? p.folderName.trim() : '';
    const name = textRequired(typeof p.name === 'string' && p.name.trim() ? p.name : fallbackName, '项目名称', 80);
    const folderName = mode === 'new' ? validateFolderName(typeof p.folderName === 'string' && p.folderName.trim() ? p.folderName : name) : undefined;
    const parentPath = mode === 'new' && typeof p.parentPath === 'string' && p.parentPath.trim() ? p.parentPath.trim() : undefined;
    const existingPath = mode === 'existing' ? textRequired(p.path, '项目目录', 4096) : undefined;
    const initGit = mode === 'new' ? p.initGit !== false : false;
    const initClaudeMd = typeof p.initClaudeMd === 'string' && p.initClaudeMd.trim() ? p.initClaudeMd : undefined;

    return ledger.run(opId, {
      action: 'projects.create',
      mode,
      name,
      services: requested,
      ...(folderName ? {folderName} : {}),
      ...(parentPath ? {parentPath} : {}),
      ...(existingPath ? {path: existingPath} : {}),
      ...(mode === 'new' ? {initGit} : {}),
    }, async (): Promise<ProjectCreateResult> => {
      const prepared = await workspace.prepareDirectory({
        mode,
        parentPath,
        folderName,
        path: existingPath,
        initGit,
      }, actor);

      const results: Partial<Record<BridgeService, ProjectCreateServiceOutcome>> = {};
      let anyOk = false;
      for (const svc of requested) {
        try {
          const outcome = await registrars[svc]!(opId, {name, path: prepared.path, initClaudeMd});
          results[svc] = {ok: true, project: outcome.project, ...(outcome.notice ? {notice: outcome.notice} : {})};
          anyOk = true;
        } catch (error) {
          const err = error instanceof BridgeError ? error : new BridgeError('computer_error', (error as Error)?.message || '注册项目失败');
          results[svc] = {ok: false, error: {code: err.code, message: err.message}};
        }
      }

      if (!anyOk) {
        if (prepared.created) {
          await rm(prepared.path, {recursive: true, force: true}).catch(() => {});
        }
        const firstErr = Object.values(results).find(r => !r?.ok)?.error;
        if (requested.length === 1 && firstErr) {
          throw new BridgeError(firstErr.code, firstErr.message);
        }
        const labels: Record<BridgeService, string> = {codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity'};
        const summary = requested.map(svc => `${labels[svc]}：${results[svc]?.error?.message || '失败'}`).join('；');
        throw new BridgeError('computer_error', `未能创建项目（${summary}）`);
      }

      onChanged?.();
      return {
        path: prepared.path,
        created: prepared.created,
        ...(prepared.gitInit !== undefined ? {gitInit: prepared.gitInit} : {}),
        ...(prepared.gitNotice ? {gitNotice: prepared.gitNotice} : {}),
        results,
      };
    });
  };
}
