import {memo,useMemo,useRef,useState,type ReactNode} from 'react';
import {turnFinished,type TurnView,type SessionView,type MessageItem} from '../src/shared/types';
import {SafeMarkdown} from './content';
import {groupItems} from './activity';
import {Icon} from './icons';
import {IconButton} from './icon-button';
const name=(path:string)=>path.split(/[\\/]/).filter(Boolean).at(-1)||path;
const statusLabel:Record<string,string>={inProgress:'进行中',completed:'已完成',interrupted:'已停止',failed:'失败'};
const activityLabel:Record<string,string>={commandExecution:'运行命令',fileChange:'修改文件',mcpToolCall:'使用工具',reasoning:'思考摘要',webSearch:'搜索',contextCompaction:'整理上下文',plan:'计划'};

type Props={
  turn:TurnView;running:boolean;source:SessionView['source'];latestUser:boolean;disabled:boolean;
  openFile:(path:string)=>void;openPreview:(url:string)=>void;onFollowup:(text:string)=>void;
  onCopy:(text:string)=>void;onEdit:(turnId:string,itemId:string,text:string)=>Promise<void>;
  onFork:(turn:TurnView)=>void;onDiff:(turn:TurnView)=>void;onBlocked:(reason:string)=>void;
};
export const ConversationTurn=memo(function ConversationTurn({turn,running,source,latestUser,disabled,openFile,openPreview,onFollowup,onCopy,onEdit,onFork,onDiff,onBlocked}:Props){
  const groups=useMemo(()=>groupItems(turn.items),[turn.items]);
  const lastReply=turn.items.filter(item=>item.role==='assistant').at(-1);
  const editReason=running?'请等当前任务结束后再改写':!turnFinished(turn.status)?'此轮状态尚未同步，请刷新后重试':source==='history'?'当前会话只读，请先在这里继续':turn.items.filter(item=>item.role==='user').length!==1?'这一轮有多条用户消息，暂不能改写':source==='desktop'&&!latestUser?'桌面会话目前只能改写最近一条用户消息':'';
  return <section className="turn">
    {groups.map((group,index)=>group[0].role==='activity'?<ActivityGroup key={`activity-${index}`} items={group} running={turn.status==='inProgress'} openFile={openFile}/>:group.map(item=>{
      const body=<><SafeMarkdown text={item.text} openFile={openFile} openPreview={openPreview} onFollowup={onFollowup}/>{item.images?.map((url,i)=><img className="attachment" key={i} src={url} alt="附图" loading="lazy" decoding="async"/>)}</>;
      return item.role==='user'?<UserMessage key={item.id} text={item.text} editReason={editReason} disabled={disabled} blocked={onBlocked} copy={()=>onCopy(item.text)} resend={text=>onEdit(turn.id,item.id,text)}>{body}</UserMessage>:<article className={`message ${item.role}`} key={item.id}>{body}</article>;
    }))}
    <div className="turn-status">{turn.status!=='completed'&&(statusLabel[turn.status]||turn.status)}{turn.diff&&<button onClick={()=>onDiff(turn)}><Icon name="file" size={14}/>查看修改</button>}</div>{turn.error&&<p className="error">{turn.error}</p>}
    {lastReply&&<div className="assistant-actions"><IconButton icon="copy" label="复制回复文字" onClick={()=>onCopy(lastReply.text)}/><IconButton icon="fork" label="从这轮回复分叉" disabled={disabled} onClick={()=>onFork(turn)}/></div>}
  </section>;
});
export function ActivityGroup({items,running,openFile}:{items:MessageItem[];running:boolean;openFile:(path:string)=>void}){
  const [open,setOpen]=useState(false);
  return <details className="activity-group" onToggle={e=>setOpen(e.currentTarget.open)}><summary>{running?'正在处理':'运行记录'} · {items.length} 项<span className="activity-excerpt">{activityLabel[items.at(-1)!.type]||'任务活动'}</span></summary>{open&&<div className="activity-list">{items.map(item=><ActivityItem key={item.id} item={item} openFile={openFile}/>)}</div>}</details>;
}
const ActivityItem=memo(function ActivityItem({item,openFile}:{item:MessageItem;openFile:(path:string)=>void}){
  const [open,setOpen]=useState(false);
  return <details className="activity" onToggle={e=>setOpen(e.currentTarget.open)}><summary><span>{activityLabel[item.type]||'任务活动'}</span><span className="activity-excerpt">{item.text.slice(0,90).split('\n')[0]}</span></summary>{open&&<><pre>{item.text}</pre>{item.files?.map(path=><button className="file-link" key={path} onClick={()=>openFile(path)}><Icon name="file" size={15}/>{name(path)}</button>)}</>}</details>;
});
function UserMessage({text,editReason,disabled,blocked,copy,resend,children}:{text:string;editReason:string;disabled:boolean;blocked:(reason:string)=>void;copy:()=>void;resend:(text:string)=>Promise<void>;children:ReactNode}){
  const [editing,setEditing]=useState(false),[draft,setDraft]=useState(text);
  const submitting=useRef(false);
  return <div className="user-entry">{editing?<form className="edit-message" onSubmit={e=>{e.preventDefault();if(!draft.trim()||submitting.current)return;submitting.current=true;void resend(draft).finally(()=>{submitting.current=false;});}}>
    <textarea aria-label="编辑消息" autoFocus value={draft} onChange={e=>setDraft(e.target.value)} disabled={disabled} rows={4}/>
    <p>将覆盖这条消息及后续聊天；原附件会保留，文件改动不会撤销。</p>
    <div><button type="button" disabled={disabled} onClick={()=>setEditing(false)}>取消</button><button className="primary" disabled={disabled||!draft.trim()}>重发</button></div>
  </form>:<>
    <article className="message user">{children}</article>
    {text&&<div className="user-actions">
      <IconButton icon="copy" label="复制消息文字" onClick={copy}/>
      <IconButton icon="edit" label={editReason||'编辑并重发消息'} disabled={disabled} onClick={()=>{if(editReason){blocked(editReason);return;}setDraft(text);setEditing(true);}}/>
    </div>}
  </>}</div>;
}
