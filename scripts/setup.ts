import {mkdir,writeFile,rename} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import QRCode from 'qrcode';
import {resolveCodex} from '../src/connector/app-server.js';
import {defaultRelay,prepareSettings,savedSettings} from './setup-config.js';
import {connectionPage} from './connection-page.js';

const args=process.argv.slice(2),value=(key:string)=>{const i=args.indexOf(key);return i>=0?args[i+1]:undefined;};
try {
  const dir=resolve('.local'),file=join(dir,'config.json'),old=await savedSettings(file);
  if(args.includes('--defaults')) {
    // Consumed through redirected stdout by the local Windows form, never written to logs.
    process.stdout.write(JSON.stringify({relayUrl:defaultRelay(),mode:'all',...old}));
  } else {
    let input:any={};
    if(args.includes('--settings-stdin')) {
      let json='';stdin.setEncoding('utf8');for await(const chunk of stdin){json+=chunk;if(json.length>64000)throw new Error('配置内容过大');}
      input=JSON.parse(json.replace(/^\uFEFF/,''));
    } else {
      input={relayUrl:value('--relay'),token:value('--token'),rotate:args.includes('--rotate'),mode:value('--mode')};
      if(!args.includes('--yes')&&!args.includes('--refresh-page')) {
        const prompt=createInterface({input:stdin,output:stdout});
        try {
          input.relayUrl=await prompt.question(`手机可访问的中继地址 [${input.relayUrl||old.relayUrl||defaultRelay()}]: `)||input.relayUrl;
        } finally {prompt.close();}
      }
    }
    const refresh=args.includes('--refresh-page');
    if(refresh&&(!old.token||!old.relayUrl))throw new Error('请先完成连接配置');
    const config=refresh?{...old,mode:old.mode||'all'}:await prepareSettings(input,old);
    let codexVersion='未识别本机 Codex；请先确认 Codex 在电脑上可用，或在配置窗口选择 codex.exe。';
    if(config.mode!=='relay') {
      try {const bin=resolveCodex(config.codexBin);codexVersion=execFileSync(bin,['--version'],{encoding:'utf8',timeout:10000,windowsHide:true,stdio:['ignore','pipe','ignore']}).trim().slice(0,100);}
      catch {throw new Error('未找到可用的 Codex。请先确认 Codex 在电脑上可以运行，或在配置窗口选择它的 codex.exe；不会自动安装或替换你的版本。');}
    }
    const link=new URL(config.relayUrl);link.hash=new URLSearchParams({token:config.token}).toString();
    const qr=await QRCode.toDataURL(link.href,{width:320,margin:2});
    await mkdir(dir,{recursive:true});
    await writeFile(join(dir,'connect-qr.png'),Buffer.from(qr.split(',')[1],'base64'));
    await writeFile(join(dir,'connect.html'),connectionPage(config,qr,codexVersion));
    if(!refresh){await writeFile(file+'.tmp',JSON.stringify(config,null,2)+'\n',{mode:0o600});await rename(file+'.tmp',file);}
    console.log(`${refresh?'连接页面已更新。':'配置已保存。'}${codexVersion}\n连接状态与二维码：${join(dir,'connect.html')}\n中继地址：${config.relayUrl}`);
  }
} catch(e:any) {console.error(e.message||'配置失败，未覆盖原配置');process.exitCode=1;}
