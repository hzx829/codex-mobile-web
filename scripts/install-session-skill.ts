import {chmod, copyFile, mkdir, stat, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const bundlePath = join(repoRoot, 'build', 'session-cli.mjs');
const skillSrc = join(repoRoot, 'skills', 'cross-app-session', 'SKILL.md');

const bundleStat = await stat(bundlePath).catch(() => null);
if (!bundleStat?.isFile()) {
  throw new Error(`未找到构建产物 ${bundlePath}，请先运行 npm run build`);
}

const home = homedir();
const binDir = join(home, '.local', 'bin');
const claudeSkillDir = join(home, '.claude', 'skills', 'antigravity');

await mkdir(binDir, {recursive: true});
await mkdir(claudeSkillDir, {recursive: true});

const posixBundle = bundlePath.replace(/\\/g, '/');

// Windows CMD / PowerShell shim
const cmdShim = `@echo off\r\nnode --disable-warning=ExperimentalWarning "${bundlePath}" %*\r\n`;
await writeFile(join(binDir, 'cmw-session.cmd'), cmdShim, 'utf8');

// POSIX / Git Bash shim (LF line endings are mandatory for bash on Windows)
const shShim = `#!/usr/bin/env sh\nexec node --disable-warning=ExperimentalWarning "${posixBundle}" "$@"\n`;
const shPath = join(binDir, 'cmw-session');
await writeFile(shPath, shShim, 'utf8');
if (process.platform !== 'win32') {
  await chmod(shPath, 0o755);
}

await copyFile(skillSrc, join(claudeSkillDir, 'SKILL.md'));

console.log(JSON.stringify({
  installed: true,
  cliCmd: join(binDir, 'cmw-session.cmd'),
  cliSh: shPath,
  bundle: bundlePath,
  claudeSkill: join(claudeSkillDir, 'SKILL.md'),
}, null, 2));
