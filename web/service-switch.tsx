import {parseLocation, type Route} from './route-state';
import {SERVICE_IDS, serviceHome, serviceLabel, serviceOf, type Service} from './services';

export {serviceOf, type Service} from './services';

export function switchRoute(machine: string, current: Route, next: Service): Route {
  const key = (service: Service) => JSON.stringify(['cmw-service', machine, service]);
  try {
    sessionStorage.setItem(key(serviceOf(current)), JSON.stringify({cmwRoute: current, cmwMachine: machine}));
    const saved = parseLocation(JSON.parse(sessionStorage.getItem(key(next)) || 'null'));
    if (saved && saved.machine === machine && serviceOf(saved.route) === next) return saved.route;
  } catch { /* Navigation also works without browser storage. */ }
  return serviceHome(next);
}

export function ServiceSwitch({active, available = SERVICE_IDS, disabled, select}: {
  active: Service; available?: readonly Service[]; disabled: boolean; select: (service: Service) => void;
}) {
  return <nav className="service-switch" aria-label="切换应用">
    {available.map(service => <button type="button" key={service}
      aria-pressed={service === active} disabled={disabled} onClick={() => {if (service !== active) select(service);}}>
      {serviceLabel(service)}
    </button>)}
  </nav>;
}
