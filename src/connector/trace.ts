import {AsyncLocalStorage} from 'node:async_hooks';

/**
 * Timing of requests the phone asked to trace (web/trace.ts, docs/sync/IMPLEMENTATION.md M0).
 * Named steps inside a traced request add up their time; outside one they cost nothing.
 */
type Trace={steps:Record<string,number>};
const current=new AsyncLocalStorage<Trace>();
const round=(ms:number)=>Math.round(ms*10)/10;

/** Runs a request, timed when `enabled`; `trace` is what its answer carries back. */
export async function traced<T>(enabled:boolean,run:()=>Promise<T>):Promise<{value:T;trace?:{handleMs:number;now:number;steps:Record<string,number>}}> {
  if(!enabled)return {value:await run()};
  const trace:Trace={steps:{}},started=performance.now();
  const value=await current.run(trace,run);
  return {value,trace:{handleMs:round(performance.now()-started),now:Date.now(),steps:Object.fromEntries(Object.entries(trace.steps).map(([key,ms])=>[key,round(ms)]))}};
}
/** Adds the time `run` takes to the step `name` of the traced request it runs in. */
export async function step<T>(name:string,run:()=>Promise<T>|T):Promise<T> {
  const trace=current.getStore();if(!trace)return run();
  const started=performance.now();
  try{return await run();}finally{trace.steps[name]=(trace.steps[name]||0)+performance.now()-started;}
}
/** As {@link step}, for work that does not wait. */
export function stepSync<T>(name:string,run:()=>T):T {
  const trace=current.getStore();if(!trace)return run();
  const started=performance.now();
  try{return run();}finally{trace.steps[name]=(trace.steps[name]||0)+performance.now()-started;}
}
