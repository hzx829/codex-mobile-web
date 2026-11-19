import {execFileSync} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {copyFile, mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {connectorTokens, type ConnectorToken} from '../src/shared/config.js';
import {writeBundleLicenses} from './bundle-licenses.js';
import {copyWindowsRuntime} from './windows-package-runtime.js';

const {values} = parseArgs({options: {
  name: {type: 'string'}, relay: {type: 'string'}, 'relay-config': {type: 'string'}, 'token-out': {type: 'string'},
}});
const machineName = values.name?.trim();
if (!machineName || machineName.length > 100 || /[\x00-\x1f]/.test(machineName) || !values.relay)
  throw new Error('用法：npm run package:guest -- --name "借用电脑" --relay https://中继地址');
const relay = new URL(values.relay);
if (!['https:', 'http:'].includes(relay.protocol) || relay.pathname !== '/' || relay.search || relay.hash || relay.username || relay.password)
  throw new Error('请填写中继的 HTTP 或 HTTPS 地址，只包含主机和端口。');
if (process.platform !== 'win32') throw new Error('Windows 访客包请在 Windows 构建');

const machineId = `guest-${randomBytes(6).toString('hex')}`;
const binding: ConnectorToken = {machineId, token: randomBytes(32).toString('base64url')};
const target = resolve('release', machineId);
const archive = target + '.zip';
const relayConfig = values['relay-config'] ? resolve(values['relay-config']) : undefined;
const tokenOut = values['token-out'] ? resolve(values['token-out']) : relayConfig ? undefined : target + '.relay.json';
if (relayConfig && tokenOut === relayConfig) throw new Error('中继配置和 Token 输出必须是不同的文件');
const configText = relayConfig ? await readFile(relayConfig, 'utf8') : undefined;
let relaySettings;
if (configText !== undefined) {
  try {relaySettings = JSON.parse(configText.replace(/^\uFEFF/, ''));}
  catch {throw new Error('中继配置必须是有效的 JSON');}
}
const bindings = relayConfig ? connectorTokens(relaySettings?.connectorTokens) : [];
if (relayConfig && (!relaySettings || typeof relaySettings !== 'object' || Array.isArray(relaySettings)))
  throw new Error('中继配置必须是 JSON 对象');

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const writeText = (path: string, content: string) =>
  writeFile(path, '\uFEFF' + content.replace(/^\uFEFF/, '').replace(/\r?\n/g, '\r\n'), 'utf8');
await mkdir(join(target, 'build'), {recursive: true});
await mkdir(join(target, '.local'), {recursive: true});
await mkdir(join(target, 'scripts', 'windows'), {recursive: true});
await copyWindowsRuntime(target);
for (const file of ['connector.mjs', 'connector.mjs.LEGAL.txt']) await copyFile(join('build', file), join(target, 'build', file));
await copyFile('LICENSE', join(target, 'LICENSE'));
await writeBundleLicenses(target);
for (const file of ['start.ps1', 'stop.ps1', 'guest.ps1'])
  await writeText(join(target, 'scripts', 'windows', file), await readFile(join('scripts', 'windows', file), 'utf8'));

for (const [file, action] of [['启动.cmd', 'Start'], ['停止.cmd', 'Stop'], ['清除访客数据.cmd', 'Clear']]) {
  await writeFile(join(target, file), '@echo off\r\n' +
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\windows\\guest.ps1" -Action ${action}\r\n` +
    'if errorlevel 1 pause\r\n', 'ascii');
}
await writeFile(join(target, '.local', 'config.json'), json({
  mode: 'connector', guest: true, relayUrl: relay.origin, token: binding.token, machineId, machineName,
}));
await writeText(join(target, '说明.txt'), `电脑名称 ${machineName}
中继地址 ${relay.origin}

1. 安装并登录 Codex 或 Claude Code，然后双击「启动.cmd」。窗口里可查看连接状态。
2. 停止借用时双击「停止.cmd」。下次启动可以接着用。
3. 如需删除访客会话、项目和登录副本，双击「清除访客数据.cmd」后确认。

项目在 guest\\workspace，连接日志在 .local。模型请求使用这台电脑上已登录的账号和额度。
若启动窗口提示 Token 不匹配，请联系提供此压缩包的人核对中继设置。
`);

const revision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {encoding: 'utf8'}).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], {encoding: 'utf8'}).trim();
await writeFile(join(target, 'VERSION.txt'), `Codex Mobile Web guest\nSource ${revision}${dirty?' (uncommitted changes)':''}\nNode ${process.version}\nWindows ${process.arch}\n`);
// Windows Compress-Archive can omit hidden entries. BSD tar retains .local/config.json.
execFileSync('tar.exe', ['-a', '-cf', archive, '-C', dirname(target), basename(target)], {windowsHide: true, stdio: 'pipe', timeout: 180000});
const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(archive + '.sha256', `${hash}  ${basename(archive)}\n`);
if (tokenOut) await writeFile(tokenOut, json({connectorTokens: [binding]}), {flag: 'wx', mode: 0o600});
if (relayConfig) {
  const updated = json({...relaySettings, connectorTokens: [...bindings, binding]});
  if (await readFile(relayConfig, 'utf8') !== configText) throw new Error('中继配置在打包时发生变化，请手动注册此包。');
  const staged = relayConfig + '.' + machineId + '.tmp';
  try {await writeFile(staged, updated, {flag: 'wx', mode: 0o600});await rename(staged, relayConfig);}
  finally {await rm(staged, {force: true});}
}
console.log(`访客包 ${archive}\nSHA256 ${hash}`);
if (tokenOut) console.log(`中继注册配置 ${tokenOut}`);
if (relayConfig) console.log(`已追加到 ${relayConfig}，重启中继后生效。`);
