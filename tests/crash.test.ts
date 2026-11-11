import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createUser } from "../apps/server/src/index.js";
import { encodeChunk, UPLOAD } from "../packages/protocol/src/index.js";
import { enroll, login, hash, type Peer } from "./helpers.js";

test("an ACKed upload continues after forcibly terminating the server process", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ferrydrop-crash-"));
  let child: ChildProcess | undefined;
  const peers: Peer[] = [];
  async function kill() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit");
      child.kill("SIGKILL");
      await ended;
    }
  }
  async function start() {
    const moduleUrl = pathToFileURL(resolve("apps/server/src/index.ts")).href;
    const code = `const {createApp}=await import(${JSON.stringify(moduleUrl)}); const app=await createApp(${JSON.stringify({ dataDir, insecure: true, host: "127.0.0.1" })}); const url=await app.listen({host:'127.0.0.1',port:0}); console.log('READY:'+url);`;
    child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      {
        cwd: resolve("."),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return new Promise<string>((resolveUrl, reject) => {
      let output = "",
        errors = "";
      const timer = setTimeout(
        () => reject(new Error("Child server startup timed out: " + errors)),
        15_000,
      );
      child!.stderr!.on("data", (b) => (errors += b.toString()));
      child!.stdout!.on("data", (b) => {
        output += b.toString();
        const match = /READY:(http:\/\/[^\r\n]+)/.exec(output);
        if (match) {
          clearTimeout(timer);
          resolveUrl(match[1]);
        }
      });
      child!.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child!.once("exit", () => {
        clearTimeout(timer);
        if (!output.includes("READY:")) reject(new Error(errors));
      });
    });
  }
  try {
    createUser(dataDir, "sender", "crash-test-password");
    createUser(dataDir, "receiver", "crash-test-password");
    let url = await start();
    const a = await enroll(url, "sender", "crash-test-password"),
      b = await enroll(url, "receiver", "crash-test-password");
    let sender = await login(url, a);
    const receiver = await login(url, b);
    peers.push(sender, receiver);
    const room = await sender.rpc("ROOM_CREATE");
    await receiver.rpc("ROOM_JOIN", { code: room.code });
    await sender.rpc("ROOM_DECIDE", {
      roomId: room.id,
      deviceId: b.deviceId,
      accept: true,
    });
    const data = Buffer.alloc(100_000, 71),
      split = 40_000;
    const transfer = await sender.rpc("FILE_OFFER", {
      roomId: room.id,
      receiverId: b.deviceId,
      name: "crash.bin",
      size: data.length,
      sha256: hash(data),
    });
    await receiver.rpc("FILE_DECIDE", {
      transferId: transfer.id,
      accept: true,
    });
    await sender.rpc("UPLOAD_CREDIT", {
      transferId: transfer.id,
      bytes: split,
    });
    sender.ws.send(
      encodeChunk(UPLOAD, transfer.id, 0, data.subarray(0, split)),
    );
    await sender.wait(() =>
      sender.events.find(
        (e) =>
          e.type === "ACK" &&
          e.body.transferId === transfer.id &&
          e.body.offset === split,
      ),
    );
    await kill();
    url = await start();
    sender = await login(url, a);
    peers.push(sender);
    assert.equal(
      (await sender.rpc("RESUME_QUERY", { transferId: transfer.id })).offset,
      split,
    );
    await sender.rpc("UPLOAD_CREDIT", {
      transferId: transfer.id,
      bytes: data.length - split,
    });
    sender.ws.send(
      encodeChunk(UPLOAD, transfer.id, split, data.subarray(split)),
    );
    await sender.wait(() =>
      sender.events.find(
        (e) => e.type === "ACK" && e.body.offset === data.length,
      ),
    );
    assert.equal(
      (await sender.rpc("UPLOAD_FINISH", { transferId: transfer.id })).status,
      "ready",
    );
  } finally {
    peers.forEach((p) => p.close());
    await kill();
    await rm(dataDir, { recursive: true, force: true });
  }
});
