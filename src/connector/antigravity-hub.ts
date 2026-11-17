import {execFile} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';
import {request} from 'node:http';
import {join} from 'node:path';
import {connect} from 'node:tls';
import {promisify} from 'node:util';
import {BridgeError, type Json} from '../shared/types.js';

const exec = promisify(execFile);
type Endpoint = {pid: number; httpsPort: number; csrfToken: string};
export type HubMethod = 'SendUserCascadeMessage' | 'CancelCascadeInvocation' | 'GetCascadeModelConfigData' | 'GetTrajectoryTurns';

async function desktopEndpoint(dir: string): Promise<Endpoint> {
  const records = new Map<string, Endpoint>();
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names.filter(name => /^hub_\d+\.json$/.test(name))) {
    try {
      const hub = JSON.parse(await readFile(join(dir, name), 'utf8'));
      if (!Number.isSafeInteger(hub.pid) || hub.pid < 1 || !Number.isInteger(hub.httpsPort) ||
          hub.httpsPort < 1 || hub.httpsPort > 65535 || typeof hub.csrfToken !== 'string' ||
          !/^[\x21-\x7e]{1,512}$/.test(hub.csrfToken)) continue;
      process.kill(hub.pid, 0);
      records.set(`${hub.pid}:${hub.httpsPort}`, hub);
    } catch { /* Old Hub records can outlive their process. */ }
  }
  if (records.size !== 1) throw new BridgeError('unavailable', records.size ? '有多个活动 Hub，无法确定目标桌面' : '请先在电脑上打开 Antigravity');
  return [...records.values()][0];
}

// Verify the server end of this already-established socket before attaching its CSRF token.
// Checking only the listener would allow a newly started process to inherit a stale port.
async function ownsSocket(hub: Endpoint, clientPort: number) {
  const script = `
    $ErrorActionPreference = 'Stop'
    $expected = Join-Path $env:LOCALAPPDATA 'Programs/antigravity/resources/bin/language_server.exe'
    $process = Get-Process -Id ${hub.pid}
    if ($process.Path -ne [IO.Path]::GetFullPath($expected)) { exit 1 }
    $netstat = Join-Path $env:SystemRoot 'System32/netstat.exe'
    $tuple = '^\\s*TCP\\s+127\\.0\\.0\\.1:${hub.httpsPort}\\s+127\\.0\\.0\\.1:${clientPort}\\s+\\S+\\s+${hub.pid}\\s*$'
    if (-not (& $netstat -ano -p tcp | Select-String -Quiet -Pattern $tuple)) { exit 1 }`;
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  await exec(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {timeout: 7000, windowsHide: true});
}

export async function callHub(dir: string, method: HubMethod, body: Json): Promise<Json> {
  const reading = method === 'GetCascadeModelConfigData' || method === 'GetTrajectoryTurns';
  const hub = await desktopEndpoint(dir);
  const socket = connect({host: '127.0.0.1', port: hub.httpsPort, rejectUnauthorized: false});
  let dispatched = false;
  const timer = setTimeout(() => socket.destroy(new Error('Hub timeout')), 15_000);
  // The connection may close while Windows is checking its process owner.
  socket.on('error', () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
      socket.once('close', () => reject(new Error('Hub closed')));
    });
    await ownsSocket(hub, socket.localPort!);
    if (socket.destroyed) throw new Error('Hub closed');
    const data = Buffer.from(JSON.stringify(body));
    return await new Promise<Json>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1', port: hub.httpsPort, method: 'POST', createConnection: () => socket,
        path: '/exa.language_server_pb.LanguageServerService/' + method,
        headers: {'content-type': 'application/json', 'content-length': data.length, 'x-codeium-csrf-token': hub.csrfToken},
      }, res => {
        res.on('error', reject);
        if ([401, 403, 404, 405, 415].includes(res.statusCode || 0)) {
          res.resume();
          reject(new BridgeError('incompatible', `桌面 Hub 拒绝了操作（HTTP ${res.statusCode}），请核对桌面版本和账号。`));
          return;
        }
        if (res.statusCode !== 200 || !/^application\/json\b/i.test(res.headers['content-type'] || '')) {
          res.resume();
          reject(new Error('Unexpected Hub response'));
          return;
        }
        const chunks: Buffer[] = [];
        const limit = reading ? 16 * 1024 * 1024 : 8192;
        let length = 0;
        res.on('data', (part: Buffer) => {
          length += part.length;
          if (length > limit) res.destroy(new Error('Unexpected Hub response size'));
          else chunks.push(part);
        });
        res.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!result || Array.isArray(result) || typeof result !== 'object' || result.error) throw new Error('Unexpected Hub receipt');
            resolve(result);
          } catch (error) { reject(error); }
        });
      });
      req.once('error', reject);
      dispatched = true;
      req.end(data);
    });
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    if (reading) throw new BridgeError('unavailable', '无法读取本机 Antigravity 设置，请确认桌面已打开并重试');
    throw new BridgeError(dispatched ? 'uncertain' : 'unavailable', dispatched
      ? '桌面回执未确认，请核对原会话' : '无法验证本机 Antigravity Hub，请确认桌面正在运行', dispatched);
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}
