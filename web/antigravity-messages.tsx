import {memo, useMemo} from 'react';
import type {AntigravityIssue, AntigravityMessage, MessageItem} from '../src/shared/types';
import {groupItems} from './activity';
import {ActivityGroup} from './conversation';
import {SafeMarkdown} from './content';
import {IconButton} from './icon-button';
import {SenderLabel} from './senders';

export function antigravityIssueText(issue: AntigravityIssue, canSend: boolean) {
  if (issue.kind === 'interrupted') return 'Antigravity 的回复中断了，可以发送消息继续。';
  if (issue.kind === 'error') return 'Antigravity 处理消息时出错。';
  const reason = issue.connection ? 'Antigravity 连接中断' : 'Antigravity 请求出错';
  if (canSend) return `${reason}，本轮已结束。`;
  return `${reason}，正在${issue.connection ? '重连' : '重试'}（第 ${issue.attempt} 次请求失败）…`;
}

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
  onCopy?: (text:string)=>void;
};
export const AntigravityMessages = memo(function AntigravityMessages({messages,running,openFile,openPreview,onFollowup,onCopy}: Props) {
  const groups = useMemo(() => groupAntigravityMessages(messages), [messages]);
  return groups.map((group, index) => {
    const first = group[0];
    if (first.role === 'activity') return <ActivityGroup key={first.id} items={group} running={running && index === groups.length-1} openFile={openFile}/>;
    const message=<article className={`message ${first.role}`}>
      <SafeMarkdown allowFileUrls text={first.text} openFile={openFile} openPreview={openPreview} onFollowup={onFollowup}/>
    </article>;
    return <div key={first.id} className={first.role==='user'?'user-entry':'turn'}>{first.role==='user'&&<SenderLabel sender={first.sender}/>}{message}
      {onCopy&&first.text&&<div className={first.role==='user'?'user-actions':'assistant-actions'}><IconButton icon="copy" label={first.role==='user'?'复制消息文字':'复制回复文字'} onClick={()=>onCopy(first.text)}/></div>}
    </div>;
  });
});
