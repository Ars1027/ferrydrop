import {
  decodeChunk,
  encodeChunk,
  UPLOAD,
  type Snapshot,
} from "@ferrydrop/protocol";
import { get, put, type Identity } from "./storage";
type Waiter<T> = { resolve: (v: T) => void; reject: (e: Error) => void };
export class Client {
  ws?: WebSocket;
  state?: Snapshot;
  onstate = (s: Snapshot | undefined) => {};
  onstatus = (s: string) => {};
  pending = new Map<string, Waiter<any>>();
  acks = new Map<string, Waiter<number>>();
  chunks = new Map<string, Waiter<ReturnType<typeof decodeChunk>>>();
  retry = 0;
  timer?: ReturnType<typeof setInterval>;
  reconnect?: ReturnType<typeof setTimeout>;
  connecting = false;
  stopped = false;
  clearWaiters() {
    const error = new Error("连接已中断，请继续传输");
    for (const map of [this.pending, this.acks, this.chunks]) {
      for (const waiter of map.values()) waiter.reject(error);
      map.clear();
    }
  }
  async forget() {
    this.stopped = true;
    clearTimeout(this.reconnect);
    clearInterval(this.timer);
    const old = this.ws;
    this.ws = undefined;
    old?.close();
    this.clearWaiters();
    await put("identity", undefined);
    this.state = undefined;
    this.onstate(undefined);
    this.onstatus("请重新登记设备");
  }
  async connect() {
    if (this.connecting || (this.ws && this.ws.readyState < 2)) return;
    this.connecting = true;
    clearTimeout(this.reconnect);
    let identity: Identity | undefined;
    try {
      identity = await get<Identity>("identity");
    } catch (e) {
      this.onstatus("无法读取设备身份，请重新登记");
      this.connecting = false;
      return;
    }
    if (!identity?.privateKey) {
      this.onstatus("请登记设备");
      this.connecting = false;
      return;
    }
    this.stopped = false;
    this.onstatus("正在连接");
    const ws = (this.ws = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
      "ferrydrop.v1",
    ));
    ws.binaryType = "arraybuffer";
    this.connecting = false;
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      try {
        if (e.data instanceof ArrayBuffer) {
          const c = decodeChunk(new Uint8Array(e.data));
          this.chunks.get(c.transferId)?.resolve(c);
          return;
        }
        const m = JSON.parse(e.data);
        if (m.id) {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.type === "ERROR"
            ? p?.reject(
                Object.assign(new Error(m.body.message), { code: m.body.code }),
              )
            : p?.resolve(m.body);
        } else if (m.type === "STATE") {
          this.state = m.body;
          this.onstate(m.body);
        } else if (m.type === "ACK") {
          this.acks.get(m.body.transferId)?.resolve(m.body.offset);
        }
      } catch (e) {
        this.onstatus(String(e));
      }
    };
    ws.onopen = async () => {
      try {
        const c = await this.rpc("AUTH_START", {
          deviceId: identity!.deviceId,
        });
        const signature = await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          identity!.privateKey,
          new TextEncoder().encode(c.signingText),
        );
        const s = await this.rpc("AUTH_PROOF", {
          challengeId: c.challengeId,
          signature: btoa(String.fromCharCode(...new Uint8Array(signature))),
        });
        if (this.ws !== ws) return;
        this.state = s;
        this.onstate(s);
        this.retry = 0;
        this.onstatus("已连接");
        clearInterval(this.timer);
        this.timer = setInterval(() => {
          if (this.ws === ws) this.rpc("HEARTBEAT").catch(() => ws.close());
        }, 20000);
      } catch (e) {
        if (this.ws !== ws) return;
        if (ws.readyState === WebSocket.OPEN) {
          this.stopped = true;
          this.state = undefined;
          this.onstate(undefined);
          this.onstatus(`认证失败，请重新登记：${String(e)}`);
        }
        ws.close();
      }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      clearInterval(this.timer);
      this.clearWaiters();
      if (this.stopped) return;
      if (e.code === 1008) {
        this.stopped = true;
        this.state = undefined;
        this.onstate(undefined);
        this.onstatus("设备访问已失效，请重新登记");
        return;
      }
      this.onstatus("连接中断，正在重连");
      this.reconnect = setTimeout(
        () => this.connect(),
        Math.min(30000, 1000 * 2 ** this.retry++),
      );
    };
  }
  rpc(type: string, body: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== 1) return reject(new Error("请等待连接恢复"));
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("请求超时，请重试"));
      }, 45000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ v: 1, id, type, body }));
    });
  }
  async upload(id: string, offset: number, data: Uint8Array) {
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.acks.delete(id);
        reject(new Error("确认超时，请继续传输"));
      }, 45000);
      this.acks.set(id, {
        resolve: (n) => {
          clearTimeout(timer);
          this.acks.delete(id);
          resolve(n);
        },
        reject: (e) => {
          clearTimeout(timer);
          this.acks.delete(id);
          reject(e);
        },
      });
      try {
        if (this.ws?.readyState !== 1) throw Error("连接已中断");
        this.ws.send(encodeChunk(UPLOAD, id, offset, data));
      } catch (e) {
        this.acks.get(id)?.reject(e as Error);
      }
    });
  }
  async download(id: string, offset: number, maxBytes: number) {
    let timeout: ReturnType<typeof setTimeout>;
    const frame = new Promise<ReturnType<typeof decodeChunk>>(
      (resolve, reject) => {
        this.chunks.set(id, { resolve, reject });
        timeout = setTimeout(
          () => reject(new Error("接收超时，请继续传输")),
          45000,
        );
      },
    );
    try {
      const [chunk] = await Promise.all([
        frame,
        this.rpc("DOWNLOAD_CHUNK", { transferId: id, offset, maxBytes }),
      ]);
      return chunk;
    } finally {
      clearTimeout(timeout!);
      this.chunks.delete(id);
    }
  }
}
export const client = new Client();
export function hash(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./hash.worker.ts", import.meta.url), {
      type: "module",
    });
    w.onmessage = (e) => {
      w.terminate();
      e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.hash);
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message));
    };
    w.postMessage(file);
  });
}
