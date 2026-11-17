import {home, parseLocation, type Route} from './route-state';

export type Service = 'codex' | 'chatgpt' | 'antigravity';
const names = {codex: 'Codex', chatgpt: 'ChatGPT', antigravity: 'Antigravity'} as const;
export function serviceOf(route: Route): Service {
  if (route.antigravity !== undefined) return 'antigravity';
  return route.chat !== undefined ? 'chatgpt' : 'codex';
}

export function switchRoute(machine: string, current: Route, next: Service): Route {
  const key = (service: Service) => JSON.stringify(['cmw-service', machine, service]);
  try {
    sessionStorage.setItem(key(serviceOf(current)), JSON.stringify({cmwRoute: current, cmwMachine: machine}));
    const saved = parseLocation(JSON.parse(sessionStorage.getItem(key(next)) || 'null'));
    if (saved && saved.machine === machine && serviceOf(saved.route) === next) return saved.route;
  } catch { /* Navigation also works without browser storage. */ }
  if (next === 'codex') return home;
  return next === 'chatgpt' ? {...home, chat: ''} : {...home, antigravity: ''};
}

export function ServiceSwitch({active, disabled, select}: {active: Service; disabled: boolean; select: (service: Service) => void}) {
  return <nav className="service-switch" aria-label="切换应用">
    {(Object.keys(names) as Service[]).map(service => <button type="button" key={service}
      aria-pressed={service === active} disabled={disabled} onClick={() => {if (service !== active) select(service);}}>
      {names[service]}
    </button>)}
  </nav>;
}
