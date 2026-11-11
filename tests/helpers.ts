import WebSocket from 'ws';
import {randomUUID,generateKeyPairSync,sign,createHash} from 'node:crypto';
export const hash=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
export class Peer {
 ws:WebSocket; pending=new Map<string,any>(); events:any[]=[]; binary:Buffer[]=[];
 constructor(url:string){this.ws=new WebSocket(url.replace('http:','ws:')+'/ws','ferrydrop.v1',{origin:url});this.ws.on('message',(data,binary)=>{if(binary){this.binary.push(Buffer.from(data as any));return;}const m=JSON.parse(data.toString());const p=this.pending.get(m.id);if(p){clearTimeout(p.timer);this.pending.delete(m.id);m.type==='ERROR'?p.reject(Object.assign(new Error(m.body.message),{code:m.body.code})):p.resolve(m.body);}else this.events.push(m);});}
 async open(){await new Promise<void>((resolve,reject)=>{this.ws.once('open',resolve);this.ws.once('error',reject);});return this;}
 rpc(type:string,body:any={}){return new Promise<any>((resolve,reject)=>{const id=randomUUID();const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('RPC timeout '+type));},8000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({v:1,id,type,body}));});}
 async wait(predicate:()=>any){const deadline=Date.now()+8000;while(Date.now()<deadline){const found=predicate();if(found)return found;await new Promise(r=>setTimeout(r,10));}throw new Error('event timeout');}
 close(){this.ws.terminate();}
}
export async function enroll(url:string,username:string,password:string){const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const res=await fetch(url+'/api/enroll',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password,deviceName:username,publicJwk:keys.publicKey.export({format:'jwk'})})});if(!res.ok)throw new Error('enroll '+res.status);return {...await res.json() as any,privateKey:keys.privateKey};}
export async function login(url:string,device:any){const peer=await new Peer(url).open();const c=await peer.rpc('AUTH_START',{deviceId:device.deviceId});const signature=sign('sha256',Buffer.from(c.signingText),{key:device.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');await peer.rpc('AUTH_PROOF',{challengeId:c.challengeId,signature});return peer;}
