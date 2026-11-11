import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createUser } from "../apps/server/src/index.js";
import { enroll } from "./helpers.js";

test("account provisioning and enrollment agree on password length boundaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ferrydrop-account-"));
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    assert.throws(
      () => createUser(directory, "too-long", "a".repeat(257)),
      /10-256/,
    );
    assert.throws(
      () => createUser(directory, "too-short", "a".repeat(9)),
      /10-256/,
    );
    createUser(directory, "boundary", "a".repeat(256));
    app = await createApp({ dataDir: directory, insecure: true });
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    assert.ok((await enroll(url, "boundary", "a".repeat(256))).deviceId);
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
