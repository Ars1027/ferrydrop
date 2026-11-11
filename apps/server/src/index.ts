import Fastify from "fastify";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import { DatabaseSync } from "node:sqlite";
import {
  randomUUID,
  randomInt,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createPublicKey,
  verify,
  createHash,
} from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import type { WebSocket } from "ws";
const CHUNK = 262144;
type Row = any;
function database(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dir, "ferrydrop.sqlite"));
  db.exec(
    `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE, salt TEXT, hash TEXT, tier TEXT, admin INTEGER); CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,userId TEXT,name TEXT,jwk TEXT,revoked INTEGER DEFAULT 0); CREATE TABLE IF NOT EXISTS state(id TEXT PRIMARY KEY,kind TEXT,json TEXT);`,
  );
  return db;
}
export function createUser(
  dir: string,
  username: string,
  password: string,
  tier = "standard",
  admin = false,
) {
  if (
    !username ||
    username.length > 80 ||
    password.length < 10 ||
    password.length > 256 ||
    !["standard", "vip"].includes(tier)
  )
    throw Error("Username, password (10-256 characters), or tier invalid");
  const db = database(dir),
    salt = randomBytes(16).toString("hex"),
    id = randomUUID();
  try {
    db.prepare("INSERT INTO users VALUES(?,?,?,?,?,?)").run(
      id,
      username,
      salt,
      scryptSync(password, salt, 64).toString("hex"),
      tier,
      admin ? 1 : 0,
    );
    return id;
  } finally {
    db.close();
  }
}
export interface Options {
  dataDir: string;
  host?: string;
  port?: number;
  insecure?: boolean;
  certPath?: string;
  keyPath?: string;
  webRoot?: string;
  standardRate?: number;
  vipRate?: number;
  maxFileSize?: number;
  retentionMs?: number;
  roomTtlMs?: number;
}
export async function createApp(o: Options) {
  if (
    o.insecure &&
    !["localhost", "127.0.0.1", "::1"].includes(o.host ?? "127.0.0.1")
  )
    throw Error("Insecure mode requires localhost");
  if (!o.insecure && (!o.certPath || !o.keyPath))
    throw Error("Configure TLS_CERT and TLS_KEY");
  const app = Fastify({
    logger: false,
    bodyLimit: 16384,
    ...(!o.insecure
      ? {
          https: {
            cert: fs.readFileSync(o.certPath!),
            key: fs.readFileSync(o.keyPath!),
          },
        }
      : {}),
  });
  const db = database(o.dataDir),
    files = path.join(o.dataDir, "files");
  fs.mkdirSync(files, { recursive: true, mode: 0o700 });
  const rooms = new Map<string, Row>(),
    transfers = new Map<string, Row>(),
    sessions = new Set<Row>(),
    credits = new Map<string, Row>(),
    buckets = new Map<string, number>();
  for (const r of db.prepare("SELECT * FROM state").all() as Row[])
    (r.kind === "room" ? rooms : transfers).set(r.id, JSON.parse(r.json));
  const save = (kind: string, r: Row) =>
    db
      .prepare("INSERT OR REPLACE INTO state VALUES(?,?,?)")
      .run(r.id, kind, JSON.stringify(r));
  const file = (id: string) => path.join(files, id);
  for (const t of transfers.values()) {
    if (["uploading", "ready", "downloading"].includes(t.status)) {
      try {
        const n = fs.statSync(file(t.id)).size;
        if (n < t.offset) {
          t.status = "failed";
          t.error = "Stored file incomplete";
        } else fs.truncateSync(file(t.id), t.offset);
      } catch {
        if (t.offset) t.status = "failed";
      }
      save("transfer", t);
    }
  }
  const user = (id: string) =>
    db.prepare("SELECT * FROM users WHERE id=?").get(id) as Row;
  const device = (id: string) =>
    db.prepare("SELECT * FROM devices WHERE id=? AND revoked=0").get(id) as Row;
  const rate = (u: Row) =>
    u.tier === "vip" ? (o.vipRate ?? 4194304) : (o.standardRate ?? 1048576);
  const pubUser = (u: Row) => ({
    id: u.id,
    username: u.username,
    tier: u.tier,
    admin: !!u.admin,
    rate: rate(u),
  });
  const pubDevice = (id: string) => {
    const d = device(id);
    return d
      ? {
          id: d.id,
          name: d.name,
          userId: d.userId,
          username: user(d.userId).username,
          online: [...sessions].some((s) => s.deviceId === id),
        }
      : null;
  };
  const snapshot = (s: Row) => {
    const rs = [...rooms.values()].filter(
      (r) => r.members.includes(s.deviceId) || r.ownerId === s.deviceId,
    );
    return {
      user: pubUser(user(s.userId)),
      deviceId: s.deviceId,
      devices: [...new Set(rs.flatMap((r) => r.members).concat(s.deviceId))]
        .map(pubDevice)
        .filter(Boolean),
      rooms: rs.map((r) => ({
        ...r,
        members: r.members.map(pubDevice).filter(Boolean),
        pending:
          r.ownerId === s.deviceId
            ? r.pending.map(pubDevice).filter(Boolean)
            : [],
      })),
      transfers: [...transfers.values()].filter((t) =>
        [t.senderId, t.receiverId].includes(s.deviceId),
      ),
      limits: { maxFileSize: o.maxFileSize ?? 268435456, chunkSize: CHUNK },
    };
  };
  const send = (s: Row, m: Row) => {
    if (s.ws.readyState === 1 && s.ws.bufferedAmount < 2 * 1024 * 1024)
      s.ws.send(JSON.stringify({ v: 1, ...m }));
    else s.ws.close();
  };
  let closing = false;
  const broadcast = () => {
    if (closing) return;
    for (const s of sessions)
      if (s.deviceId) send(s, { type: "STATE", body: snapshot(s) });
  };
  const password = (u: Row, p: any) =>
    typeof p === "string" &&
    p.length <= 256 &&
    u &&
    timingSafeEqual(Buffer.from(u.hash, "hex"), scryptSync(p, u.salt, 64));
  const cleanup = (t: Row) => {
    try {
      fs.rmSync(file(t.id), { force: true });
      if (t.status === "received") t.status = "cleaned";
      t.cleanedAt = Date.now();
      delete t.error;
    } catch {
      t.error = "Temporary file cleanup pending";
    }
    save("transfer", t);
  };
  const terminal = (t: Row, status: string) => {
    t.status = status;
    save("transfer", t);
    cleanup(t);
  };
  const removeRoom = (r: Row) => {
    // Persist invalidation first so startup can finish an interrupted close.
    r.closed = true;
    save("room", r);
    for (const t of transfers.values()) {
      if (
        t.roomId === r.id &&
        ["offered", "uploading", "ready", "downloading"].includes(t.status)
      )
        terminal(t, "cancelled");
    }
    db.prepare("DELETE FROM state WHERE kind=? AND id=?").run("room", r.id);
    rooms.delete(r.id);
  };
  // Remove closed rooms left by older versions; preserve transfer receipts.
  for (const r of rooms.values()) if (r.closed) removeRoom(r);
  const reserve = (uid: string, dir: string, n: number) => {
    const k = uid + dir,
      now = Date.now(),
      start = Math.max(now, buckets.get(k) ?? now);
    if (start - now > 30000) throw Error("RATE_LIMIT");
    buckets.set(k, start + (n / rate(user(uid))) * 1000);
    return Math.max(0, start - now);
  };
  await app.register(rateLimit, { max: 60, timeWindow: "1 minute" });
  await app.register(websocket, {
    options: {
      maxPayload: CHUNK + 32,
      perMessageDeflate: false,
      handleProtocols: (p) => (p.has("ferrydrop.v1") ? "ferrydrop.v1" : false),
    },
  });
  app.addHook("onSend", async (_q, r, p) => {
    r.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    r.header("X-Content-Type-Options", "nosniff");
    return p;
  });
  app.get("/api/health", async () => ({ ok: true }));
  app.post("/api/enroll", async (req, reply) => {
    try {
      const b = req.body as Row;
      if (
        !b ||
        typeof b.username !== "string" ||
        typeof b.deviceName !== "string" ||
        b.deviceName.length > 80
      )
        throw Error();
      const u = db
        .prepare("SELECT * FROM users WHERE username=?")
        .get(b.username) as Row;
      if (!password(u, b.password)) throw Error();
      if (
        (
          db
            .prepare(
              "SELECT count(*) n FROM devices WHERE userId=? AND revoked=0",
            )
            .get(u.id) as Row
        ).n >= 20
      )
        throw Error();
      if (
        b.publicJwk?.kty !== "EC" ||
        b.publicJwk.crv !== "P-256" ||
        b.publicJwk.d
      )
        throw Error();
      createPublicKey({ key: b.publicJwk, format: "jwk" });
      const id = randomUUID();
      db.prepare("INSERT INTO devices(id,userId,name,jwk) VALUES(?,?,?,?)").run(
        id,
        u.id,
        b.deviceName,
        JSON.stringify(b.publicJwk),
      );
      return { deviceId: id };
    } catch {
      return reply.code(400).send({ error: "Enrollment rejected" });
    }
  });
  app.get("/ws", { websocket: true }, (ws, req) => {
    const origin = req.headers.origin;
    if (
      origin !== `${o.insecure ? "http" : "https"}://${req.headers.host}` ||
      !req.headers["sec-websocket-protocol"]
        ?.split(",")
        .map((x) => x.trim())
        .includes("ferrydrop.v1") ||
      sessions.size >= 128
    ) {
      ws.close(1008);
      return;
    }
    const s: Row = { ws, alive: true, count: 0, window: Date.now(), busy: 0 };
    sessions.add(s);
    const authTimer = setTimeout(() => {
      if (!s.deviceId) ws.close(1008);
    }, 10000);
    ws.on("pong", () => (s.alive = true));
    ws.on("close", () => {
      clearTimeout(authTimer);
      sessions.delete(s);
      for (const [k, c] of credits) if (c.session === s) credits.delete(k);
      broadcast();
    });
    const access = (id: string) => {
      const t = transfers.get(id),
        r = t && rooms.get(t.roomId);
      if (
        !t ||
        ![t.senderId, t.receiverId].includes(s.deviceId) ||
        !r ||
        r.closed ||
        !r.members.includes(s.deviceId) ||
        t.expiresAt < Date.now()
      )
        throw Error("FORBIDDEN");
      return t;
    };
    ws.on("message", (data, binary) => {
      void (async () => {
        let id: string | undefined;
        let counted = false;
        try {
          if (Date.now() - s.window > 1000) {
            s.window = Date.now();
            s.count = 0;
          }
          if (++s.count > 80 || s.busy >= 16) throw Error("RATE_LIMIT");
          s.busy++;
          counted = true;
          if (binary) {
            if (closing) return;
            if (!s.deviceId || !device(s.deviceId))
              throw Error("AUTH_REQUIRED");
            const b = Buffer.from(data as any);
            if (
              b.length < 32 ||
              b[0] !== 1 ||
              b[1] !== 1 ||
              b.readUInt16BE(2) !== 0
            )
              throw Error("BAD_CHUNK");
            const hex = b.subarray(4, 20).toString("hex"),
              tid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
              off = Number(b.readBigUInt64BE(20)),
              n = b.readUInt32BE(28),
              t = access(tid),
              c = credits.get(tid);
            if (
              !c ||
              c.session !== s ||
              c.until < Date.now() ||
              n !== b.length - 32 ||
              n > c.bytes ||
              !n ||
              off !== t.offset ||
              s.deviceId !== t.senderId ||
              t.status !== "uploading"
            )
              throw Error("BAD_CREDIT");
            credits.delete(tid);
            const fd = fs.openSync(file(tid), "a", 0o600);
            try {
              const payload = b.subarray(32);
              let written = 0;
              while (written < payload.length) {
                const n = fs.writeSync(
                  fd,
                  payload,
                  written,
                  payload.length - written,
                );
                if (n <= 0) throw Error("STORAGE_ERROR");
                written += n;
              }
              fs.fsyncSync(fd);
            } finally {
              fs.closeSync(fd);
            }
            t.offset += n;
            save("transfer", t);
            send(s, {
              type: "ACK",
              body: { transferId: tid, offset: t.offset },
            });
            return;
          }
          if (Buffer.byteLength(data as any) > 16384)
            throw Error("MESSAGE_TOO_LARGE");
          const m = JSON.parse(data.toString());
          id = m.id;
          if (
            m.v !== 1 ||
            typeof id !== "string" ||
            id.length > 80 ||
            typeof m.type !== "string"
          )
            throw Error("BAD_MESSAGE");
          const b = m.body ?? {};
          let result: Row = {};
          if (m.type === "AUTH_START") {
            const d = device(b.deviceId);
            if (!d) throw Error("AUTH_FAILED");
            s.challenge = {
              id: randomUUID(),
              device: d,
              until: Date.now() + 30000,
              text: `FNP/1|${req.headers.host}|${d.userId}|${d.id}|${randomBytes(32).toString("hex")}|${Date.now() + 30000}`,
            };
            result = {
              challengeId: s.challenge.id,
              signingText: s.challenge.text,
            };
          } else if (m.type === "AUTH_PROOF") {
            const c = s.challenge;
            delete s.challenge;
            if (
              !c ||
              c.id !== b.challengeId ||
              c.until < Date.now() ||
              !device(c.device.id) ||
              !verify(
                "sha256",
                Buffer.from(c.text),
                {
                  key: createPublicKey({
                    key: JSON.parse(c.device.jwk),
                    format: "jwk",
                  }),
                  dsaEncoding: "ieee-p1363",
                },
                Buffer.from(b.signature, "base64"),
              )
            )
              throw Error("AUTH_FAILED");
            s.deviceId = c.device.id;
            s.userId = c.device.userId;
            result = snapshot(s);
          } else {
            if (!s.deviceId || !device(s.deviceId))
              throw Error("AUTH_REQUIRED");
            switch (m.type) {
              case "STATE":
                result = snapshot(s);
                break;
              case "HEARTBEAT":
                result = { time: Date.now() };
                break;
              case "ROOM_CREATE": {
                if (
                  [...rooms.values()].filter(
                    (r) =>
                      r.ownerId === s.deviceId &&
                      !r.closed &&
                      r.expiresAt > Date.now(),
                  ).length >= 8
                )
                  throw Error("ROOM_LIMIT");
                const r = {
                  id: randomUUID(),
                  code: String(randomInt(10000000, 100000000)),
                  ownerId: s.deviceId,
                  expiresAt: Date.now() + (o.roomTtlMs ?? 900000),
                  members: [s.deviceId],
                  pending: [],
                  closed: false,
                };
                rooms.set(r.id, r);
                save("room", r);
                result = { ...r, members: [pubDevice(s.deviceId)] };
                break;
              }
              case "ROOM_JOIN": {
                const r = [...rooms.values()].find(
                  (r) =>
                    r.code === b.code && !r.closed && r.expiresAt > Date.now(),
                );
                if (!r || r.pending.length >= 20)
                  throw Error("ROOM_UNAVAILABLE");
                if (
                  !r.members.includes(s.deviceId) &&
                  !r.pending.includes(s.deviceId)
                )
                  r.pending.push(s.deviceId);
                save("room", r);
                result = { roomId: r.id };
                break;
              }
              case "ROOM_DECIDE":
              case "MEMBER_REMOVE":
              case "ROOM_CLOSE": {
                const r = rooms.get(b.roomId);
                if (!r || r.ownerId !== s.deviceId || r.closed)
                  throw Error("FORBIDDEN");
                if (m.type === "ROOM_CLOSE") {
                  removeRoom(r);
                  break;
                } else if (m.type === "ROOM_DECIDE") {
                  if (
                    !r.pending.includes(b.deviceId) ||
                    r.expiresAt < Date.now()
                  )
                    throw Error("INVALID_MEMBER");
                  r.pending = r.pending.filter((x: string) => x !== b.deviceId);
                  if (b.accept) r.members.push(b.deviceId);
                } else {
                  if (b.deviceId === r.ownerId) throw Error("INVALID_MEMBER");
                  r.members = r.members.filter((x: string) => x !== b.deviceId);
                }
                save("room", r);
                for (const t of transfers.values())
                  if (
                    t.roomId === r.id &&
                    (r.closed ||
                      ([t.senderId, t.receiverId].includes(b.deviceId) &&
                        m.type === "MEMBER_REMOVE")) &&
                    !["cleaned", "cancelled", "expired"].includes(t.status)
                  )
                    terminal(t, "cancelled");
                break;
              }
              case "FILE_OFFER": {
                const r = rooms.get(b.roomId);
                if (
                  !r ||
                  r.closed ||
                  r.expiresAt < Date.now() ||
                  !r.members.includes(s.deviceId) ||
                  !r.members.includes(b.receiverId) ||
                  s.deviceId === b.receiverId ||
                  typeof b.name !== "string" ||
                  b.name.length < 1 ||
                  b.name.length > 255 ||
                  !Number.isSafeInteger(b.size) ||
                  b.size < 0 ||
                  b.size > (o.maxFileSize ?? 268435456) ||
                  !/^[a-f0-9]{64}$/.test(b.sha256)
                )
                  throw Error("INVALID_OFFER");
                const active = [...transfers.values()].filter(
                  (t) => !t.cleanedAt,
                );
                if (
                  active.length >= 512 ||
                  active.reduce((n, t) => n + t.size, 0) + b.size >
                    8 * 1024 ** 3 ||
                  active
                    .filter((t) => device(t.senderId)?.userId === s.userId)
                    .reduce((n, t) => n + t.size, 0) +
                    b.size >
                    2 * 1024 ** 3
                )
                  throw Error("STORAGE_QUOTA");
                const t = {
                  id: randomUUID(),
                  roomId: r.id,
                  senderId: s.deviceId,
                  receiverId: b.receiverId,
                  name: b.name,
                  size: b.size,
                  sha256: b.sha256,
                  offset: 0,
                  status: "offered",
                  createdAt: Date.now(),
                  expiresAt: Date.now() + (o.retentionMs ?? 86400000),
                };
                transfers.set(t.id, t);
                save("transfer", t);
                result = t;
                break;
              }
              case "FILE_DECIDE": {
                const t = access(b.transferId);
                if (t.receiverId !== s.deviceId || t.status !== "offered")
                  throw Error("INVALID_STATE");
                t.status = b.accept ? "uploading" : "cancelled";
                save("transfer", t);
                if (!b.accept) cleanup(t);
                result = t;
                break;
              }
              case "UPLOAD_CREDIT": {
                const t = access(b.transferId);
                if (
                  t.senderId !== s.deviceId ||
                  t.status !== "uploading" ||
                  !Number.isSafeInteger(b.bytes) ||
                  b.bytes < 1
                )
                  throw Error("INVALID_STATE");
                const old = credits.get(t.id);
                if (old && old.until > Date.now()) throw Error("CREDIT_EXISTS");
                const n = Math.min(CHUNK, b.bytes, t.size - t.offset);
                if (n <= 0) throw Error("COMPLETE");
                credits.set(t.id, {
                  session: s,
                  bytes: 0,
                  until: Date.now() + 60000,
                });
                let wait: number;
                try {
                  wait = reserve(s.userId, "up", n);
                } catch (e) {
                  credits.delete(t.id);
                  throw e;
                }
                await new Promise((r) => setTimeout(r, wait));
                if (!closing) access(t.id);
                if (!closing && !device(s.deviceId))
                  throw Error("AUTH_REQUIRED");
                if (closing || t.status !== "uploading" || ws.readyState !== 1)
                  throw Error("INVALID_STATE");
                credits.set(t.id, {
                  session: s,
                  bytes: n,
                  until: Date.now() + 30000,
                });
                result = { offset: t.offset, bytes: n };
                break;
              }
              case "UPLOAD_FINISH": {
                const t = access(b.transferId);
                if (
                  t.senderId !== s.deviceId ||
                  t.status !== "uploading" ||
                  t.offset !== t.size
                )
                  throw Error("INVALID_STATE");
                if (!fs.existsSync(file(t.id)))
                  fs.writeFileSync(file(t.id), "", { mode: 0o600 });
                const h = createHash("sha256");
                for await (const chunk of fs.createReadStream(file(t.id)))
                  h.update(chunk);
                if (h.digest("hex") !== t.sha256) {
                  terminal(t, "failed");
                  throw Error("HASH_MISMATCH");
                }
                if (closing) return;
                if (t.status !== "uploading") throw Error("INVALID_STATE");
                t.status = "ready";
                save("transfer", t);
                result = t;
                break;
              }
              case "DOWNLOAD_CHUNK": {
                const t = access(b.transferId);
                if (
                  t.receiverId !== s.deviceId ||
                  !["ready", "downloading"].includes(t.status) ||
                  !Number.isSafeInteger(b.offset) ||
                  b.offset < 0 ||
                  b.offset >= t.size ||
                  !Number.isSafeInteger(b.maxBytes) ||
                  b.maxBytes < 1
                )
                  throw Error("INVALID_STATE");
                const n = Math.min(CHUNK, b.maxBytes, t.size - b.offset);
                await new Promise((r) =>
                  setTimeout(r, reserve(s.userId, "down", n)),
                );
                if (closing) return;
                access(t.id);
                if (!["ready", "downloading"].includes(t.status))
                  throw Error("INVALID_STATE");
                const out = Buffer.alloc(32 + n);
                out[0] = 1;
                out[1] = 2;
                Buffer.from(t.id.replaceAll("-", ""), "hex").copy(out, 4);
                out.writeBigUInt64BE(BigInt(b.offset), 20);
                out.writeUInt32BE(n, 28);
                const fd = fs.openSync(file(t.id), "r");
                try {
                  if (fs.readSync(fd, out, 32, n, b.offset) !== n)
                    throw Error("STORAGE_ERROR");
                } finally {
                  fs.closeSync(fd);
                }
                if (ws.bufferedAmount > 2 * 1024 * 1024)
                  throw Error("BACKPRESSURE");
                ws.send(out);
                t.status = "downloading";
                save("transfer", t);
                result = { offset: b.offset, bytes: n };
                break;
              }
              case "RECEIVED": {
                const t = access(b.transferId);
                if (
                  t.receiverId !== s.deviceId ||
                  !["ready", "downloading", "received", "cleaned"].includes(
                    t.status,
                  ) ||
                  b.sha256 !== t.sha256
                )
                  throw Error("INVALID_STATE");
                if (t.status !== "cleaned") {
                  t.status = "received";
                  cleanup(t);
                }
                result = t;
                break;
              }
              case "RESUME_QUERY":
                result = access(b.transferId);
                break;
              case "CANCEL": {
                const t = access(b.transferId);
                if (!["cleaned", "expired", "cancelled"].includes(t.status))
                  terminal(t, "cancelled");
                result = t;
                break;
              }
              case "DEVICES":
                result = (
                  db
                    .prepare(
                      "SELECT id FROM devices WHERE userId=? AND revoked=0",
                    )
                    .all(s.userId) as Row[]
                ).map((d) => pubDevice(d.id));
                break;
              case "DEVICE_REVOKE": {
                const d = device(b.deviceId);
                if (
                  !d ||
                  d.userId !== s.userId ||
                  !password(user(s.userId), b.password)
                )
                  throw Error("FORBIDDEN");
                db.prepare("UPDATE devices SET revoked=1 WHERE id=?").run(d.id);
                for (const x of sessions)
                  if (x.deviceId === d.id) x.ws.close(1008);
                break;
              }
              case "ADMIN_USERS":
                if (!user(s.userId).admin) throw Error("FORBIDDEN");
                result = (db.prepare("SELECT * FROM users").all() as Row[]).map(
                  pubUser,
                );
                break;
              case "ADMIN_TIER":
                if (
                  !user(s.userId).admin ||
                  !["standard", "vip"].includes(b.tier) ||
                  !user(b.userId)
                )
                  throw Error("FORBIDDEN");
                db.prepare("UPDATE users SET tier=? WHERE id=?").run(
                  b.tier,
                  b.userId,
                );
                result = pubUser(user(b.userId));
                break;
              default:
                throw Error("UNKNOWN_TYPE");
            }
          }
          send(s, { id, type: "OK", body: result });
          if (
            ![
              "HEARTBEAT",
              "STATE",
              "UPLOAD_CREDIT",
              "DOWNLOAD_CHUNK",
              "RESUME_QUERY",
            ].includes(m.type)
          )
            broadcast();
        } catch (e) {
          send(s, {
            id,
            type: "ERROR",
            body: {
              code:
                e instanceof Error && /^[A-Z_]+$/.test(e.message)
                  ? e.message
                  : "INVALID_REQUEST",
              message: "Request rejected",
            },
          });
        } finally {
          if (counted) s.busy = Math.max(0, s.busy - 1);
        }
      })();
    });
  });
  const timer = setInterval(() => {
    for (const s of sessions) {
      if (!s.alive) {
        s.ws.terminate();
        continue;
      }
      s.alive = false;
      s.ws.ping();
    }
    for (const t of transfers.values()) {
      if (
        t.expiresAt < Date.now() &&
        !["cleaned", "cancelled", "expired", "failed"].includes(t.status)
      )
        terminal(t, "expired");
      else if (
        ["received", "cancelled", "expired", "failed"].includes(t.status) &&
        !t.cleanedAt
      )
        cleanup(t);
    }
    broadcast();
  }, 15000);
  timer.unref();
  app.addHook("onClose", async () => {
    closing = true;
    clearInterval(timer);
    for (const s of sessions) s.ws.terminate();
    db.close();
  });
  if (o.webRoot)
    await app.register(staticPlugin, { root: path.resolve(o.webRoot) });
  return app;
}
