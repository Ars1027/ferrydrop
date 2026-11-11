import { mkdir, writeFile, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { networkInterfaces } from "node:os";

const out = resolve("certs");
const hosts = [
  ...new Set(["localhost", "127.0.0.1", ...process.argv.slice(2)]),
];
if (hosts.some((h) => !/^[A-Za-z0-9.-]+$/.test(h)))
  throw new Error("主机名只能包含字母、数字、点和连字符");
const run = (...args) => {
  const result = spawnSync(process.env.OPENSSL || "openssl", args, {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error(result.error?.message || result.stderr);
};
await mkdir(out, { recursive: true });
for (const name of ["ca-key.pem", "ca.pem", "server-key.pem", "server.pem"]) {
  try {
    await access(join(out, name));
    throw new Error(
      `已存在 certs/${name}，为避免覆盖信任材料，请先备份并移走 certs 目录`,
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const san = hosts
  .map(
    (h, i) =>
      `${/^\d+\.\d+\.\d+\.\d+$/.test(h) ? "IP" : "DNS"}.${i + 1} = ${h}`,
  )
  .join("\n");
await writeFile(
  join(out, "server.cnf"),
  `[req]\nprompt = no\ndistinguished_name = dn\nreq_extensions = ext\n[dn]\nCN = ${hosts[0]}\n[ext]\nsubjectAltName = @names\nbasicConstraints = critical,CA:FALSE\nkeyUsage = critical,digitalSignature,keyEncipherment\nextendedKeyUsage = serverAuth\n[names]\n${san}\n`,
);
run(
  "req",
  "-x509",
  "-newkey",
  "rsa:3072",
  "-sha256",
  "-nodes",
  "-config",
  join(out, "server.cnf"),
  "-days",
  "365",
  "-subj",
  "/CN=FerryDrop Local Development CA",
  "-addext",
  "basicConstraints=critical,CA:TRUE",
  "-addext",
  "keyUsage=critical,keyCertSign,cRLSign",
  "-keyout",
  join(out, "ca-key.pem"),
  "-out",
  join(out, "ca.pem"),
);
run(
  "req",
  "-new",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-config",
  join(out, "server.cnf"),
  "-keyout",
  join(out, "server-key.pem"),
  "-out",
  join(out, "server.csr"),
);
run(
  "x509",
  "-req",
  "-in",
  join(out, "server.csr"),
  "-CA",
  join(out, "ca.pem"),
  "-CAkey",
  join(out, "ca-key.pem"),
  "-CAcreateserial",
  "-days",
  "90",
  "-sha256",
  "-extfile",
  join(out, "server.cnf"),
  "-extensions",
  "ext",
  "-out",
  join(out, "server.pem"),
);
console.log(
  `证书已生成，适用地址：${hosts.join(", ")}\n仅将 certs/ca.pem 安装为测试设备的受信 CA；保管 ca-key.pem，不部署此私钥。\n启动配置：TLS_CERT=certs/server.pem，TLS_KEY=certs/server-key.pem。`,
);
const ips = Object.values(networkInterfaces())
  .flat()
  .filter((x) => x && x.family === "IPv4" && !x.internal)
  .map((x) => x.address);
if (ips.length)
  console.log(
    `本机局域网地址参考：${ips.join(", ")}。手机连接地址必须在证书 SAN 中；生成命令示例：npm run cert -- ${ips[0]}`,
  );
