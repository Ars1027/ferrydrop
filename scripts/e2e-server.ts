import { createApp, createUser } from "../apps/server/src/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const dir = await mkdtemp(join(tmpdir(), "ferrydrop-browser-"));
createUser(dir, "alice", "browser-test-alice-2026", "standard", true);
createUser(dir, "bob", "browser-test-bob-2026", "vip");
const app = await createApp({
  dataDir: dir,
  host: "127.0.0.1",
  insecure: true,
  webRoot: resolve("apps/web/dist"),
  standardRate: 1024 ** 2,
  vipRate: 4 * 1024 ** 2,
});
await app.listen({ host: "127.0.0.1", port: 8787 });
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  await app.close();
  await rm(dir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
