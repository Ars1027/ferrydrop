import { sha256 } from "@noble/hashes/sha2.js";
self.onmessage = async (e: MessageEvent<File>) => {
  try {
    const h = sha256.create();
    for (let p = 0; p < e.data.size; p += 1048576)
      h.update(
        new Uint8Array(await e.data.slice(p, p + 1048576).arrayBuffer()),
      );
    self.postMessage({
      hash: Array.from(h.digest(), (b) => b.toString(16).padStart(2, "0")).join(
        "",
      ),
    });
  } catch (e) {
    self.postMessage({ error: String(e) });
  }
};
