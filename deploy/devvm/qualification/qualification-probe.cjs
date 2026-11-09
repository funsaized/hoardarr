const fs=require('fs'),net=require('net'),dgram=require('dgram');
const root=process.argv[2];
let stopped=false;
process.on('SIGTERM',()=>{stopped=true});
async function tcp(){return await new Promise(resolve=>{let done=false;const s=net.connect({host:'1.1.1.1',port:443});const finish=v=>{if(done)return;done=true;s.destroy();resolve(v)};s.setTimeout(500,()=>finish(false));s.on('connect',()=>finish(true));s.on('error',()=>finish(false));});}
(async()=>{while(!stopped){let phase='unknown';try{phase=fs.readFileSync(root+'/phase','utf8').trim()}catch{}const ok=await tcp();const s=dgram.createSocket('udp4');s.on('error',()=>s.close());s.send(Buffer.from('000101000001000000000000076578616d706c6503636f6d0000010001','hex'),53,'1.1.1.1',()=>s.close());fs.appendFileSync(root+'/probes.jsonl',JSON.stringify({time:Date.now(),phase,tcpConnected:ok})+'\n');await new Promise(r=>setTimeout(r,150));}})();
