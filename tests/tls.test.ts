import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import https from 'node:https';
import { createApp } from '../apps/server/src/index.js';

test('TLS accepts the configured CA and rejects unknown trust and a mismatched server identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ferrydrop-tls-'));
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const generated = spawnSync(process.execPath, [resolve('scripts/cert.mjs'), '127.0.0.1'], { cwd: directory, encoding: 'utf8', windowsHide: true });
    assert.equal(generated.status, 0, generated.stderr);
    app = await createApp({ dataDir: join(directory, 'data'), host: '127.0.0.1', certPath: join(directory, 'certs/server.pem'), keyPath: join(directory, 'certs/server-key.pem') });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert(address && typeof address === 'object');
    const ca = await readFile(join(directory, 'certs/ca.pem'));
    const request = (options: https.RequestOptions) => new Promise<number>((resolveResult, reject) => {
      const req = https.get({ hostname: '127.0.0.1', port: address.port, path: '/api/health', agent: false, ...options }, response => { response.resume(); response.on('end', () => resolveResult(response.statusCode!)); });
      req.on('error', reject);
    });
    assert.equal(await request({ ca }), 200);
    await assert.rejects(request({}), /certificate|verify/i);
    await assert.rejects(request({ ca, servername: 'wrong.example.test' }), /altnames|does not match/i);
  } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
});
