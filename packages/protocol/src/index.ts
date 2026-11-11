export const VERSION = 1;
export const HEADER_SIZE = 32;
export const CHUNK_SIZE = 256 * 1024;
export const UPLOAD = 1;
export const DOWNLOAD = 2;
export interface Message {
  v: 1;
  id?: string;
  type: string;
  body: any;
}
export type Tier = "standard" | "vip";
export interface User {
  id: string;
  username: string;
  tier: Tier;
  admin: boolean;
  rate: number;
}
export interface Device {
  id: string;
  name: string;
  userId: string;
  username: string;
  online: boolean;
}
export interface Room {
  id: string;
  code: string;
  ownerId: string;
  expiresAt: number;
  members: Device[];
  pending: Device[];
  closed: boolean;
}
export type TransferStatus =
  | "offered"
  | "uploading"
  | "ready"
  | "downloading"
  | "received"
  | "cleaned"
  | "cancelled"
  | "expired"
  | "failed";
export interface Transfer {
  id: string;
  roomId: string;
  senderId: string;
  receiverId: string;
  name: string;
  size: number;
  sha256: string;
  offset: number;
  status: TransferStatus;
  createdAt: number;
  expiresAt: number;
  cleanedAt?: number;
  error?: string;
}
export interface Snapshot {
  user: User;
  deviceId: string;
  devices: Device[];
  rooms: Room[];
  transfers: Transfer[];
  limits: { maxFileSize: number; chunkSize: number };
}
export function encodeChunk(
  type: number,
  transferId: string,
  offset: number,
  payload: Uint8Array,
): Uint8Array {
  if (
    ![UPLOAD, DOWNLOAD].includes(type) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    payload.byteLength > CHUNK_SIZE ||
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
      transferId,
    )
  )
    throw new Error("Invalid chunk");
  const out = new Uint8Array(HEADER_SIZE + payload.byteLength),
    view = new DataView(out.buffer);
  out[0] = VERSION;
  out[1] = type;
  const hex = transferId.replaceAll("-", "");
  for (let i = 0; i < 16; i++)
    out[4 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  view.setBigUint64(20, BigInt(offset));
  view.setUint32(28, payload.byteLength);
  out.set(payload, HEADER_SIZE);
  return out;
}
export function decodeChunk(input: Uint8Array): {
  type: number;
  transferId: string;
  offset: number;
  payload: Uint8Array;
} {
  if (input.byteLength < HEADER_SIZE) throw new Error("Truncated chunk header");
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (
    input[0] !== VERSION ||
    ![UPLOAD, DOWNLOAD].includes(input[1]) ||
    view.getUint16(2) !== 0
  )
    throw new Error("Unsupported chunk header");
  const length = view.getUint32(28),
    offset = view.getBigUint64(20);
  if (
    length > CHUNK_SIZE ||
    length !== input.byteLength - HEADER_SIZE ||
    offset > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error("Invalid chunk length/offset");
  const hex = Array.from(input.subarray(4, 20), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return {
    type: input[1],
    transferId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    offset: Number(offset),
    payload: input.subarray(HEADER_SIZE),
  };
}
