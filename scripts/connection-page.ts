export function connectionPage(config:any,qr:string,codexVersion:string) {
  const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  const ownToken=String(config.token||'').startsWith('cnt_');
  const link=new URL(config.relayUrl);if(!ownToken)link.hash=new URLSearchParams({token:config.token}).toString();
  const local=JSON.stringify({relayUrl:config.relayUrl,token:ownToken?'':config.token,machineId:config.machineId,ownToken}).replace(/</g,'\\u003c');
  return `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Codex 随行 · 电脑状态</title>
<style>*{box-sizing:border-box}body{font:16px/1.6 system-ui;color:#171717;background:#fafafa;max-width:560px;margin:5vh auto;padding:24px}h1{font-size:28px;font-weight:550}section{background:white;border:1px solid #eee;border-radius:24px;padding:24px;margin:18px 0}img{display:block;width:280px;max-width:100%;margin:auto}a{color:inherit}code{display:block;word-break:break-all;padding:12px;background:#f5f5f5;border-radius:12px}small,p{color:#666}.status{color:#171717;font-weight:550}button{border:1px solid #ddd;border-radius:30px;background:white;font:inherit;padding:8px 18px;cursor:pointer}li{overflow-wrap:anywhere}</style>
<h1>在手机或浏览器使用这台电脑</h1><section><div id="status" class="status" role="status">${ownToken?'已配置为团队电脑节点':'正在检查连接…'}</div><p id="detail">${ownToken?'这台电脑使用团队专用 Token 连接中继。请打开托盘窗口查看实时状态；团队成员请使用管理员发送的邀请链接登录网页。':'电脑保持开机并联网，手机或任意浏览器即可查看和指挥 Codex、Claude Code 与 Antigravity 的任务。'}</p><small>${escape(codexVersion)}</small>${ownToken?'':'<p><button id="retry">重新检查</button></p>'}</section>
<section>${ownToken?'<p>团队模式下不生成带 Token 的扫码链接，成员请通过管理员邀请链接登录。</p>':`<img alt="手机连接二维码" src="${qr}"><p>${config.mode==='connector'?'手机扫描二维码，连接自己的中继。':'手机和电脑连接同一 Wi-Fi 后扫描二维码。'}</p>`}<p><a href="${escape(link.href)}">${ownToken?'打开团队网页 ↗':'在电脑打开网页 ↗'}</a></p><p>中继：${escape(config.relayUrl)}</p>${ownToken?'':`<details><summary>手工连接 Token</summary><code>${escape(config.token)}</code></details>`}</section>
<section>自动接入电脑 Codex 的全部项目和会话，无需逐个配置。<p>更改地址或 Token：先完成任务，再从托盘图标菜单选择“连接设置…”（源码目录用 stop.cmd 和 configure.cmd）。电脑休眠或断网时无法远程操作。</p><small>${ownToken?'电脑专用 Token 仅用于这台电脑连接中继，不会暴露给网页或二维码。':'二维码包含连接凭证，请保留在自己的设备中。'}模型 Key 仍由电脑上的 Codex 管理。</small></section>
<script>
const config=${local};let socket,retry,poll,deadline,next=0,pending='';
const status=document.getElementById('status'),detail=document.getElementById('detail');
function show(title,message){status.textContent=title;detail.textContent=message;}
function readInfo(machines){
  if(!machines.some(m=>m.id===config.machineId)){show('中继已连接，等待这台电脑','请从托盘图标启动服务（源码目录运行 start.cmd）；若连接器未能启动，查看 .local/connector.error.log。');return;}
  if(pending)return;pending=String(++next);socket.send(JSON.stringify({type:'request',id:pending,machineId:config.machineId,action:'info',payload:{}}));
  deadline=setTimeout(()=>{pending='';show('电脑响应较慢','请确认本机 Codex 可以正常启动，稍后会重新检查。');},12000);
}
function connect(){
  if(config.ownToken)return;
  clearTimeout(retry);clearInterval(poll);clearTimeout(deadline);pending='';
  if(socket){socket.onclose=null;socket.close();}
  show('正在检查连接…','仅检查连接和模型信息，不会创建或打断任务。');
  const url=new URL('/ws',config.relayUrl);url.protocol=url.protocol==='https:'?'wss:':'ws:';
  const ws=new WebSocket(url);socket=ws;let machines=[];
  deadline=setTimeout(()=>ws.close(),10000);
  ws.onopen=()=>ws.send(JSON.stringify({type:'hello',role:'phone',token:config.token}));
  ws.onmessage=event=>{
    if(socket!==ws)return;
    const m=JSON.parse(event.data);
    if(m.type==='ready'){clearTimeout(deadline);machines=m.machines||[];readInfo(machines);poll=setInterval(()=>readInfo(machines),10000);}
    if(m.type==='machines'){machines=m.data||[];readInfo(machines);}
    if(m.type==='response'&&m.id===pending){clearTimeout(deadline);pending='';if(m.error){show('Codex 暂时无法读取',m.error.message||'请在电脑检查 Codex 配置。');return;}
      const info=m.result;show('电脑已连接，可以扫码', '模型：'+(info.model||'沿用 Codex 配置')+' · '+info.provider+'。'+(info.desktopOnline?'官方桌面已连接。':'官方桌面未打开，可从手机开始新任务。'));
    }
  };
  ws.onclose=event=>{clearTimeout(deadline);clearInterval(poll);pending='';if(event.code===4401){show('已启用团队模式，或 Token 不匹配','团队模式下手机不能用共享 Token 登录，请向管理员获取邀请链接；本机运行状态请在托盘窗口查看。');return;}
    show('暂时无法连接中继','请检查中继是否启动、地址和网络是否可达；电脑 IP 改变后需要重新配置。');retry=setTimeout(connect,5000);
  };
  ws.onerror=()=>{};
}
const retryBtn=document.getElementById('retry');if(retryBtn)retryBtn.onclick=connect;window.addEventListener('pagehide',()=>{clearTimeout(retry);clearInterval(poll);clearTimeout(deadline);if(socket){socket.onclose=null;socket.close();}});window.addEventListener('pageshow',event=>{if(event.persisted)connect();});connect();
</script></html>`;
}
