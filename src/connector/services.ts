import {BridgeError, type BridgeRequest, type Json} from '../shared/types.js';

/** A desktop app exposed to the phone under `<prefix>.*` actions. */
export interface ServiceBridge {
  prefix: string;
  handle(action: string, payload: Json): Promise<Json>;
  /** Actions that change the desktop app; they are refused while the connector is updating. */
  mutations?: readonly string[];
  /** Called before a connector update so the bridge can refuse new work or report that it is busy. */
  prepareReload?(): void;
  close?(): void;
}

type Fallback = (request: BridgeRequest) => Promise<Json>;

/** Routes phone requests to the bridge that owns the action prefix; everything else is Codex. */
export class ServiceRouter {
  constructor(private bridges: ServiceBridge[], private codex: Fallback, private updating: () => boolean = () => false) {
    const prefixes = new Set<string>();
    for (const bridge of bridges) {
      if (!/^[a-z][a-z0-9-]*$/.test(bridge.prefix) || prefixes.has(bridge.prefix)) throw new Error(`Invalid service prefix: ${bridge.prefix}`);
      prefixes.add(bridge.prefix);
    }
  }
  bridgeFor(action: string) {
    return this.bridges.find(bridge => action.startsWith(bridge.prefix + '.'));
  }
  async handle(request: BridgeRequest): Promise<Json> {
    const action = String(request.action);
    if (action === 'runtime.reload') for (const bridge of this.bridges) bridge.prepareReload?.();
    const bridge = this.bridgeFor(action);
    if (!bridge) return this.codex(request);
    if (this.updating() && bridge.mutations?.includes(action)) throw new BridgeError('maintenance', '连接器正在更新，请稍后重试');
    return bridge.handle(action, request.payload || {});
  }
  close() {for (const bridge of this.bridges) try {bridge.close?.();} catch { /* Keep closing the others. */ }}
}
