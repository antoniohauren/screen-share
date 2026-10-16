import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

test('HTTP/WS ownership, disconnect recovery and durable explicit-stop lifecycle', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(`${existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir()}/screen-share-test-`);
  const rpc = [];
  const sfu = createServer((req, res) => {
    rpc.push(req.url);
    res.setHeader('Content-Type', 'application/json'); res.end('{}');
  }).listen(0, '127.0.0.1');
  await once(sfu, 'listening');
  const origin = 'http://localhost:18787';
  let server;
  const sockets = [];
  async function start() {
    server = spawn('target/debug/screen-share', [], {
      env: { ...process.env, BIND: '127.0.0.1:18787', PUBLIC_ORIGIN: origin, DATABASE_PATH: `${dir}/state.db`, LIVEKIT_API_SECRET: 'test-secret-with-at-least-32-characters', LIVEKIT_API_URL: `http://127.0.0.1:${sfu.address().port}` },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await once(server.stdout, 'data');
  }
  async function halt() { server.kill(); await once(server, 'exit'); }
  async function connect(id, hello = {}) {
    const ws = new WebSocket(`ws://localhost:18787/ws/${id}`, { origin });
    const queue = [], waiters = [];
    ws.on('message', data => { const message = JSON.parse(data); const waiter = waiters.shift(); if (waiter) waiter(message); else queue.push(message); });
    const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiters.push(resolve));
    await once(ws, 'open'); ws.send(JSON.stringify(hello));
    sockets.push(ws);
    return { ws, next, send: type => ws.send(JSON.stringify({ type })) };
  }
  async function until(client, type) { for (;;) { const msg = await client.next(); if (msg.type === type) return msg; } }
  try {
    await start();
    assert.equal((await fetch(`${origin}/api/broadcasts`, { method: 'POST', headers: { Origin: 'https://wrong.example' } })).status, 403);
    const response = await fetch(`${origin}/api/broadcasts`, { method: 'POST', headers: { Origin: origin } });
    const credentials = await response.json();
    assert.ok(!credentials.watchUrl.includes(credentials.owner));
    const unauthorized = await connect(credentials.id, { owner: credentials.id });
    assert.equal((await unauthorized.next()).type, 'unauthorized');
    const owner = await connect(credentials.id, { owner: credentials.owner });
    assert.equal((await until(owner, 'state')).ended, false);
    owner.send('start');
    const published = await until(owner, 'media');
    assert.equal(JSON.parse(Buffer.from(published.token.split('.')[1], 'base64url')).sub, 'presenter');
    const viewer = await connect(credentials.id);
    await until(viewer, 'state');
    viewer.send('stop');
    assert.equal((await until(viewer, 'state')).ended, false);
    viewer.send('start');
    assert.equal((await until(viewer, 'state')).ended, false);
    viewer.send('connect');
    const subscribed = await until(viewer, 'media');
    assert.equal(JSON.parse(Buffer.from(subscribed.token.split('.')[1], 'base64url')).video.canPublish, false);
    owner.ws.close(); await once(owner.ws, 'close');
    assert.equal((await until(viewer, 'state')).ended, false);
    await halt(); await start();
    const recovered = await connect(credentials.id, { owner: credentials.owner });
    assert.equal((await until(recovered, 'state')).ended, false);
    recovered.send('stop'); await until(recovered, 'stopped');
    assert.ok(rpc.includes('/twirp/livekit.RoomService/DeleteRoom'));
    await halt(); await start();
    const reopened = await connect(credentials.id, { owner: credentials.owner });
    assert.equal((await until(reopened, 'state')).ended, true);
    reopened.send('start');
    assert.equal((await until(reopened, 'media')).generation, published.generation + 1);
    const missing = await connect('00000000-0000-0000-0000-000000000000');
    assert.equal((await missing.next()).type, 'unavailable');
  } finally {
    for (const ws of sockets) ws.terminate();
    if (server?.exitCode === null) await halt();
    sfu.close();
    await rm(dir, { recursive: true, force: true });
  }
});
