import type {ContextUsage,Json,UsageLimit} from '../shared/types.js';

const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
export function contextUsage(value:Json|null|undefined):ContextUsage|null {
  // Cumulative usage counts repeated requests, not the current context window.
  const used=value?.last?.totalTokens,window=value?.modelContextWindow;
  if(!finite(used)||used<0)return null;
  return {usedTokens:used,windowTokens:finite(window)&&window>0?window:null};
}
export function accountLimits(value:Json):UsageLimit[] {
  const buckets=value.rateLimitsByLimitId&&Object.keys(value.rateLimitsByLimitId).length?Object.entries(value.rateLimitsByLimitId):[['default',value.rateLimits]];
  const limits:UsageLimit[]=[];
  for(const [key,raw] of buckets){
    const bucket=raw as Json|null;if(!bucket)continue;
    for(const slot of ['primary','secondary']){
      const window=bucket[slot];if(!finite(window?.usedPercent)||window.usedPercent<0)continue;
      limits.push({id:`${bucket.limitId||key}:${slot}`,name:typeof bucket.limitName==='string'?bucket.limitName:typeof bucket.limitId==='string'&&bucket.limitId!=='codex'?bucket.limitId:null,
        usedPercent:window.usedPercent,windowMinutes:finite(window.windowDurationMins)&&window.windowDurationMins>0?window.windowDurationMins:null,
        resetsAt:finite(window.resetsAt)&&window.resetsAt>0?window.resetsAt:null});
    }
  }
  return limits;
}
