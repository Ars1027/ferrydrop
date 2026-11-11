import path from "node:path";
import { createApp } from "./index.js";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
try {
  process.loadEnvFile(root + ".env");
} catch {}
function positive(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
}
const app = await createApp({
  dataDir: path.resolve(root, process.env.DATA_DIR ?? "runtime/data"),
  host: process.env.HOST ?? "127.0.0.1",
  insecure: process.env.FD_INSECURE_LOCALHOST === "1",
  certPath: process.env.TLS_CERT
    ? path.resolve(root, process.env.TLS_CERT)
    : undefined,
  keyPath: process.env.TLS_KEY
    ? path.resolve(root, process.env.TLS_KEY)
    : undefined,
  webRoot: path.resolve(root, process.env.WEB_ROOT ?? "apps/web/dist"),
  standardRate: positive("STANDARD_RATE"),
  vipRate: positive("VIP_RATE"),
  maxFileSize: positive("MAX_FILE_SIZE"),
  retentionMs: positive("RETENTION_MS"),
  roomTtlMs: positive("ROOM_TTL_MS"),
});
const address = await app.listen({
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8443),
});
console.info(`FerryDrop listening at ${address}`);
