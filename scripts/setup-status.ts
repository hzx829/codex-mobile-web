import {WebSocket} from 'ws';

export type RelayStatus = {
  relay: 'ok' | 'unreachable' | 'unauthorized';
  connector: 'online' | 'offline' | 'unknown';
  services?: string[];
  codexVersion?: string;
  desktopOnline?: boolean;
  /** Whether the connector's own browser is signed in to claude.ai, which viewing Claude's published pages needs. */
  claudeSignIn?: 'yes' | 'no' | 'unknown';
};

/** Read-only health check for the desktop window: same handshake as the phone, never creates work. */
export function relayStatus(config: {relayUrl?: string; token?: string; machineId?: string}, timeoutMs = 6000): Promise<RelayStatus> {
  return new Promise(resolve => {
    if (!config.relayUrl || !config.token) {resolve({relay: 'unreachable', connector: 'unknown'}); return;}
    const url = new URL('/ws', config.relayUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let result: RelayStatus = {relay: 'unreachable', connector: 'unknown'}, done = false;
    const ws = new WebSocket(url, {handshakeTimeout: timeoutMs});
    const finish = (value: RelayStatus) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.terminate();
      resolve(value);
    };
    const timer = setTimeout(() => finish(result), timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({type: 'hello', role: 'phone', token: config.token})));
    ws.on('error', () => finish(result));
    ws.on('close', code => finish(code === 4401 ? {relay: 'unauthorized', connector: 'unknown'} : result));
    ws.on('message', raw => {
      let message: any;
      try {message = JSON.parse(raw.toString());} catch {return;}
      if (message.type === 'ready') {
        const machine = (message.machines || []).find((m: any) => m.id === config.machineId);
        result = {relay: 'ok', connector: machine ? 'online' : 'offline', ...(machine ? {services: machine.services} : {})};
        if (!machine) {finish(result); return;}
        ws.send(JSON.stringify({type: 'request', id: 'info', machineId: config.machineId, action: 'info', payload: {}}));
      } else if (message.type === 'response' && message.id === 'info') {
        if (!message.error) result = {...result, codexVersion: message.result?.runtime?.version, desktopOnline: Boolean(message.result?.desktopOnline)};
        if (!result.services?.includes('claude')) {finish(result); return;}
        ws.send(JSON.stringify({type: 'request', id: 'signin', machineId: config.machineId, action: 'claude.artifact.login', payload: {op: 'check'}}));
      } else if (message.type === 'response' && message.id === 'signin') {
        // Older connectors do not answer this; the status then says nothing about the sign-in.
        const value = message.result?.signedIn;
        if (!message.error && message.result?.available !== false && (value === 'yes' || value === 'no' || value === 'unknown')) result = {...result, claudeSignIn: value};
        finish(result);
      }
    });
  });
}
