import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
const ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const MAX_CLIENTS=16, ROOM_TTL_MS=43200000;
const hash=v=>createHash('sha256').update(v).digest();
const token=n=>[...randomBytes(n)].map(x=>ALPHABET[x%ALPHABET.length]).join('');
export const normalizeCode=v=>String(v??'').trim().toUpperCase().replace(/[^A-Z2-9]/g,'');
export const createRoomCode=()=>`${token(5)}-${token(8)}`;
export class RoomStore{
 #rooms=new Map();
 create(owner,now=Date.now()){let code;do code=createRoomCode();while(this.#rooms.has(normalizeCode(code)));const key=normalizeCode(code),room={id:randomUUID(),code,verifier:hash(key),expiresAt:now+ROOM_TTL_MS,ownerId:owner.id,clients:new Map()};this.#rooms.set(key,room);this.add(room,owner);return room}
 join(code,client,now=Date.now()){const key=normalizeCode(code),room=this.#rooms.get(key),candidate=hash(key);if(!room||room.expiresAt<=now||room.verifier.length!==candidate.length||!timingSafeEqual(room.verifier,candidate))return null;if(room.clients.size>=MAX_CLIENTS)throw Error('room_full');this.add(room,client);return room}
 add(room,client){room.clients.set(client.id,{...client,virtualIp:`100.82.45.${room.clients.size+1}`,joinedAt:Date.now()})}
 leave(id){for(const[key,room]of this.#rooms){if(!room.clients.delete(id))continue;if(room.ownerId===id||!room.clients.size)this.#rooms.delete(key);return room}return null}
 roomFor(id){return[...this.#rooms.values()].find(r=>r.clients.has(id))??null}
 cleanup(now=Date.now()){for(const[key,room]of this.#rooms)if(room.expiresAt<=now)this.#rooms.delete(key)}
}
export const publicRoom=(room,selfId)=>({code:room.code,expiresAt:room.expiresAt,peers:[...room.clients.values()].map(({id,name,virtualIp,joinedAt})=>({id,name,virtualIp,joinedAt,self:id===selfId,host:id===room.ownerId}))});
