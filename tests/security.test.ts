import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {createApp,createUser} from '../apps/server/src/index.ts';
import {encodeChunk,UPLOAD} from '../packages/protocol/src/index.ts';
import {Peer,enroll,login,hash} from './helpers.ts';
test('security boundaries, revocation, room expiry and retained file cleanup',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'ferrydrop-security-'));const app=await createApp({dataDir,insecure:true,maxFileSize:1024,roomTtlMs:1500,retentionMs:2200});const peers:Peer[]=[];
 t.after(async()=>{peers.forEach(p=>p.close());await app.close();await rm(dataDir,{recursive:true,force:true});});
 await createUser(dataDir,'owner','strong integration password');await createUser(dataDir,'member','strong integration password');const url=await app.listen({host:'127.0.0.1',port:0});
 for(const [username,password] of [["' OR 1=1 --",'x'],['owner',"' OR 1=1 --"]]){const res=await fetch(url+'/api/enroll',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password,deviceName:'injection',publicJwk:{}})});assert.equal(res.ok,false);}
 const bad=new WebSocket(url.replace('http:','ws:')+'/ws','ferrydrop.v1',{origin:'http://attacker.invalid'});const closed=await new Promise<number>((resolve,reject)=>{bad.once('close',resolve);bad.once('error',reject);});assert.equal(closed,1008);
 const d1=await enroll(url,'owner','strong integration password'),d2=await enroll(url,'member','strong integration password');const a=await login(url,d1),b=await login(url,d2);peers.push(a,b);
 await assert.rejects(b.rpc('ADMIN_USERS'));await assert.rejects(b.rpc('ADMIN_TIER',{userId:'unknown',tier:'vip'}));
 const room=await a.rpc('ROOM_CREATE');await b.rpc('ROOM_JOIN',{code:room.code});await a.rpc('ROOM_DECIDE',{roomId:room.id,deviceId:d2.deviceId,accept:true});const data=Buffer.from('retained payload');
 const offer=(size:number,name='../../escaped.bin')=>a.rpc('FILE_OFFER',{roomId:room.id,receiverId:d2.deviceId,name,size,sha256:hash(data)});
 await assert.rejects(offer(1025));const transfer=await offer(data.length);await b.rpc('FILE_DECIDE',{transferId:transfer.id,accept:true});await a.rpc('UPLOAD_CREDIT',{transferId:transfer.id,bytes:data.length});a.ws.send(encodeChunk(UPLOAD,transfer.id,0,data));await a.wait(()=>a.events.find(e=>e.type==='ACK'&&e.body.transferId===transfer.id));
 assert.deepEqual(await readdir(join(dataDir,'files')),[transfer.id]);await assert.rejects(stat(join(dataDir,'escaped.bin')));
 await new Promise(r=>setTimeout(r,1550));await assert.rejects(offer(1));await assert.rejects(b.rpc('ROOM_JOIN',{code:room.code}));assert.equal((await a.rpc('RESUME_QUERY',{transferId:transfer.id})).offset,data.length);
 const revoked=await enroll(url,'member','strong integration password');await b.rpc('DEVICE_REVOKE',{deviceId:revoked.deviceId,password:'strong integration password'});const guest=await new Peer(url).open();peers.push(guest);await assert.rejects(guest.rpc('AUTH_START',{deviceId:revoked.deviceId}));
 const oversized=await new Peer(url).open();peers.push(oversized);const tooLargeClosed=new Promise<number>(resolve=>oversized.ws.once('close',resolve));oversized.ws.send(Buffer.alloc(256*1024+33));assert.ok([1006,1009].includes(await tooLargeClosed));
 await new Promise(r=>setTimeout(r,800));await assert.rejects(a.rpc('RESUME_QUERY',{transferId:transfer.id}));
 await new Promise(r=>setTimeout(r,13500));assert.equal((await readdir(join(dataDir,'files'))).length,0);
});

