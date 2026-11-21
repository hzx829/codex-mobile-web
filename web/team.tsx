import {useEffect,useState,type ReactNode} from 'react';
import type {Json} from '../src/shared/types';
import {relativeTime} from './thread-menu';
import {UsagePanel} from './usage';

export type TeamRole='owner'|'admin'|'member';
export type TeamUser={id:string;name:string;role:TeamRole};
export type TeamCall=(action:`team.${string}`,payload?:Json)=>Promise<any>;
type Tab='mine'|'members'|'machines'|'usage'|'activity';

export const ROLE_LABELS:Record<TeamRole,string>={owner:'所有者',admin:'管理员',member:'成员'};
const isAdmin=(user:TeamUser)=>user.role==='owner'||user.role==='admin';
const ACTION_LABELS:Record<string,string>={
  'session.create':'新建会话','claude.create':'新建会话','antigravity.create':'新建会话',
  'turn.send':'发送消息','claude.send':'发送消息','antigravity.send':'发送消息',
  'turn.steerQueued':'立即追加','claude.steerQueued':'立即追加','turn.withdrawQueued':'撤回排队消息','claude.withdrawQueued':'撤回排队消息',
  'turn.cancelQueued':'删除排队消息','claude.cancelQueued':'删除排队消息','turn.edit':'编辑消息','claude.edit':'编辑消息',
  'turn.stop':'停止任务','claude.stop':'停止任务','antigravity.stop':'停止任务','request.respond':'回应请求','claude.respond':'回应请求',
  'session.fork':'分叉会话','claude.fork':'分叉会话','session.rename':'重命名','claude.rename':'重命名',
  'session.archive':'归档','claude.archive':'归档','session.unarchive':'取消归档','session.resume':'恢复会话',
  'project.create':'新建项目','claude.project.save':'保存项目设置','runtime.reload':'更新连接器',
};
const SERVICE_LABELS:Record<string,string>={codex:'Codex',claude:'Claude Code',antigravity:'Antigravity'};
const STATE_LABELS:Record<string,string>={accepted:'',failed:'失败',uncertain:'待核实',queued:'已排队'};
const message=(error:unknown)=>(error as {message?:string})?.message||'操作失败，请重试';
const inviteLink=(code:string)=>`${location.origin}/#invite=${code}`;
const ago=(at:number)=>{const text=relativeTime(at);return text==='刚刚'?text:`${text}前`;};
const expires=(at:number)=>new Date(at).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});

/** An invite link with its QR code, shown once; the relay keeps only its hash. */
function Invite({code,expiresAt,name,copy}:{code:string;expiresAt:number;name:string;copy:(text:string)=>Promise<void>}){
  const link=inviteLink(code),[qr,setQr]=useState(''),[copied,setCopied]=useState(false);
  useEffect(()=>{let alive=true;void import('qrcode').then(module=>module.toDataURL(link,{margin:1,width:220})).then(url=>{if(alive)setQr(url);}).catch(()=>{});return()=>{alive=false;};},[link]);
  return <div className="team-invite">
    <p>请 {name} 在手机或电脑浏览器打开这个链接或扫码登录。只能用一次，{expires(expiresAt)} 前有效。</p>
    {qr&&<img src={qr} width={220} height={220} alt="邀请二维码"/>}
    <input readOnly value={link} onFocus={e=>e.currentTarget.select()} aria-label="邀请链接"/>
    <button type="button" className="primary" onClick={()=>void copy(link).then(()=>setCopied(true)).catch(()=>{})}>{copied?'已复制':'复制链接'}</button>
  </div>;
}

function Section({title,children,action}:{title:string;children:ReactNode;action?:ReactNode}){
  return <section className="team-section"><div className="team-section-head"><h3>{title}</h3>{action}</div>{children}</section>;
}

function Devices({team,me,logout,copy}:{team:TeamCall;me:TeamUser;logout:()=>void;copy:(text:string)=>Promise<void>}){
  const [devices,setDevices]=useState<Json[]|null>(null),[invite,setInvite]=useState<Json|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const load=()=>team('team.devices.list').then(result=>setDevices(result.devices),failure=>setError(message(failure)));
  useEffect(()=>{void load();},[]);
  async function run(action:()=>Promise<void>){if(busy)return;setBusy(true);setError('');try{await action();}catch(failure){setError(message(failure));}finally{setBusy(false);}}
  return <Section title="我的设备" action={<button type="button" className="text-button" disabled={busy} onClick={()=>void run(async()=>setInvite(await team('team.devices.invite')))}>添加设备</button>}>
    {invite&&<Invite code={invite.code} expiresAt={invite.expiresAt} name="你" copy={copy}/>}
    {!devices&&!error&&<div className="list-skeleton" role="status" aria-label="正在读取设备"><div/><div/></div>}
    {devices?.map(device=><div className="team-row" key={device.id}>
      <span><b>{device.name}</b>{device.current&&<em>当前设备</em>}<small>{device.lastSeenAt?`${ago(device.lastSeenAt)}使用`:'未使用'}</small></span>
      {device.current?<button type="button" className="text-button danger" onClick={logout}>退出登录</button>:
        <button type="button" className="text-button danger" disabled={busy} onClick={()=>{if(window.confirm(`移除「${device.name}」？该设备会立即退出。`))void run(async()=>{await team('team.devices.revoke',{deviceId:device.id});await load();});}}>移除</button>}
    </div>)}
    {error&&<p className="error" role="alert">{error}</p>}
    <p className="muted">{me.name} · {ROLE_LABELS[me.role]}</p>
  </Section>;
}

function MachineScope({value,machines,change}:{value:'all'|string[];machines:Json[];change:(value:'all'|string[])=>void}){
  return <fieldset className="team-scope"><legend>可用电脑</legend>
    <label className="check"><input type="checkbox" checked={value==='all'} onChange={e=>change(e.target.checked?'all':[])}/>全部电脑，包括以后连接的</label>
    {value!=='all'&&machines.map(machine=><label className="check" key={machine.id}><input type="checkbox" checked={value.includes(machine.id)}
      onChange={e=>change(e.target.checked?[...value,machine.id]:value.filter(id=>id!==machine.id))}/>{machine.name}</label>)}
    {value!=='all'&&!machines.length&&<p className="muted">还没有电脑连接过中继。</p>}
  </fieldset>;
}

function Members({team,me,copy}:{team:TeamCall;me:TeamUser;copy:(text:string)=>Promise<void>}){
  const [members,setMembers]=useState<Json[]|null>(null),[machines,setMachines]=useState<Json[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [adding,setAdding]=useState(false),[name,setName]=useState(''),[role,setRole]=useState<TeamRole>('member'),[scope,setScope]=useState<'all'|string[]>('all');
  const [invite,setInvite]=useState<{code:string;expiresAt:number;name:string}|null>(null),[editing,setEditing]=useState<Json|null>(null);
  const load=()=>Promise.all([team('team.members.list'),team('team.machines.list')]).then(([list,known])=>{setMembers(list.members);setMachines(known.machines);},failure=>setError(message(failure)));
  useEffect(()=>{void load();},[]);
  async function run(action:()=>Promise<void>){if(busy)return;setBusy(true);setError('');try{await action();await load();}catch(failure){setError(message(failure));}finally{setBusy(false);}}
  const roles=(me.role==='owner'?['member','admin','owner']:['member','admin']) as TeamRole[];
  const manageable=(member:Json)=>me.role==='owner'||member.role!=='owner';
  if(editing)return <Section title={`编辑 ${editing.name}`}>
    <form onSubmit={e=>{e.preventDefault();void run(async()=>{await team('team.members.update',{userId:editing.id,name:editing.name,role:editing.role,machines:editing.allMachines?'all':editing.machines});setEditing(null);});}}>
      <label>名字<input required maxLength={40} value={editing.name} onChange={e=>setEditing({...editing,name:e.target.value})}/></label>
      <label>角色<select value={editing.role} onChange={e=>setEditing({...editing,role:e.target.value})}>{roles.map(item=><option key={item} value={item}>{ROLE_LABELS[item]}</option>)}</select></label>
      {editing.role==='member'&&<MachineScope value={editing.allMachines?'all':editing.machines} machines={machines} change={value=>setEditing({...editing,allMachines:value==='all',machines:value==='all'?[]:value})}/>}
      {error&&<p className="error" role="alert">{error}</p>}
      <div className="team-actions"><button type="button" onClick={()=>{setEditing(null);setError('');}}>取消</button><button className="primary" disabled={busy}>保存</button></div>
    </form>
  </Section>;
  return <Section title="成员" action={!adding&&<button type="button" className="text-button" onClick={()=>{setAdding(true);setInvite(null);}}>添加成员</button>}>
    {invite&&<Invite {...invite} copy={copy}/>}
    {adding&&<form className="team-form" onSubmit={e=>{e.preventDefault();void run(async()=>{
      const result=await team('team.members.create',{name,role,machines:role==='member'?scope:'all'});
      setInvite({...result.invite,name:result.user.name});setAdding(false);setName('');setRole('member');setScope('all');});}}>
      <label>名字<input autoFocus required maxLength={40} value={name} onChange={e=>setName(e.target.value)} placeholder="例如 张三"/></label>
      <label>角色<select value={role} onChange={e=>setRole(e.target.value as TeamRole)}>{roles.map(item=><option key={item} value={item}>{ROLE_LABELS[item]}</option>)}</select></label>
      {role==='member'&&<MachineScope value={scope} machines={machines} change={setScope}/>}
      <div className="team-actions"><button type="button" onClick={()=>setAdding(false)}>取消</button><button className="primary" disabled={busy||!name.trim()}>添加并生成邀请</button></div>
    </form>}
    {!members&&!error&&<div className="list-skeleton" role="status" aria-label="正在读取成员"><div/><div/></div>}
    {members?.map(member=><div className={`team-row${member.status==='disabled'?' disabled':''}`} key={member.id}>
      <span><b>{member.name}</b><em>{ROLE_LABELS[member.role as TeamRole]}</em>{member.status==='disabled'&&<em>已停用</em>}
        <small>设备 {member.devices} 台{member.lastSeenAt?` · ${ago(member.lastSeenAt)}使用`:''}{member.role==='member'&&!member.allMachines?` · 可用 ${member.machines.length} 台电脑`:''}</small></span>
      {manageable(member)&&<span className="team-row-actions">
        {member.status==='active'&&<button type="button" className="text-button" disabled={busy} onClick={()=>void run(async()=>{const result=await team('team.invites.create',{userId:member.id});setInvite({...result,name:member.name});})}>邀请链接</button>}
        <button type="button" className="text-button" disabled={busy} onClick={()=>{setError('');setEditing({...member});}}>编辑</button>
        {member.id!==me.id&&<button type="button" className="text-button danger" disabled={busy} onClick={()=>{
          const disable=member.status==='active';
          if(!disable||window.confirm(`停用 ${member.name}？其所有设备会立即退出，记录保留。`))void run(async()=>{await team('team.members.update',{userId:member.id,status:disable?'disabled':'active'});});
        }}>{member.status==='active'?'停用':'恢复'}</button>}
      </span>}
    </div>)}
    {error&&!editing&&<p className="error" role="alert">{error}</p>}
  </Section>;
}

function Machines({team,copy}:{team:TeamCall;copy:(text:string)=>Promise<void>}){
  const [machines,setMachines]=useState<Json[]|null>(null),[token,setToken]=useState<{machine:string;token:string}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[copied,setCopied]=useState(false);
  const load=()=>team('team.machines.list').then(result=>setMachines(result.machines),failure=>setError(message(failure)));
  useEffect(()=>{void load();},[]);
  async function run(action:()=>Promise<void>){if(busy)return;setBusy(true);setError('');try{await action();await load();}catch(failure){setError(message(failure));}finally{setBusy(false);}}
  return <Section title="电脑">
    {token&&<div className="team-invite">
      <p>{token.machine} 的专用 Token 只显示这一次。请在这台电脑的“修改连接配置”里把 Token 换成它。之后共享 Token 不能再连接这台电脑。</p>
      <input readOnly value={token.token} onFocus={e=>e.currentTarget.select()} aria-label="电脑专用 Token"/>
      <button type="button" className="primary" onClick={()=>void copy(token.token).then(()=>setCopied(true)).catch(()=>{})}>{copied?'已复制':'复制 Token'}</button>
    </div>}
    {!machines&&!error&&<div className="list-skeleton" role="status" aria-label="正在读取电脑"><div/><div/></div>}
    {machines?.map(machine=><div className="team-row" key={machine.id}>
      <span><b><i className={machine.online?'dot online':'dot'}/>{machine.name}</b><small>{machine.ownToken?'专用 Token':'共享 Token'}{!machine.online&&machine.lastSeenAt?` · ${ago(machine.lastSeenAt)}在线`:''}</small></span>
      <span className="team-row-actions">
        <button type="button" className="text-button" disabled={busy} onClick={()=>{if(!machine.ownToken||window.confirm('生成新 Token 后，这台电脑现在的专用 Token 会失效。继续？'))void run(async()=>{setCopied(false);setToken({machine:machine.name,token:(await team('team.machines.token',{machineId:machine.id})).token});});}}>{machine.ownToken?'更换 Token':'生成专用 Token'}</button>
        {machine.ownToken&&<button type="button" className="text-button danger" disabled={busy} onClick={()=>{if(window.confirm('撤销后这台电脑重新改用共享 Token 连接。继续？'))void run(async()=>{await team('team.machines.revokeToken',{machineId:machine.id});});}}>撤销</button>}
      </span>
    </div>)}
    {machines&&!machines.length&&<p className="muted">还没有电脑连接过中继。</p>}
    {error&&<p className="error" role="alert">{error}</p>}
  </Section>;
}

function Activity({team,admin,machines}:{team:TeamCall;admin:boolean;machines:Map<string,string>}){
  const [entries,setEntries]=useState<Json[]|null>(null),[more,setMore]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function load(before?:number){
    setBusy(true);setError('');
    try{const result=await team('team.activity',{before,limit:50});setEntries(old=>before?[...(old||[]),...result.entries]:result.entries);setMore(result.entries.length===50);}
    catch(failure){setError(message(failure));}finally{setBusy(false);}
  }
  useEffect(()=>{void load();},[]);
  return <Section title={admin?'操作记录':'我的操作记录'}>
    {!entries&&!error&&<div className="list-skeleton" role="status" aria-label="正在读取操作记录"><div/><div/><div/></div>}
    {entries?.map(entry=><div className="team-row activity" key={entry.id}>
      <span><b>{admin&&`${entry.userName} · `}{ACTION_LABELS[entry.action]||entry.action}{STATE_LABELS[entry.state]&&<em className={entry.state==='failed'?'danger':''}>{STATE_LABELS[entry.state]}</em>}</b>
        <small>{SERVICE_LABELS[entry.service]||entry.service} · {machines.get(entry.machineId)||entry.machineId}{entry.threadId?` · ${entry.threadId.slice(0,8)}`:''}</small></span>
      <time>{relativeTime(entry.ts)}</time>
    </div>)}
    {entries&&!entries.length&&<p className="muted">还没有记录。</p>}
    {error&&<p className="error" role="alert">{error}</p>}
    {more&&<button type="button" className="more-link" disabled={busy} onClick={()=>void load(entries?.at(-1)?.id)}>{busy?'正在加载…':'加载更多'}</button>}
  </Section>;
}

/** The team page: everyone manages their own devices and sees their usage and activity; admins also manage members and computers and see everyone's. */
export function TeamPanel({me,team,logout,copy,machines}:{me:TeamUser;team:TeamCall;logout:()=>void;copy:(text:string)=>Promise<void>;machines:Map<string,string>}){
  const admin=isAdmin(me),[tab,setTab]=useState<Tab>('mine');
  const tabs:[Tab,string][]=admin?[['mine','我的'],['members','成员'],['machines','电脑'],['usage','用量'],['activity','记录']]:[['mine','我的'],['usage','用量'],['activity','记录']];
  return <div className="team-panel">
    <div className="team-tabs" role="tablist">{tabs.map(([id,label])=><button type="button" role="tab" key={id} aria-selected={tab===id} className={tab===id?'selected':''} onClick={()=>setTab(id)}>{label}</button>)}</div>
    {tab==='mine'&&<Devices team={team} me={me} logout={logout} copy={copy}/>}
    {tab==='members'&&admin&&<Members team={team} me={me} copy={copy}/>}
    {tab==='machines'&&admin&&<Machines team={team} copy={copy}/>}
    {tab==='usage'&&<UsagePanel team={team} admin={admin}/>}
    {tab==='activity'&&<Activity team={team} admin={admin} machines={machines}/>}
  </div>;
}

/** The first letter or character of a member's name, shown on the sessions they started. */
export function OwnerBadge({owner}:{owner:{id:string;name:string}|null|undefined}){
  if(!owner)return null;
  return <span className="owner-badge" title={`由 ${owner.name} 创建`} aria-label={`由 ${owner.name} 创建`}>{Array.from(owner.name.trim())[0]?.toUpperCase()||'?'}</span>;
}
