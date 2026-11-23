import {execFile} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';
import {request} from 'node:http';
import {join} from 'node:path';
import {connect} from 'node:tls';
import {promisify} from 'node:util';
import {BridgeError, type Json} from '../shared/types.js';

const exec = promisify(execFile);
type Endpoint = {pid: number; httpsPort: number; csrfToken: string};
export type HubMethod =
  | 'StartCascade' | 'SendUserCascadeMessage' | 'CancelCascadeInvocation' | 'DeleteCascadeTrajectory'
  | 'GetCascadeModelConfigData' | 'GetTrajectoryTurns'
  | 'GetPermissionSettings' | 'UpdateConversationAnnotations'
  | 'GetAllCascadeTrajectories' | 'GetCascadeTrajectorySteps' | 'HandleCascadeUserInteraction'
  | 'SendAudioChunk' | 'EndAudioSession';
export type HubStreamMethod = 'StreamAudioTranscription';

const READ_METHODS = new Set<HubMethod>([
  'GetCascadeModelConfigData', 'GetTrajectoryTurns',
  'GetPermissionSettings', 'GetAllCascadeTrajectories', 'GetCascadeTrajectorySteps',
]);

async function filterAntigravityPids(pids: number[]): Promise<Set<number>> {
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'
    $expected = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs/antigravity/resources/bin/language_server.exe'))
    foreach ($id in @(${pids.join(',')})) {
      $p = Get-Process -Id $id
      if ($p -and $p.Path -eq $expected) { Write-Output $id }
    }`;
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const {stdout} = await exec(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {timeout: 7000, windowsHide: true});
  return new Set(stdout.split(/\r?\n/).map(line => Number(line.trim())).filter(n => Number.isSafeInteger(n) && n > 0));
}

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
  let live = [...records.values()];
  // Windows reuses PIDs quickly; an old hub_*.json whose PID now belongs to another program is not a second Hub.
  if (live.length > 1) {
    try {
      const valid = await filterAntigravityPids([...new Set(live.map(hub => hub.pid))]);
      live = live.filter(hub => valid.has(hub.pid));
    } catch { /* Fall through to the ambiguity check below if process filtering fails. */ }
  }
  if (live.length !== 1) throw new BridgeError('unavailable', live.length ? '有多个活动 Hub，无法确定目标桌面' : '请先在电脑上打开 Antigravity');
  return live[0];
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
  const reading = READ_METHODS.has(method);
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
        const limit = method === 'GetCascadeTrajectorySteps' ? 64 * 1024 * 1024 : reading ? 16 * 1024 * 1024 : 8192;
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

export interface HubStreamHandlers {
  onMessage: (message: Json) => void;
  onError: (error: BridgeError) => void;
  onEnd: () => void;
}
export interface HubStreamHandle {
  close: () => void;
}

/** Encodes one Connect-RPC envelope frame (1-byte flags + 4-byte big-endian length + JSON). */
export function connectFrame(body: Json): Buffer {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

/** Opens a verified Connect-RPC server-streaming call to the local Antigravity Hub. */
export async function openHubStream(dir: string, method: HubStreamMethod, body: Json, handlers: HubStreamHandlers): Promise<HubStreamHandle> {
  const hub = await desktopEndpoint(dir);
  const socket = connect({host: '127.0.0.1', port: hub.httpsPort, rejectUnauthorized: false});
  let closed = false, finished = false;
  const finish = (error?: BridgeError) => {
    if (finished) return;
    finished = true;
    socket.destroy();
    if (error) handlers.onError(error);
    handlers.onEnd();
  };
  socket.on('error', () => {
    if (!closed) finish(new BridgeError('voice_failed', '与本机 Antigravity 语音服务的连接已断开，请重试'));
  });
  const connectTimer = setTimeout(() => socket.destroy(new Error('Hub timeout')), 15_000);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
      socket.once('close', () => reject(new Error('Hub closed')));
    });
    await ownsSocket(hub, socket.localPort!);
    if (socket.destroyed) throw new Error('Hub closed');
  } catch (error) {
    clearTimeout(connectTimer);
    socket.destroy();
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('unavailable', '无法验证本机 Antigravity Hub，请确认桌面正在运行');
  }
  clearTimeout(connectTimer);
  const framed = connectFrame(body);
  const req = request({
    host: '127.0.0.1', port: hub.httpsPort, method: 'POST', createConnection: () => socket,
    path: '/exa.language_server_pb.LanguageServerService/' + method,
    headers: {
      'content-type': 'application/connect+json',
      'connect-protocol-version': '1',
      'content-length': framed.length,
      'x-codeium-csrf-token': hub.csrfToken,
    },
  }, res => {
    if ([401, 403, 404, 405, 415, 501].includes(res.statusCode || 0)) {
      res.resume();
      finish(new BridgeError('incompatible', '本机 Antigravity 版本暂不支持语音识别，请更新 Antigravity 或切换识别方式'));
      return;
    }
    if (res.statusCode !== 200 || !/^application\/connect\+json\b/i.test(res.headers['content-type'] || '')) {
      res.resume();
      finish(new BridgeError('voice_failed', 'Antigravity 语音服务返回异常响应，请重试或切换识别方式'));
      return;
    }
    let buffer: Buffer = Buffer.alloc(0);
    res.on('data', (chunk: Buffer) => {
      if (closed || finished) return;
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5) {
        const flags = buffer[0];
        const length = buffer.readUInt32BE(1);
        if (length > 2 * 1024 * 1024) {
          finish(new BridgeError('voice_failed', 'Antigravity 语音数据超出限制'));
          return;
        }
        if (buffer.length < 5 + length) break;
        const payload = buffer.subarray(5, 5 + length).toString('utf8');
        buffer = buffer.subarray(5 + length);
        let parsed: Json;
        try { parsed = JSON.parse(payload); } catch { continue; }
        // Connect end-of-stream envelope (flag bit 1 = 0x02).
        if ((flags & 2) !== 0) {
          if (parsed?.error) {
            finish(new BridgeError('voice_failed', 'Antigravity 语音识别失败，请重试或切换识别方式'));
          } else {
            finish();
          }
          return;
        }
        if (parsed && typeof parsed === 'object') handlers.onMessage(parsed);
      }
    });
    res.on('end', () => finish());
    res.on('error', () => {
      if (!closed) finish(new BridgeError('voice_failed', 'Antigravity 语音流中断，请重试'));
    });
  });
  req.once('error', () => {
    if (!closed) finish(new BridgeError('voice_failed', '无法连接本机 Antigravity 语音服务，请确认桌面正在运行'));
  });
  req.end(framed);
  return {
    close() {
      if (closed) return;
      closed = true;
      finished = true;
      try { req.destroy(); } catch {}
      socket.destroy();
    },
  };
}
