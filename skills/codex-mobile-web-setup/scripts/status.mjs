import {readFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';

// Authenticate as a phone and read only this installation's info. Never print the Token.
export async function checkConnection(installDir, timeoutMs = 20000) {
  let config;
  try { config = JSON.parse(await readFile(join(installDir, '.local', 'config.json'), 'utf8')); }
  catch { throw new Error('config_unreadable'); }
  let url;
  try {
    url = new URL(config.relayUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw Error();
    if (typeof config.token !== 'string' || config.token.length < 24 || !config.machineId) throw Error();
  } catch { throw new Error('config_invalid'); }
  const relayUrl = url.origin;
  url.pathname = '/ws';
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return new Promise((resolveCheck, reject) => {
    const ws = new WebSocket(url);
    let finished = false, requested = false, authenticated = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ws.close();
      error ? reject(new Error(error)) : resolveCheck(result);
    };
    const timer = setTimeout(() => finish(!authenticated ? 'relay_timeout' : requested ? 'computer_timeout' : 'connector_offline'), timeoutMs);
    const readInfo = machines => {
      if (requested || !Array.isArray(machines) || !machines.some(m => m.id === config.machineId)) return;
      requested = true;
      ws.send(JSON.stringify({type: 'request', id: 'setup-info', machineId: config.machineId, action: 'info', payload: {}}));
    };
    ws.addEventListener('open', () => ws.send(JSON.stringify({type: 'hello', role: 'phone', token: config.token})));
    ws.addEventListener('error', () => finish('relay_unreachable'));
    ws.addEventListener('close', e => finish(e.code === 4401 ? 'token_rejected' : 'relay_disconnected'));
    ws.addEventListener('message', e => {
      let m;
      try { m = JSON.parse(e.data); } catch { finish('invalid_response'); return; }
      if (!m || typeof m !== 'object') { finish('invalid_response'); return; }
      if (m.type === 'ready') { authenticated = true; readInfo(m.machines); }
      if (m.type === 'machines' && authenticated) readInfo(m.data);
      if (m.type !== 'response' || m.id !== 'setup-info' || !requested) return;
      if (m.error || !m.result || !Array.isArray(m.result.projects)) { finish('codex_info_failed'); return; }
      const text = value => typeof value === 'string' ? value.slice(0, 120).split(config.token).join('[redacted]') : '';
      finish(null, {online: true, relayUrl, machineName: text(config.machineName), machineId: config.machineId,
        model: text(m.result.model), provider: text(m.result.provider), projectCount: m.result.projects.length,
        desktopOnline: m.result.desktopOnline === true});
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await checkConnection(resolve(process.argv[2] || '.')))); }
  catch (e) { console.error(JSON.stringify({online: false, error: e.message})); process.exitCode = 1; }
}
