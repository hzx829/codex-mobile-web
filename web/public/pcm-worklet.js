// Turns the microphone into 16 kHz 16-bit mono PCM for streamed dictation, posted about every 100 ms.
// The context runs at the device's own rate; each output sample averages the input samples it covers.
const RATE=16000,FRAME=1600;
class Pcm16k extends AudioWorkletProcessor{
  constructor(){
    super();
    this.step=sampleRate/RATE;this.pos=0;this.sum=0;this.count=0;
    this.out=new Int16Array(FRAME);this.length=0;
    this.port.onmessage=event=>{if(event.data==='flush'){this.post();this.port.postMessage('flushed');}};
  }
  post(){
    if(!this.length)return;
    const chunk=this.out.slice(0,this.length);this.length=0;
    this.port.postMessage(chunk.buffer,[chunk.buffer]);
  }
  process(inputs){
    const channel=inputs[0]&&inputs[0][0];
    if(!channel)return true;
    for(let i=0;i<channel.length;i++){
      this.sum+=channel[i];this.count++;this.pos++;
      if(this.pos<this.step)continue;
      this.pos-=this.step;
      const value=Math.max(-1,Math.min(1,this.sum/this.count));this.sum=0;this.count=0;
      this.out[this.length++]=value<0?value*0x8000:value*0x7fff;
      if(this.length===FRAME)this.post();
    }
    return true;
  }
}
registerProcessor('pcm-16k',Pcm16k);
