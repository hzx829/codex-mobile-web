import type {ReactNode} from 'react';
export type IconName='back'|'more'|'computer'|'folder'|'search'|'compose'|'plus'|'mic'|'send'|'stop'|'chevron'|'close'|'refresh'|'settings'|'file'|'image'|'logout'|'check'|'chat';
export function Icon({name,size=24}:{name:IconName;size?:number}) {
  const paths:Record<IconName,ReactNode>={
    back:<><path d="m11 5-7 7 7 7M4 12h16"/></>,
    more:<><circle cx="12" cy="5" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none"/></>,
    computer:<><rect x="5" y="3" width="14" height="13" rx="2"/><path d="M3 17h18v3H3z"/></>,
    folder:<path d="M3 7V5a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7h18"/>,
    search:<><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    compose:<><path d="M10 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-5M14 5l5 5M9 15l1-5L18 2a2 2 0 0 1 4 4l-8 8-5 1Z"/></>,
    plus:<path d="M12 4v16M4 12h16"/>,
    mic:<><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3"/></>,
    send:<path d="m5 11 7-7 7 7M12 4v16"/>,
    stop:<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>,
    chevron:<path d="m8 10 4 4 4-4"/>,close:<path d="m6 6 12 12M6 18 18 6"/>,
    refresh:<><path d="M20 7v5h-5M4 17v-5h5M5.1 7a8 8 0 0 1 13-2l1.9 2M4 17l1.9 2a8 8 0 0 0 13-2"/></>,
    settings:<><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="white"/><circle cx="15" cy="17" r="3" fill="white"/></>,
    file:<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z M14 2v6h6M8 13h8M8 17h6"/></>,
    image:<><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 17 5-5 4 4 4-7 5 7"/></>,
    logout:<><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5M10 12h11m-4-4 4 4-4 4"/></>,
    check:<path d="m5 12 4 4L19 6"/>,
    chat:<><rect x="5" y="2" width="14" height="12" rx="2"/><path d="M3 15h18v3H3z"/><path d="M6 22h.01M10 22h.01M14 22h.01M18 22h.01"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
