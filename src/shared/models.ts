import type {Json} from './types.js';

export function fastTier(model:Json|undefined):string|undefined {
  const tier=model?.serviceTiers?.find((tier:Json)=>['fast','priority'].includes(tier.id)||['fast','priority'].includes(String(tier.name).toLowerCase()));
  return tier?.id||model?.additionalSpeedTiers?.find((id:string)=>id==='fast'||id==='priority');
}
