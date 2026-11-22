import {IconButton} from './icon-button';
import {voiceProviderLabel,type VoiceProvider} from '../src/shared/voice';
import type {VoiceState} from './voice-input';

export type Voice={state:VoiceState;start:()=>void;stop:()=>void;cancel:()=>void};

/** The composer's microphone, beside the send button; a red tick while it listens, tap it when done speaking. */
export function VoiceButton({voice,mode,connected,disabled,starting}:{voice:Voice;mode:VoiceProvider;connected:boolean;disabled:boolean;starting:()=>void}){
  const recording=voice.state==='recording';
  return <IconButton icon={recording?'check':'mic'} className={recording?'recording round':''}
    label={recording?'说完了':voice.state==='transcribing'?'正在识别':voice.state==='starting'?'正在请求麦克风':`语音输入：${voiceProviderLabel(mode)}`}
    disabled={disabled||voice.state==='starting'||voice.state==='transcribing'||mode==='codex'&&!connected}
    onClick={()=>{if(recording)voice.stop();else{starting();voice.start();}}}/>;
}

/** What the microphone is doing, with a way to stop listening; nothing while idle. Text already in the draft stays. */
export function VoiceStatus({voice}:{voice:Voice}){
  if(voice.state==='idle')return null;
  return <div className="voice-status" role="status"><span>{voice.state==='starting'?'正在请求麦克风…':voice.state==='recording'?'正在听 · 边说边出字，可随时修改，说完点 ✓':'正在识别最后一段…'}</span><button type="button" onClick={voice.cancel}>取消</button></div>;
}
