import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
try {
  process.loadEnvFile(root + ".env");
} catch {}
import { createUser } from "./index.js";
const args = process.argv.slice(2),
  username = args[0],
  flag = args.indexOf("--tier");
const password =
  process.env.FD_USER_PASSWORD ?? (args[1]?.startsWith("--") ? "" : args[1]);
const tier = flag >= 0 ? args[flag + 1] : (args[2] ?? "standard");
if (!password) throw Error("Set FD_USER_PASSWORD before running user CLI");
console.log(
  createUser(
    path.resolve(root, process.env.DATA_DIR ?? "runtime/data"),
    username,
    password,
    tier,
    args.includes("--admin") || args[3] === "true",
  ),
);
