import {useRef,useState} from 'react';
import {Icon} from './icons';
import {Popover,type MenuPoint} from './popover';
import {isTeamAdmin,OwnerBadge,ROLE_LABELS,type OwnerFilter,type TeamUser} from './team';
import {defaultVoiceProvider,voiceProvider,voiceProviderLabel,type VoiceProvider} from '../src/shared/voice';
import {notifyHint,notifyLabel,toggleNotify,type NotifyState} from './turn-notify';
import {serviceLabel,type Service} from './services';

export type SidebarFooterProps={
  me:TeamUser|null;
  machineName:string;
  machinesCount:number;
  connected:boolean;
  relayOnline:boolean;
  busy?:boolean;
  archived?:boolean;
  onToggleArchived?:()=>void;
  onOpenSettings:()=>void;
  onOpenComputer:()=>void;
  onOpenTeam?:()=>void;
  onLogout:()=>void;
};

/**
 * Claude-style bottom-left account & settings entry in the sidebar.
 * Opens an upward categorized popover menu; pairs with MobileSettingsTrigger on compact screens.
 */
export function SidebarFooter({
  me,machineName,machinesCount,connected,relayOnline,busy=false,
  archived,onToggleArchived,
  onOpenSettings,onOpenComputer,onOpenTeam,onLogout,
}:SidebarFooterProps){
  const [point,setPoint]=useState<MenuPoint|null>(null);
  const trigger=useRef<HTMLButtonElement>(null);

  function openMenu(){
    const rect=trigger.current?.getBoundingClientRect();
    if(rect)setPoint({x:rect.left,y:rect.top});
  }

  return <div className="sidebar-footer">
    <button type="button" ref={trigger} className="sidebar-footer-btn" aria-haspopup="dialog" aria-expanded={Boolean(point)}
      aria-label={me?`${me.name} · 设置与账号`:'设置与连接'} onClick={openMenu}>
      {me?<OwnerBadge owner={me} size="md" title={me.name}/>:
        <span className="sidebar-footer-avatar"><Icon name="settings" size={15}/></span>}
      <span className="sidebar-footer-line">
        <strong>{me?me.name:'设置'}</strong>
        <span className="sidebar-footer-sep" aria-hidden="true">·</span>
        <i className={connected?'dot online':'dot'}/>
        <span className="sidebar-footer-machine">{machineName}</span>
      </span>
      <span className="sidebar-footer-chevron"><Icon name="chevron" size={14}/></span>
    </button>

    {point&&<SettingsPopover
      point={point}
      anchor={trigger.current}
      side="above"
      me={me}
      machineName={machineName}
      machinesCount={machinesCount}
      connected={connected}
      relayOnline={relayOnline}
      busy={busy}
      archived={archived}
      onToggleArchived={onToggleArchived}
      onOpenSettings={onOpenSettings}
      onOpenComputer={onOpenComputer}
      onOpenTeam={onOpenTeam}
      onLogout={onLogout}
      close={()=>setPoint(null)}
    />}
  </div>;
}

/** Compact top-right trigger shown only on mobile (<=760px) where the floating bottom dock occupies the bottom edge. */
export function MobileSettingsTrigger(props:SidebarFooterProps){
  const [point,setPoint]=useState<MenuPoint|null>(null);
  const trigger=useRef<HTMLButtonElement>(null);

  function openMenu(){
    const rect=trigger.current?.getBoundingClientRect();
    if(rect)setPoint({x:rect.right,y:rect.bottom+8,align:'end'});
  }

  return <>
    <button type="button" ref={trigger} className="mobile-settings-btn" aria-haspopup="dialog" aria-expanded={Boolean(point)}
      aria-label={props.me?`${props.me.name} · 设置`:'设置'} onClick={openMenu}>
      {props.me?<OwnerBadge owner={props.me} size="md" title={props.me.name}/>:<Icon name="settings" size={19}/>}
    </button>
    {point&&<SettingsPopover {...props} point={point} anchor={trigger.current} side="below" close={()=>setPoint(null)}/>}
  </>;
}

function SettingsPopover({
  point,anchor,side,me,machineName,machinesCount,connected,relayOnline,busy,
  archived,onToggleArchived,
  onOpenSettings,onOpenComputer,onOpenTeam,onLogout,close,
}:SidebarFooterProps&{point:MenuPoint;anchor:HTMLElement|null;side:'above'|'below';close:()=>void}){
  const run=(fn:()=>void)=>{close();fn();};
  return <Popover point={point} anchor={anchor} side={side} showHeader={false} title="设置" label="账号与设置菜单"
    className="settings-popover" focusSelector=".menu-item:not(:disabled)" close={close}>
    <div className="settings-popover-head">
      <div className="settings-popover-identity">
        {me?<OwnerBadge owner={me} size="md"/>:<span className="sidebar-footer-avatar"><Icon name="computer" size={16}/></span>}
        <div className="settings-popover-user">
          <strong>{me?me.name:'个人模式'}</strong>
          <small>{me?`${ROLE_LABELS[me.role]} · ${location.host}`:location.host}</small>
        </div>
      </div>
      <div className="settings-popover-status">
        <i className={connected?'dot online':'dot'}/>
        <span>{machineName}</span>
        <em>{connected?'已连接':relayOnline?'离线':'连接中…'}</em>
      </div>
    </div>

    <div className="menu-divider"/>

    <button type="button" className="menu-item" onClick={()=>run(onOpenSettings)}>
      <Icon name="settings" size={18}/>
      <span className="menu-copy">设置<kbd className="menu-shortcut">Ctrl+,</kbd></span>
    </button>
    <button type="button" className="menu-item" onClick={()=>run(onOpenComputer)}>
      <Icon name="computer" size={18}/>
      <span className="menu-copy">切换电脑<span className="menu-detail">{machinesCount>1?`${machinesCount} 台`:machineName}</span></span>
    </button>

    <div className="menu-divider"/>

    {onToggleArchived&&<button type="button" className="menu-item" disabled={!connected||busy} onClick={()=>run(onToggleArchived)}>
      <Icon name="archive" size={18}/>
      <span className="menu-copy">{archived?'返回最近会话':'查看归档会话'}{archived&&<Icon name="check" size={16}/>}</span>
    </button>}

    {me&&onOpenTeam&&<>
      <div className="menu-divider"/>
      <button type="button" className="menu-item" onClick={()=>run(onOpenTeam)}>
        <Icon name="team" size={18}/>
        <span className="menu-copy">{isTeamAdmin(me)?'团队管理':'我的设备与用量'}<span className="menu-detail">{ROLE_LABELS[me.role]}</span></span>
      </button>
    </>}

    <div className="menu-divider"/>

    <button type="button" className="menu-item danger" disabled={busy} onClick={()=>run(onLogout)}>
      <Icon name="logout" size={18}/>
      <span className="menu-copy">{me?'退出登录':'断开连接'}</span>
    </button>
  </Popover>;
}

export type SettingsSheetProps={
  service:Service;
  me:TeamUser|null;
  machineName:string;
  connected:boolean;
  relayOnline:boolean;
  voiceChoice:VoiceProvider;
  voiceMode:VoiceProvider;
  onVoiceChange:(next:VoiceProvider)=>void;
  notify:NotifyState;
  notifyMessage:string;
  onNotifyChange:(next:NotifyState,message:string)=>void;
  ownerFilter?:OwnerFilter;
  onOwnerFilterChange?:(next:OwnerFilter)=>void;
  archived?:boolean;
  onToggleArchived?:()=>void;
  onOpenComputer:()=>void;
  onOpenTeam?:()=>void;
  onLogout:()=>void;
  busy?:boolean;
};

/** Structured, categorized Settings modal replacing the old flat "选项" list. */
export function SettingsSheet({
  service,me,machineName,connected,relayOnline,
  voiceChoice,voiceMode,onVoiceChange,
  notify,notifyMessage,onNotifyChange,
  ownerFilter,onOwnerFilterChange,
  archived,onToggleArchived,
  onOpenComputer,onOpenTeam,onLogout,busy=false,
}:SettingsSheetProps){
  const nativeVoice=defaultVoiceProvider(service);
  const voiceOptionLabel=(provider:VoiceProvider)=>`${voiceProviderLabel(provider)}${provider===nativeVoice?'（推荐）':''}`;
  const voiceDesc=voiceChoice==='claude'?'实时流式识别，使用电脑上 Claude Code 的 claude.ai 登录（需 HTTPS）。'
    :voiceChoice==='antigravity'?'实时流式识别，使用本机 Antigravity 桌面语音服务（需 HTTPS）。'
    :voiceChoice==='codex'?'录音后整段识别，使用电脑上 Codex 的 ChatGPT 登录（需 HTTPS）。'
    :'点击麦克风后使用系统键盘听写。';

  return <div className="settings-sheet">
    <section className="settings-group">
      <h3>连接与电脑</h3>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-copy">
            <strong>当前电脑</strong>
            <small className="settings-machine-line"><i className={connected?'dot online':'dot'}/>{machineName} · {connected?'已连接':relayOnline?'离线':'连接中…'}</small>
          </div>
          <button type="button" className="settings-action-btn" onClick={onOpenComputer}>切换电脑</button>
        </div>
        <div className="settings-row">
          <div className="settings-row-copy">
            <strong>中继地址</strong>
            <small className="settings-mono">{location.origin}</small>
          </div>
        </div>
      </div>
    </section>

    <section className="settings-group">
      <h3>语音与通知</h3>
      <div className="settings-card">
        <div className="settings-row settings-row-stack">
          <div className="settings-row-head">
            <div className="settings-row-copy">
              <strong>语音输入</strong>
              <small>仅作用于 {serviceLabel(service)}，保存在当前浏览器</small>
            </div>
            <select aria-label="语音输入方式" className="settings-inline-select" value={voiceChoice}
              onChange={e=>onVoiceChange(voiceProvider(e.target.value,nativeVoice))}>
              <option value="claude">{voiceOptionLabel('claude')}</option>
              <option value="antigravity">{voiceOptionLabel('antigravity')}</option>
              <option value="codex">{voiceOptionLabel('codex')}</option>
              <option value="keyboard">{voiceOptionLabel('keyboard')}</option>
            </select>
          </div>
          <p className="settings-row-hint">{voiceDesc}</p>
          {voiceMode!==voiceChoice&&<p className="settings-row-hint">这台电脑暂不支持 {voiceProviderLabel(voiceChoice)}，当前改用 {voiceProviderLabel(voiceMode)}。</p>}
        </div>

        <div className="settings-row settings-row-stack">
          <div className="settings-row-head">
            <div className="settings-row-copy">
              <strong>完成通知</strong>
              <small>任务完成或需要审批时发送浏览器提醒</small>
            </div>
            <button type="button" className={`settings-toggle-pill${notify==='on'?' on':''}`} disabled={notify==='unsupported'}
              onClick={()=>void toggleNotify().then(next=>onNotifyChange(next,notifyHint[next]))}>
              {notifyLabel[notify]}
            </button>
          </div>
          {notifyMessage&&<p className="settings-row-hint" role="status">{notifyMessage}</p>}
        </div>
      </div>
    </section>

    {(me||onToggleArchived)&&<section className="settings-group">
      <h3>会话显示</h3>
      <div className="settings-card">
        {me&&onOwnerFilterChange&&<div className="settings-row">
          <div className="settings-row-copy">
            <strong>会话归属筛选</strong>
            <small>控制侧边栏默认显示的会话范围</small>
          </div>
          <select aria-label="会话归属筛选" className="settings-inline-select" value={ownerFilter==='mine'||ownerFilter==='local'?ownerFilter:'all'}
            onChange={e=>onOwnerFilterChange(e.target.value as OwnerFilter)}>
            <option value="all">全部会话</option>
            <option value="mine">只看我的会话</option>
            <option value="local">仅桌面端</option>
          </select>
        </div>}
        {onToggleArchived&&<div className="settings-row">
          <div className="settings-row-copy">
            <strong>归档会话</strong>
            <small>{archived?'当前正在浏览已归档的 Codex 会话':'切换查看已归档的 Codex 会话'}</small>
          </div>
          <button type="button" className={`settings-toggle-pill${archived?' on':''}`} disabled={!connected||busy} onClick={onToggleArchived}>
            {archived?'已开启':'查看归档'}
          </button>
        </div>}
      </div>
    </section>}

    <section className="settings-group">
      <h3>{me?'团队与账号':'连接管理'}</h3>
      <div className="settings-card">
        {me&&onOpenTeam&&<div className="settings-row">
          <div className="settings-row-copy">
            <strong>{me.name} · {ROLE_LABELS[me.role]}</strong>
            <small>{isTeamAdmin(me)?'管理团队成员、设备、电脑与用量':'管理我的已登录设备、查看用量与记录'}</small>
          </div>
          <button type="button" className="settings-action-btn" onClick={onOpenTeam}>打开团队</button>
        </div>}
        <div className="settings-row">
          <div className="settings-row-copy">
            <strong>{me?'退出登录':'断开连接'}</strong>
            <small>{me?'移除当前设备授权并返回登录页':'清除本地连接 Token 并返回连接页'}</small>
          </div>
          <button type="button" className="settings-action-btn danger" disabled={busy} onClick={onLogout}>
            {me?'退出登录':'断开连接'}
          </button>
        </div>
      </div>
    </section>
  </div>;
}
