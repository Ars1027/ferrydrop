import test from 'node:test';
import {sign,generateKeyPairSync} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp,createUser} from '../apps/server/src/index.ts';
import {encodeChunk,decodeChunk,UPLOAD} from '../packages/protocol/src/index.ts';
import {Peer,enroll,login,hash} from './helpers.ts';
test('three accounts: consent, isolation, concurrent bidirectional delivery, integrity and cancellation',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ferrydrop-test-'));const app=await createApp({dataDir:dir,insecure:true,standardRate:16*1024*1024,vipRate:32*1024*1024});const peers:Peer[]=[];
 t.after(async()=>{peers.forEach(p=>p.close());await app.close();await rm(dir,{recursive:true,force:true});});
 for(const name of ['alice','bob','carol'])await createUser(dir,name,'correct horse battery staple');
 const url=await app.listen({host:'127.0.0.1',port:0});const devices=await Promise.all(['alice','bob','carol'].map(n=>enroll(url,n,'correct horse battery staple')));
 const [a,b,c]=await Promise.all(devices.map(d=>login(url,d)));peers.push(a,b,c);
 const guest=await new Peer(url).open();peers.push(guest);await assert.rejects(guest.rpc('STATE'));
  const challenge=await guest.rpc('AUTH_START',{deviceId:devices[0].deviceId});
 const wrong=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 await assert.rejects(guest.rpc('AUTH_PROOF',{challengeId:challenge.challengeId,signature:sign('sha256',Buffer.from(challenge.signingText),{key:wrong.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64')}));
 const challenge2=await guest.rpc('AUTH_START',{deviceId:devices[0].deviceId});
 const proof={challengeId:challenge2.challengeId,signature:sign('sha256',Buffer.from(challenge2.signingText),{key:devices[0].privateKey,dsaEncoding:'ieee-p1363'}).toString('base64')};
 await guest.rpc('AUTH_PROOF',proof);await assert.rejects(guest.rpc('AUTH_PROOF',proof));
 const room=await a.rpc('ROOM_CREATE');await b.rpc('ROOM_JOIN',{code:room.code});await a.rpc('ROOM_DECIDE',{roomId:room.id,deviceId:devices[1].deviceId,accept:true});
 async function offer(sender:Peer,receiver:number,data:Buffer){return sender.rpc('FILE_OFFER',{roomId:room.id,receiverId:devices[receiver].deviceId,name:'中文-../../file.bin',size:data.length,sha256:hash(data)});}
 const payload=Buffer.from('binary\u0000content'.repeat(4000));const offered=await offer(a,1,payload);
 await assert.rejects(a.rpc('UPLOAD_CREDIT',{transferId:offered.id,bytes:payload.length}));
 await assert.rejects(c.rpc('RESUME_QUERY',{transferId:offered.id}));await assert.rejects(c.rpc('CANCEL',{transferId:offered.id}));
 assert.equal((await c.rpc('STATE')).transfers.length,0);
 await b.rpc('FILE_DECIDE',{transferId:offered.id,accept:true});
 async function deliver(sender:Peer,receiver:Peer,transfer:any,data:Buffer){
  if(data.length){const credit=await sender.rpc('UPLOAD_CREDIT',{transferId:transfer.id,bytes:data.length});assert.equal(credit.offset,0);assert.ok(credit.bytes>=data.length);sender.ws.send(encodeChunk(UPLOAD,transfer.id,0,data));await sender.wait(()=>sender.events.find(e=>e.type==='ACK'&&e.body.transferId===transfer.id&&e.body.offset===data.length));}
  assert.equal((await sender.rpc('UPLOAD_FINISH',{transferId:transfer.id})).status,'ready');
  if(data.length){await receiver.rpc('DOWNLOAD_CHUNK',{transferId:transfer.id,offset:0,maxBytes:data.length});const frame=decodeChunk(await receiver.wait(()=>receiver.binary.shift()));assert.equal(frame.transferId,transfer.id);assert.deepEqual(Buffer.from(frame.payload),data);}
  assert.equal((await receiver.rpc('RECEIVED',{transferId:transfer.id,sha256:hash(data)})).status,'cleaned');
 }
 const reverse=await offer(b,0,Buffer.from('reverse'));await a.rpc('FILE_DECIDE',{transferId:reverse.id,accept:true});
 await Promise.all([deliver(a,b,offered,payload),deliver(b,a,reverse,Buffer.from('reverse'))]);
 const empty=await offer(a,1,Buffer.alloc(0));await b.rpc('FILE_DECIDE',{transferId:empty.id,accept:true});await deliver(a,b,empty,Buffer.alloc(0));
 const cancelled=await offer(a,1,payload);assert.equal((await b.rpc('CANCEL',{transferId:cancelled.id})).status,'cancelled');await assert.rejects(a.rpc('UPLOAD_CREDIT',{transferId:cancelled.id,bytes:1}));
 assert.ok((await a.rpc('HEARTBEAT')).time);
});

