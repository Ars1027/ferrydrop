import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createApp,createUser} from '../apps/server/src/index.ts';
import {encodeChunk,decodeChunk,UPLOAD} from '../packages/protocol/src/index.ts';
import {Peer,enroll,login,hash} from './helpers.ts';
async function fixture(t:any,rate=16*1024*1024){
 const dataDir=await mkdtemp(join(tmpdir(),'ferrydrop-recovery-'));let app:any;const peers:Peer[]=[];
 const start=async()=>{app=await createApp({dataDir,insecure:true,standardRate:rate,vipRate:rate*4});return app.listen({host:'127.0.0.1',port:0});};
 let url=await start();for(const name of ['sender','receiver'])await createUser(dataDir,name,'long integration password');
 const devices=await Promise.all(['sender','receiver'].map(n=>enroll(url,n,'long integration password')));
 const connect=async(i:number)=>{const p=await login(url,devices[i]);peers.push(p);return p;};
 t.after(async()=>{peers.forEach(p=>p.close());await app.close();await rm(dataDir,{recursive:true,force:true});});
 const sender=await connect(0),receiver=await connect(1);const room=await sender.rpc('ROOM_CREATE');await receiver.rpc('ROOM_JOIN',{code:room.code});await sender.rpc('ROOM_DECIDE',{roomId:room.id,deviceId:devices[1].deviceId,accept:true});
 const offer=async(data:Buffer,sha256=hash(data))=>{const transfer=await sender.rpc('FILE_OFFER',{roomId:room.id,receiverId:devices[1].deviceId,name:'resume.bin',size:data.length,sha256});await receiver.rpc('FILE_DECIDE',{transferId:transfer.id,accept:true});return transfer;};
 return {dataDir,sender,receiver,connect,offer,restart:async()=>{peers.forEach(p=>p.close());await app.close();url=await start();return Promise.all([connect(0),connect(1)]);}};
}
async function upload(p:Peer,id:string,offset:number,data:Buffer){const credit=await p.rpc('UPLOAD_CREDIT',{transferId:id,bytes:data.length});assert.equal(credit.offset,offset);assert.equal(credit.bytes,data.length);p.ws.send(encodeChunk(UPLOAD,id,offset,data));await p.wait(()=>p.events.find(e=>e.type==='ACK'&&e.body.transferId===id&&e.body.offset===offset+data.length));}
test('ACKed prefix survives reconnect and server restart; resumed download reconstructs exact content',async t=>{
 const f=await fixture(t);const data=Buffer.from('recovery\u0000'.repeat(10000));const transfer=await f.offer(data);const split=34000;
 await upload(f.sender,transfer.id,0,data.subarray(0,split));const [sender,receiver]=await f.restart();
 assert.equal((await sender.rpc('RESUME_QUERY',{transferId:transfer.id})).offset,split);
 await upload(sender,transfer.id,split,data.subarray(split));await sender.rpc('UPLOAD_FINISH',{transferId:transfer.id});
 const read=async(p:Peer,offset:number,maxBytes:number)=>{await p.rpc('DOWNLOAD_CHUNK',{transferId:transfer.id,offset,maxBytes});return decodeChunk(await p.wait(()=>p.binary.shift()));};
 const first=await read(receiver,0,split);receiver.close();const reconnected=await f.connect(1);const second=await read(reconnected,split,data.length-split);
 assert.equal(second.offset,split);assert.deepEqual(Buffer.concat([Buffer.from(first.payload),Buffer.from(second.payload)]),data);
 assert.equal((await reconnected.rpc('RECEIVED',{transferId:transfer.id,sha256:hash(data)})).status,'cleaned');assert.equal((await readdir(join(f.dataDir,'files'))).length,0);
});
test('wrong hash fails delivery and deletes staged bytes',async t=>{
 const f=await fixture(t),data=Buffer.from('bad hash');const transfer=await f.offer(data,'0'.repeat(64));await upload(f.sender,transfer.id,0,data);
 await assert.rejects(f.sender.rpc('UPLOAD_FINISH',{transferId:transfer.id}),(error:any)=>error.code==='HASH_MISMATCH');
 assert.equal((await f.sender.rpc('RESUME_QUERY',{transferId:transfer.id})).status,'failed');await assert.rejects(f.receiver.rpc('DOWNLOAD_CHUNK',{transferId:transfer.id,offset:0,maxBytes:10}));assert.equal((await readdir(join(f.dataDir,'files'))).length,0);
});
test('upload reservations aggregate across two connections of one account while heartbeat stays responsive',async t=>{
 const rate=32768,f=await fixture(t,rate),second=await f.connect(0);const data=Buffer.alloc(rate);const transfers=await Promise.all([f.offer(data),f.offer(data),f.offer(data)]);const started=performance.now();
 const requests=transfers.map((tr,i)=>(i%2?second:f.sender).rpc('UPLOAD_CREDIT',{transferId:tr.id,bytes:data.length}));
 assert.ok((await f.sender.rpc('HEARTBEAT')).time);await Promise.all(requests);
 assert.ok(performance.now()-started>=1700,'three one-second reservations across connections must share the user budget');
 await Promise.all(transfers.map(tr=>f.receiver.rpc('CANCEL',{transferId:tr.id})));
});

