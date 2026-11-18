import {home, type Route} from './route-state';
import {coworkThreadPath} from '../src/shared/cowork';

/**
 * Every phone-side app lives in this table. Adding an app means adding one entry here,
 * a connector bridge with the same action prefix, and its panel in main.tsx.
 */
type RemoteField = 'antigravity' | 'cowork';
type ServiceSpec = {
  label: string;
  /** Route field that holds the open conversation; Codex uses thread/project/newChat instead. */
  field?: RemoteField;
  /** Whether the list's project filter survives inside this app's route. */
  keepsProject?: boolean;
  /** Prefix used for preview/file owners so file reads go to the right connector bridge. */
  threadPrefix?: string;
  conversationPattern?: RegExp;
};

export const SERVICES = {
  codex: {label: 'Codex'},
  antigravity: {label: 'Antigravity', field: 'antigravity', keepsProject: true, threadPrefix: 'antigravity:'},
  cowork: {label: 'Cowork', field: 'cowork', keepsProject: true, conversationPattern: coworkThreadPath},
} as const satisfies Record<string, ServiceSpec>;

export type Service = keyof typeof SERVICES;
export const SERVICE_IDS = Object.keys(SERVICES) as Service[];
const spec = (service: Service): ServiceSpec => SERVICES[service];

const conversationId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function isConversation(field: RemoteField, id: string) {
  const service = SERVICE_IDS.find(service=>spec(service).field===field);
  return ((service && spec(service).conversationPattern) || conversationId).test(id);
}

export function remoteFields(): RemoteField[] {
  return SERVICE_IDS.flatMap(service => spec(service).field ?? []);
}

export function serviceOf(route: Route): Service {
  return SERVICE_IDS.find(service => {const field = spec(service).field;return field !== undefined && route[field] !== undefined;}) ?? 'codex';
}

/** The conversation open in a remote app, or '' for its list and for Codex. */
export function routeConversation(route: Route): string {
  const field = spec(serviceOf(route)).field;
  return field ? route[field] || '' : '';
}

/** The landing route of an app, optionally keeping a project filter when the app supports one. */
export function serviceHome(service: Service, project = ''): Route {
  const {field, keepsProject} = spec(service);
  return field ? {...home, project: keepsProject ? project : '', [field]: ''} : home;
}

export function withConversation(route: Route, id: string): Route {
  const field = spec(serviceOf(route)).field;
  return field ? {...route, [field]: id} : route;
}

/** Thread owner key used by previews and file reads; Codex threads stay unprefixed. */
export function previewOwner(route: Route, codexThread: string): string {
  const service = serviceOf(route), prefix = spec(service).threadPrefix;
  if (service === 'codex') return codexThread;
  const id = routeConversation(route);
  return prefix && id ? prefix + id : '';
}

/** Resolves a preview owner back to the app that serves its files. */
export function fileOwner(threadId: string): {service: Service; id: string} {
  for (const service of SERVICE_IDS) {
    const prefix = spec(service).threadPrefix;
    if (prefix && threadId.startsWith(prefix)) return {service, id: threadId.slice(prefix.length)};
  }
  return {service: 'codex', id: threadId};
}

export function serviceLabel(service: Service) {return spec(service).label;}
