import {useCallback,useLayoutEffect,useRef} from 'react';

// Event handlers keep a stable identity while reading the latest committed state.
export function useStableEvent<Args extends unknown[],Result>(callback:(...args:Args)=>Result):(...args:Args)=>Result {
  const latest=useRef(callback);
  useLayoutEffect(()=>{latest.current=callback;});
  return useCallback((...args:Args)=>latest.current(...args),[]);
}
