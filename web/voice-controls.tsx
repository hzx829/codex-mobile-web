import {IconButton} from './icon-button';
import {voiceProviderLabel,type VoiceProvider} from '../src/shared/voice';
import type {VoiceState} from './voice-input';

type Voice={state:VoiceState;start:()=>void;stop:()=>void;cancel:()=>void};

/** The composer's microphone, beside the send button; red while recording, tap again to stop and transcribe. */
export function VoiceButton({voice,mode,connected,disabled,starting}:{voice:Voice;mode:VoiceProvider;connected:boolean;disabled:boolean;starting:()=>void}){
  const recording=voice.state==='recording';
  return <IconButton icon={recording?'stop':'mic'} className={recording?'recording round':''}
    label={recording?'结束录音并识别':voice.state==='transcribing'?'正在识别':voice.state==='starting'?'正在请求麦克风':`语音输入：${voiceProviderLabel(mode)}`}
    disabled={disabled||voice.state==='starting'||voice.state==='transcribing'||mode==='codex'&&!connected}
    onClick={()=>{if(recording)voice.stop();else{starting();voice.start();}}}/>;
}

/** What the microphone is doing, with a way to cancel; nothing while idle. */
export function VoiceStatus({voice}:{voice:Voice}){
  if(voice.state==='idle')return null;
  return <div className="voice-status" role="status"><span>{voice.state==='starting'?'正在请求麦克风…':voice.state==='recording'?'录音中 · 最长 2 分钟':'正在识别…'}</span><button type="button" onClick={voice.cancel}>取消</button></div>;
}
