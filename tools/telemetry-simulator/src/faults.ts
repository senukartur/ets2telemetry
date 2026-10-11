import {MAX_FRAME_BYTES,encodeFrame,type ServerMessage} from '../../../packages/contracts/src/protocol-v0';
export type Fault='malformed-json'|'oversized'|'missing-field'|'partial-eof'|'duplicate'|'wrong-unit';
/** Deliberately invalid test bytes; never bypass the production encoder for valid messages. */
export function faultBytes(fault:Fault,message:ServerMessage):Uint8Array {
  if(fault==='oversized') {const header=new Uint8Array(4);new DataView(header.buffer).setUint32(0,MAX_FRAME_BYTES+1,true);return header;}
  const valid=encodeFrame(message);
  if(fault==='partial-eof') return valid.slice(0,-1);
  if(fault==='duplicate') return Uint8Array.from([...valid,...valid]);
  const obj=structuredClone(message) as unknown as Record<string,unknown>;
  if(fault==='missing-field') delete obj.capture;
  if(fault==='wrong-unit') {if(message.kind!=='snapshot'&&message.kind!=='checkpoint') throw new Error('State message required');(obj.data as {state:{speed:{unit:string}}}).state.speed.unit='km/h';}
  const bytes=new TextEncoder().encode(fault==='malformed-json' ? '{"kind":' : JSON.stringify(obj));
  const result=new Uint8Array(4+bytes.length);new DataView(result.buffer).setUint32(0,bytes.length,true);result.set(bytes,4);return result;
}
