import {COLD_START_STALE_MS, ensureComposerRoute, hasOpenConversation, newChatRoute, parseLocation, type Route} from './route-state';
import {SERVICE_IDS, serviceLabel, serviceOf, type Service} from './services';

export {serviceOf, type Service} from './services';

export function switchRoute(machine: string, current: Route, next: Service, now = Date.now()): Route {
  const key = (service: Service) => JSON.stringify(['cmw-service', machine, service]);
  const payload = JSON.stringify({cmwRoute: current, cmwMachine: machine, savedAt: now});
  try { sessionStorage.setItem(key(serviceOf(current)), payload); } catch {}
  try { localStorage.setItem(key(serviceOf(current)), payload); } catch {}

  try {
    const fromSession = parseLocation(JSON.parse(sessionStorage.getItem(key(next)) || 'null'));
    if (fromSession && fromSession.machine === machine && serviceOf(fromSession.route) === next) {
      return ensureComposerRoute(fromSession.route);
    }
  } catch { /* Navigation also works without browser storage. */ }

  try {
    const raw = JSON.parse(localStorage.getItem(key(next)) || 'null') as {savedAt?: unknown} | null;
    const fromLocal = parseLocation(raw);
    if (fromLocal && fromLocal.machine === machine && serviceOf(fromLocal.route) === next) {
      const savedAt = typeof raw?.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : null;
      if (hasOpenConversation(fromLocal.route) && savedAt !== null && now - savedAt > COLD_START_STALE_MS) {
        return newChatRoute(next, fromLocal.route.project);
      }
      return ensureComposerRoute(fromLocal.route);
    }
  } catch { /* Navigation also works without browser storage. */ }

  return newChatRoute(next);
}

export function ServiceSwitch({active, available = SERVICE_IDS, disabled, select, className}: {
  active: Service; available?: readonly Service[]; disabled: boolean; select: (service: Service) => void; className?: string;
}) {
  return <nav className={`service-switch${className ? ` ${className}` : ''}`} aria-label="切换应用">
    {available.map(service => <button type="button" key={service}
      aria-pressed={service === active} disabled={disabled} onClick={() => {if (service !== active) select(service);}}>
      {serviceLabel(service)}
    </button>)}
  </nav>;
}
