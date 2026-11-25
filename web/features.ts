import type {Machine} from '../src/shared/types';
import {CONNECTOR_FEATURES,PROTOCOL_VERSION,type ConnectorFeature} from '../src/shared/protocol';

/**
 * Whether a computer's connector can do something this page offers; see src/shared/protocol.ts.
 * The one place the page checks connector features: callers ask for the update when this is false.
 */
export function connectorHas(machine:Machine|undefined,feature:ConnectorFeature):boolean {
  return Boolean(machine?.features?.includes(feature));
}

/**
 * How this page and a computer's connector differ: 'connector' when the connector (or the relay passing
 * its report on) lacks features this page uses, 'page' when the connector speaks a newer protocol.
 */
export function versionGap(machine:Machine):'connector'|'page'|undefined {
  if((machine.protocol??0)>PROTOCOL_VERSION)return 'page';
  return CONNECTOR_FEATURES.every(feature=>connectorHas(machine,feature))?undefined:'connector';
}

export const versionGapNotice={
  connector:'这台电脑的连接器（或中继）比网页旧，部分新功能不可用。请在电脑上更新连接器，并确认中继已更新。',
  page:'这台电脑的连接器比当前网页新，请刷新网页。',
} as const;
