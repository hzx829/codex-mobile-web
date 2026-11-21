import type {Json} from './types.js';

export type ModelSelection={model:string;effort:string;serviceTier?:string|null};
export type ModelDefaults={model?:string;effort?:string;serviceTier?:string|null};

export function modelDisplayName(model:Json|undefined,fallback=''):string {
  const name=String(model?.displayName||model?.model||fallback);
  // The runtime catalog uses GPT-6-Astra; the desktop picker uses GPT-6 Astra.
  // Only normalize this known family; provider-supplied names remain verbatim.
  return name.replace(/^gpt-(\d+(?:\.\d+)?)[- ](astra|sol|terra|luna)$/i,(_,version:string,family:string)=>`GPT-${version} ${family[0].toUpperCase()}${family.slice(1).toLowerCase()}`);
}

export function reasoningLabel(effort:string):string {
  return ({none:'无',minimal:'极低',low:'轻度',medium:'中',high:'高',xhigh:'极高',max:'Max',ultra:'Ultra'} as Record<string,string>)[effort]||effort;
}

export function reasoningOptions(model:Json|undefined):string[] {
  return [...new Set<string>((model?.supportedReasoningEfforts||[]).map((option:Json)=>option.reasoningEffort).filter((value:unknown)=>typeof value==='string'&&value))];
}

export function fastTier(model:Json|undefined):string|undefined {
  const tier=model?.serviceTiers?.find((tier:Json)=>['fast','priority'].includes(tier.id)||['fast','priority'].includes(String(tier.name).toLowerCase()));
  return tier?.id||model?.additionalSpeedTiers?.find((id:string)=>id==='fast'||id==='priority');
}

/**
 * The list entry for the model a session reports. Claude Code lists aliases ("opus") whose `resolvedModel` is the
 * full ID a session runs on; the named entry is preferred over "default", and a "[1m]" suffix is ignored.
 */
export function listedModel(models:Json[],id:string|undefined):Json|undefined {
  if(!id)return undefined;
  const base=(value:unknown)=>String(value||'').replace(/\[[^\]]*\]$/,'');
  const resolved=(entry:Json)=>base(entry.resolvedModel)===base(id);
  return models.find(entry=>entry.model===id)||models.find(entry=>base(entry.model)===base(id))
    ||models.find(entry=>entry.model!=='default'&&resolved(entry))||models.find(resolved);
}

export function resolveModelSelection(models:Json[],value:ModelSelection,current:ModelDefaults) {
  const id=value.model||current.model||'',model=models.find(entry=>entry.model===id);
  const effort=value.effort||current.effort||model?.defaultReasoningEffort||'';
  const serviceTier=value.serviceTier!==undefined?value.serviceTier:current.serviceTier!==undefined?current.serviceTier:model?.defaultServiceTier;
  const fast=fastTier(model);
  return {id,model,effort,serviceTier,fast,isFast:Boolean(fast&&(serviceTier===fast||serviceTier==='fast')),efforts:reasoningOptions(model)};
}

export function selectModel(models:Json[],value:ModelSelection,current:ModelDefaults,id:string):ModelSelection {
  const next=models.find(entry=>entry.model===id);
  if(!next)return value;
  const previous=resolveModelSelection(models,value,current),efforts=reasoningOptions(next);
  const effort=efforts.includes(previous.effort)?previous.effort:efforts.includes(next.defaultReasoningEffort)?next.defaultReasoningEffort:previous.effort?efforts[0]||'':'';
  return {model:id,effort,serviceTier:previous.isFast?fastTier(next)||null:null};
}
