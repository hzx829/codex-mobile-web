import type {ReactNode} from 'react';
export type IconName='back'|'more'|'computer'|'folder'|'search'|'compose'|'plus'|'mic'|'send'|'stop'|'chevron'|'close'|'refresh'|'settings'|'file'|'image'|'logout'|'check'|'chat'|'copy'|'browser'|'pin'|'archive'|'unread'|'shield'|'fork'|'edit'|'steer'|'now'|'undo'|'trash'|'diff';
// One line-icon family: 24-unit grid, 1.75 stroke, round joins. Drawn at 20 px by default.
const paths:Record<IconName,ReactNode>={
  back:<path d="M19 12H5m6-6.5L4.5 12l6.5 6.5"/>,
  more:<><circle cx="12" cy="5.5" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.4" fill="currentColor" stroke="none"/></>,
  computer:<><rect x="4" y="4.5" width="16" height="11" rx="1.75"/><path d="M2.5 19.5h19"/></>,
  folder:<path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2h8A1.5 1.5 0 0 1 20.5 9v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5Z"/>,
  search:<><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></>,
  compose:<><path d="M11.5 4.5h-5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5"/><path d="M17.3 4.2a1.8 1.8 0 0 1 2.5 2.5l-7.3 7.3-3.3.8.8-3.3Z"/></>,
  plus:<path d="M12 5v14M5 12h14"/>,
  mic:<><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></>,
  send:<path d="M12 19V5m-6 6 6-6 6 6"/>,
  steer:<path d="M12 20V9m-5 5 5-5 5 5M6 4.5h12"/>,
  now:<path d="M13.5 3 5.5 13.5h6L10.5 21l8-10.5h-6Z"/>,
  undo:<path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>,
  trash:<path d="M4 7h16M9.5 7V4.5h5V7M6 7l.9 11.6a1.5 1.5 0 0 0 1.5 1.4h7.2a1.5 1.5 0 0 0 1.5-1.4L18 7M10 11v5M14 11v5"/>,
  stop:<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>,
  chevron:<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>,
  close:<path d="M6.5 6.5l11 11m0-11-11 11"/>,
  refresh:<path d="M19.5 12A7.5 7.5 0 0 1 6.2 16.8M4.5 12A7.5 7.5 0 0 1 17.8 7.2M18 3.5v4h-4M6 20.5v-4h4"/>,
  settings:<><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.5" fill="var(--icon-fill, #fff)"/><circle cx="15" cy="17" r="2.5" fill="var(--icon-fill, #fff)"/></>,
  file:<><path d="M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9Z"/><path d="M13.5 3.5V9H19"/></>,
  image:<><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m20.5 15.5-4.5-4.5-9.5 8.5"/></>,
  logout:<path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 8l4 4-4 4M19 12H9"/>,
  check:<path d="m5 12.5 4.5 4.5L19 7.5"/>,
  chat:<path d="M20 11.5c0 4.1-3.6 7.5-8 7.5-1.2 0-2.3-.2-3.3-.7L4 19.5l1.2-3.8A7.2 7.2 0 0 1 4 11.5C4 7.4 7.6 4 12 4s8 3.4 8 7.5Z"/>,
  copy:<><rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/></>,
  browser:<><rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 9h18"/></>,
  pin:<path d="M12 16v4.5M8.5 4h7l-1 5 3 3.5V16h-11v-3.5l3-3.5Z"/>,
  archive:<><rect x="3.5" y="4" width="17" height="4.5" rx="1"/><path d="M5 8.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5M10 12.5h4"/></>,
  unread:<circle cx="12" cy="12" r="7.5"/>,
  shield:<path d="M12 3.5 5 6.3v5.2c0 4.2 2.9 7.4 7 9 4.1-1.6 7-4.8 7-9V6.3Z"/>,
  fork:<><circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="18.5" r="2"/><circle cx="17.5" cy="7.5" r="2"/><path d="M6.5 7.5v9M17.5 9.5a5 5 0 0 1-5 5h-2a4 4 0 0 0-4 2"/></>,
  edit:<path d="M4.5 19.5h4l10.3-10.3a2.1 2.1 0 0 0-3-3L5.5 16.5Zm9.5-11.5 3 3"/>,
  diff:<><path d="M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9Z"/><path d="M12 9v5M9.5 11.5h5M9.5 17h5"/></>,
};
export function Icon({name,size=20}:{name:IconName;size?:number}) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
