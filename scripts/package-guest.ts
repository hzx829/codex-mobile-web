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
await writeText(join(target, '说明.txt'), `借用说明

这个程序让朋友在手机上使用这台电脑上的 Codex 和 Claude Code。
用的是你在这台电脑上登录的账号和额度，也会走你平时上网用的代理。

电脑名称：${machineName}
中继地址：${relay.origin}


一、开始之前

1. 先确认这台电脑上的 Codex 或 Claude Code 能正常用：自己打开发一句话试试。两个能用一个就行。
2. 如果平时要开代理才能用，借用期间也要一直开着代理。
3. 把这个文件夹放到固定位置（例如 D:\\借用），不要在压缩包里直接运行。


二、开始借用

双击「启动.cmd」。窗口里会依次出现：

  已找到登录和设置       找到了你的登录
  电脑已连接中继         朋友的手机已经能看到这台电脑
  测试通过，可以使用     已经实际发过一条测试消息，确认能用

看到「测试通过」后可以关掉这个窗口，程序会在后台继续运行。
测试大约需要十几秒，最多一分半钟。

如果窗口里出现下面的提示：

  还没有登录                 打开对应的应用登录一次，再双击「启动.cmd」
  登录已失效                 在对应的应用里重新登录，再双击「启动.cmd」
  连不上服务 / 没有回应      检查网络；平时要开代理的话先打开代理，再双击「启动.cmd」
  Token 不匹配               请联系给你这个压缩包的人

只有一个应用测试通过也可以借用，朋友只能用通过的那个。


三、借用期间

- 请保持电脑开机、联网，不要让它进入睡眠。
- 请尽量不要自己使用 Codex 或 Claude Code，否则你们之中可能有一方需要重新登录。
- 朋友的项目和会话都放在本文件夹的 guest 目录里，不会出现在你自己的 Codex 和 Claude Code 里。
- 朋友让 Codex 或 Claude Code 执行的操作，会以你的 Windows 账号在这台电脑上运行。


四、结束借用

双击「停止.cmd」。它会断开连接，并把借用期间更新过的登录还给你的 Codex 和 Claude Code，之后你可以照常使用。
下次再借，双击「启动.cmd」就行，朋友之前的会话都还在。

- 提示「登录写回失败」：先关闭 Codex 和 Claude Code，再双击一次「停止.cmd」。
- 没停止就关机了：在你自己使用 Codex 或 Claude Code 之前，先双击一次「停止.cmd」。


五、删除借用数据

双击「清除访客数据.cmd」，输入 YES 确认。会删除朋友的项目、会话和登录副本，不影响你自己的数据。

运行日志在本文件夹的 .local 目录里。
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
