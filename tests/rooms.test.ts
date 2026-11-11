import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createApp, createUser } from "../apps/server/src/index.js";
import { encodeChunk, UPLOAD } from "../packages/protocol/src/index.js";
import { enroll, login, hash, type Peer } from "./helpers.js";

test("closing removes the room and invitation, cancels staged files, and purges legacy closed records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ferrydrop-rooms-"));
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  const peers: Peer[] = [];
  try {
    createUser(dir, "owner", "room-test-password");
    createUser(dir, "receiver", "room-test-password");
    const legacyId = randomUUID(),
      databasePath = join(dir, "ferrydrop.sqlite");
    const seed = new DatabaseSync(databasePath);
    seed
      .prepare("INSERT INTO state VALUES(?,?,?)")
      .run(
        legacyId,
        "room",
        JSON.stringify({
          id: legacyId,
          code: "12345678",
          closed: true,
          members: [],
          pending: [],
        }),
      );
    seed.close();
    app = await createApp({ dataDir: dir, insecure: true });
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const a = await enroll(url, "owner", "room-test-password"),
      b = await enroll(url, "receiver", "room-test-password");
    const owner = await login(url, a),
      receiver = await login(url, b);
    peers.push(owner, receiver);
    const room = await owner.rpc("ROOM_CREATE");
    await receiver.rpc("ROOM_JOIN", { code: room.code });
    await owner.rpc("ROOM_DECIDE", {
      roomId: room.id,
      deviceId: b.deviceId,
      accept: true,
    });
    const data = Buffer.from("staged file");
    const transfer = await owner.rpc("FILE_OFFER", {
      roomId: room.id,
      receiverId: b.deviceId,
      name: "staged.txt",
      size: data.length,
      sha256: hash(data),
    });
    await receiver.rpc("FILE_DECIDE", {
      transferId: transfer.id,
      accept: true,
    });
    await owner.rpc("UPLOAD_CREDIT", {
      transferId: transfer.id,
      bytes: data.length,
    });
    owner.ws.send(encodeChunk(UPLOAD, transfer.id, 0, data));
    await owner.wait(() =>
      owner.events.find(
        (e) => e.type === "ACK" && e.body.transferId === transfer.id,
      ),
    );
    await owner.rpc("ROOM_CLOSE", { roomId: room.id });
    const state = await owner.rpc("STATE"),
      other = await receiver.rpc("STATE");
    assert.deepEqual(state.rooms, []);
    assert.deepEqual(other.rooms, []);
    assert.equal(
      other.transfers.find((t: any) => t.id === transfer.id).status,
      "cancelled",
    );
    await assert.rejects(receiver.rpc("ROOM_JOIN", { code: room.code }));
    await assert.rejects(
      owner.rpc("RESUME_QUERY", { transferId: transfer.id }),
    );
    assert.deepEqual(await readdir(join(dir, "files")), []);
    const check = new DatabaseSync(databasePath);
    assert.equal(
      (
        check
          .prepare("SELECT count(*) AS n FROM state WHERE kind='room'")
          .get() as any
      ).n,
      0,
    );
    check.close();
    peers.forEach((p) => p.close());
    await app.close();
    app = await createApp({ dataDir: dir, insecure: true });
    const after = await app.listen({ host: "127.0.0.1", port: 0 });
    const reconnected = await login(after, a);
    peers.push(reconnected);
    assert.deepEqual((await reconnected.rpc("STATE")).rooms, []);
  } finally {
    peers.forEach((p) => p.close());
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
