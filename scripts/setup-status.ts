import {resolve} from 'node:path';
import {WebSocket} from 'ws';
import {fetchLocalStatus, type ActiveTask} from '../src/connector/local-control.js';

export type RelayStatus = {
  relay: 'ok' | 'connecting' | 'unreachable' | 'unauthorized';
  authReason?: 'machine_token_mismatch' | 'invalid_token' | 'replaced' | null;
  connector: 'online' | 'offline' | 'unknown';
  teamMode?: boolean;
  ownToken?: boolean;
  machineName?: string;
  services?: string[];
  codexVersion?: string;
  desktopOnline?: boolean;
  /** Whether the connector's own browser is signed in to claude.ai, which viewing Claude's published pages needs. */
  claudeSignIn?: 'yes' | 'no' | 'unknown';
  activeTasks?: ActiveTask[];
  pendingUsage?: number;
  projectRoots?: string[];
  defaultProjectRoot?: string;
};

/**
 * Read-only health check for the desktop window. Prefers the running connector's loopback control endpoint
 * (which works identically in single-token and team modes), and falls back to the legacy relay handshake for older connectors.
 */
export async function relayStatus(config: {relayUrl?: string; token?: string; machineId?: string; machineName?: string}, timeoutMs = 6000, dataDir = resolve('.local')): Promise<RelayStatus> {
  const local = await fetchLocalStatus(dataDir, Math.min(timeoutMs, 4000));
  if (local) return local;
  return legacyRelayStatus(config, timeoutMs);
}

function legacyRelayStatus(config: {relayUrl?: string; token?: string; machineId?: string; machineName?: string}, timeoutMs: number): Promise<RelayStatus> {
  const ownToken = Boolean(config.token?.startsWith('cnt_'));
  return new Promise(resolveStatus => {
    if (!config.relayUrl || !config.token) {resolveStatus({relay: 'unreachable', connector: 'unknown', teamMode: ownToken, ownToken}); return;}
    const url = new URL('/ws', config.relayUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let result: RelayStatus = {relay: 'unreachable', connector: 'unknown', teamMode: ownToken, ownToken, machineName: config.machineName}, done = false;
    const ws = new WebSocket(url, {handshakeTimeout: timeoutMs});
    const finish = (value: RelayStatus) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.terminate();
      resolveStatus(value);
    };
    const timer = setTimeout(() => finish(result), timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({type: 'hello', role: 'phone', token: config.token})));
    ws.on('error', () => finish(result));
    ws.on('close', code => finish(code === 4401 ? {relay: 'unauthorized', connector: 'unknown', teamMode: ownToken, ownToken, machineName: config.machineName} : result));
    ws.on('message', raw => {
      let message: any;
      try {message = JSON.parse(raw.toString());} catch {return;}
      if (message.type === 'ready') {
        const machine = (message.machines || []).find((m: any) => m.id === config.machineId);
        result = {relay: 'ok', connector: machine ? 'online' : 'offline', teamMode: false, ownToken: false, machineName: config.machineName, ...(machine ? {services: machine.services} : {})};
        if (!machine) {finish(result); return;}
        ws.send(JSON.stringify({type: 'request', id: 'info', machineId: config.machineId, action: 'info', payload: {}}));
      } else if (message.type === 'response' && message.id === 'info') {
        if (!message.error) result = {...result, codexVersion: message.result?.runtime?.version, desktopOnline: Boolean(message.result?.desktopOnline)};
        if (!result.services?.includes('claude')) {finish(result); return;}
        ws.send(JSON.stringify({type: 'request', id: 'signin', machineId: config.machineId, action: 'claude.artifact.login', payload: {op: 'check'}}));
      } else if (message.type === 'response' && message.id === 'signin') {
        const value = message.result?.signedIn;
        if (!message.error && message.result?.available !== false && (value === 'yes' || value === 'no' || value === 'unknown')) result = {...result, claudeSignIn: value};
        finish(result);
      }
    });
  });
}
