import {useState} from 'react';
import type {ApprovalRequest} from '../src/shared/types';

/** Where "remember" saves the rule, as the connector reports it; older connectors do not say. */
const REMEMBER = {session: '本会话允许', project: '本项目始终允许', user: '始终允许'} as const;
/** How an approved plan is carried out, as Claude Code's own plan prompt words it. */
const IMPLEMENT: Record<string, string> = {acceptEdits: '开始执行，接受编辑', default: '开始执行，手动审批'};

/**
 * Shared approval, plan confirmation and question card rendered in `.request-stack` above the composer
 * for both Claude Code and Antigravity.
 */
export function ApprovalCard({request, disabled, modeLabel, respond}: {
  request: ApprovalRequest;
  disabled: boolean;
  modeLabel?: (mode: string) => string;
  respond: (decision: 'allow' | 'allowSession' | 'deny', answers?: Record<string, string>, mode?: string) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  if (request.kind === 'notice') {
    return <div className="request"><strong>{request.title}</strong>{request.detail && <pre>{request.detail}</pre>}</div>;
  }
  if (request.kind === 'question') {
    const value = (question: string) => [...(answers[question] || []), ...(other[question]?.trim() ? [other[question].trim()] : [])].join(', ');
    const complete = request.questions?.every(q => value(q.question));
    return <div className="request"><strong>{request.title}</strong>
      {request.questions?.map(q => <div className="claude-question" key={q.question}><p>{q.header && <small>{q.header} · </small>}{q.question}</p>
        <div className="choices">{q.options.map(option => {
          const chosen = answers[q.question]?.includes(option.label);
          return <button type="button" key={option.label} title={option.description} className={chosen ? 'chosen' : ''} disabled={disabled}
            onClick={() => setAnswers(old => {
              const current = old[q.question] || [];
              return {...old, [q.question]: q.multiSelect ? chosen ? current.filter(x => x !== option.label) : [...current, option.label] : [option.label]};
            })}>{option.label}</button>;
        })}</div>
        <input placeholder="其他回答（可选）" value={other[q.question] || ''} disabled={disabled} onChange={e => setOther(old => ({...old, [q.question]: e.target.value}))}/></div>)}
      <div className="choices"><button className="primary" disabled={disabled || !complete} onClick={() => respond('allow', Object.fromEntries((request.questions || []).map(q => [q.question, value(q.question)])))}>提交回答</button>
        <button disabled={disabled} onClick={() => respond('deny')}>跳过</button></div></div>;
  }
  if (request.kind === 'plan' && request.implementModes?.length) {
    return <div className="request"><strong>{request.title}</strong>{request.detail && <pre>{request.detail}</pre>}
      <div className="choices">
        {request.implementModes.map((mode, index) => <button key={mode} className={index === 0 ? 'primary' : ''} disabled={disabled} onClick={() => respond('allow', undefined, mode)}>{IMPLEMENT[mode] || `开始执行，${modeLabel ? modeLabel(mode) : mode}`}</button>)}
        <button disabled={disabled} onClick={() => respond('deny')}>继续规划</button>
      </div></div>;
  }
  return <div className="request"><strong>{request.title}</strong>{request.detail && <pre>{request.detail}</pre>}
    <div className="choices">
      <button disabled={disabled} onClick={() => respond('allow')}>{request.kind === 'plan' ? '开始执行' : '允许一次'}</button>
      {request.canRemember && <button disabled={disabled} onClick={() => respond('allowSession')}>{request.rememberScope ? REMEMBER[request.rememberScope] : '允许并记住'}</button>}
      <button disabled={disabled} onClick={() => respond('deny')}>{request.kind === 'plan' ? '继续规划' : '拒绝'}</button>
    </div></div>;
}
