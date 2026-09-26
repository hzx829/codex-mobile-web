import type {MessageItem} from '../src/shared/types';

export function groupItems(items:MessageItem[]):MessageItem[][] {
  const groups:MessageItem[][]=[];
  for(const item of items) {
    const previous=groups.at(-1);
    if(item.role==='activity'&&previous?.[0]?.role==='activity')previous.push(item);
    else groups.push([item]);
  }
  return groups;
}
