import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {encodeChunk,decodeChunk,UPLOAD,CHUNK_SIZE} from '../packages/protocol/src/index.ts';
test('binary framing boundaries and hostile headers',()=>{
 const id=randomUUID(), frame=encodeChunk(UPLOAD,id,0x102030405,new Uint8Array([0,255]));
 assert.equal(frame.length,34); assert.equal(new DataView(frame.buffer).getBigUint64(20),0x102030405n);
 assert.deepEqual(decodeChunk(frame),{type:UPLOAD,transferId:id,offset:0x102030405,payload:new Uint8Array([0,255])});
 assert.equal(decodeChunk(encodeChunk(UPLOAD,id,Number.MAX_SAFE_INTEGER,new Uint8Array(CHUNK_SIZE))).payload.length,CHUNK_SIZE);
 for(const n of [-1,0.5,Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>encodeChunk(UPLOAD,id,n,new Uint8Array()));
 assert.throws(()=>encodeChunk(UPLOAD,id,0,new Uint8Array(CHUNK_SIZE+1)));
 for(const n of [0,1,20,31]) assert.throws(()=>decodeChunk(frame.subarray(0,n)));
 for(const [p,v] of [[0,2],[1,9],[2,1],[31,3]]){const bad=frame.slice();bad[p]=v;assert.throws(()=>decodeChunk(bad));}
 const bad=frame.slice();new DataView(bad.buffer).setBigUint64(20,2n**53n);assert.throws(()=>decodeChunk(bad));
 const padded=new Uint8Array(frame.length+10);padded.set(frame,5);assert.equal(decodeChunk(padded.subarray(5,-5)).transferId,id);
});
