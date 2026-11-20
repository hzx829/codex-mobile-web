import {IconButton} from './icon-button';
import type {QueuedMessage} from '../src/shared/types';

type Props={
  messages:QueuedMessage[];
  /** No action is possible now (offline, another operation in flight). */
  disabled:boolean;
  /** A turn is running that a queued message can join. */
  canSteer:boolean;
  /** Withdrawing is paused, e.g. while the composer is busy with attachments or voice. */
  withdrawBlocked?:boolean;
  /** Withdrawing this message would overfill the composer's attachments. */
  attachmentsFull:(message:QueuedMessage)=>boolean;
  onSteer:(id:string)=>void;onWithdraw:(id:string)=>void;onCancel:(id:string)=>void;
  /** Sends the message at once, interrupting the reply; only runtimes that can do so pass it. */
  onNow?:(id:string)=>void;
};

/** Messages waiting on the computer for the running turn to end; each can join the turn, return to the composer or be deleted. */
export function QueuedMessages({messages,disabled,canSteer,withdrawBlocked,attachmentsFull,onSteer,onWithdraw,onCancel,onNow}:Props){
  if(!messages.length)return null;
  return <div className="queued-messages" aria-label="待发送消息">
    <div className="queue-heading">完成后发送 <span>{messages.length}</span></div>
    {messages.map((message,index)=>{
      const off=disabled||message.state==='sending',full=attachmentsFull(message);
      const confirmUncertain=()=>message.state!=='uncertain'||window.confirm('请先核实这条消息是否已经发送。移出后，后续排队消息会继续发送。');
      return <div className="queued-message" key={message.id}>
        <div className="queued-content"><small>{message.state==='queued'?`排队 ${index+1}`:message.state==='sending'?'正在发送':message.state==='uncertain'?'结果待核实':'发送失败'}{message.imageCount>0?` · ${message.imageCount} 张图片`:''}{message.fileNames?.length?` · ${message.fileNames.length} 个文件`:''}</small><p title={[message.text,...message.fileNames||[]].join('\n')}>{message.text||message.fileNames?.join('、')||'图片消息'}</p>{message.error&&<small className="error">{message.error}；后续消息已暂停，请核实后移出。</small>}</div>
        <div className="queued-actions">
          {onNow&&<IconButton icon="now" label="立即发送（可转后台的工作转入后台，否则打断当前回复；沿用当前任务设置）" disabled={off||!canSteer||message.state!=='queued'} onClick={()=>onNow(message.id)}/>}
          <IconButton icon="steer" label="立即追加到当前任务（Steer，沿用当前任务设置）" disabled={off||!canSteer||message.state!=='queued'} onClick={()=>onSteer(message.id)}/>
          <IconButton icon="undo" label={full?'输入框附件已满，请先处理草稿':'撤回到输入框'} disabled={off||Boolean(withdrawBlocked)||full} onClick={()=>{if(confirmUncertain())onWithdraw(message.id);}}/>
          <IconButton icon="trash" label="删除排队消息" disabled={off} onClick={()=>{if(confirmUncertain())onCancel(message.id);}}/>
        </div>
      </div>;
    })}
  </div>;
}
