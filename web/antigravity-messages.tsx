import {memo, useMemo} from 'react';
import type {AntigravityMessage, MessageItem} from '../src/shared/types';
import {groupItems} from './activity';
import {ActivityGroup} from './conversation';
import {SafeMarkdown} from './content';

export function groupAntigravityMessages(messages: AntigravityMessage[]) {
  const items = messages.flatMap<MessageItem>(message => {
    if (message.role !== 'tool') return [{...message, type: 'message'}];
    return message.text.split('、').map((name, index) => ({
      id: `${message.id}:${index}`, role: 'activity', type: 'mcpToolCall', text: name,
    }));
  });
  return groupItems(items);
}

type Props = {
  messages: AntigravityMessage[]; running: boolean;
  openFile: (path:string)=>void; openPreview: (url:string)=>void; onFollowup: (text:string)=>void;
};
export const AntigravityMessages = memo(function AntigravityMessages({messages,running,openFile,openPreview,onFollowup}: Props) {
  const groups = useMemo(() => groupAntigravityMessages(messages), [messages]);
  return groups.map((group, index) => {
    const first = group[0];
    if (first.role === 'activity') return <ActivityGroup key={first.id} items={group} running={running && index === groups.length-1} openFile={openFile}/>;
    return <article key={first.id} className={`message ${first.role}`}>
      <SafeMarkdown allowFileUrls text={first.text} openFile={openFile} openPreview={openPreview} onFollowup={onFollowup}/>
    </article>;
  });
});
