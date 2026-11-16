// --smoke-phone: exercises the phone server end to end from Node (certificate pinned) and from the renderer.
import { connect } from 'node:net';
import { request } from 'node:https';
import { createServer } from 'node:https';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { generate } from 'selfsigned';

const hex32 = () => randomBytes(16).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function refused(port) {
  return new Promise((ok) => {
    const s = connect({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), ok(false)));
    s.once('error', () => ok(true));
  });
}

/**
 * @param {ReturnType<import('./service.mjs').createPhoneService>} svc
 * @param {{ userData: string, appOrigin: string, evalInPage: (js: string) => Promise<any> }} ctx
 */
export async function runPhoneSmoke(svc, ctx) {
  const checks = ctx.sink ?? [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  const port = svc.port;
  check('no port listening while off', svc.state === 'off' && (await refused(port)), { port });

  const info = await svc.start();
  check('state on after start', info.state === 'on' && info.lan === true && info.ws === `wss://127.0.0.1:${port}`);
  check('port open when on', !(await refused(port)));
  const pinned = svc._fingerprints()[0];
  // Pinning: chain validation is off for these test connections, but every one must present exactly this certificate.
  const pinHex = Buffer.from(pinned, 'base64').toString('hex').toUpperCase().match(/../g).join(':');
  const pinOk = (socket) => socket.getPeerCertificate()?.fingerprint256 === pinHex;

  const get = (path) =>
    new Promise((ok, fail) => {
      let sock = null;
      const req = request({ host: '127.0.0.1', port, path, method: 'GET', rejectUnauthorized: false, servername: '' }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => ok({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), pinned: pinOk(sock) }));
      });
      req.on('socket', (s) => (sock = s));
      req.on('error', fail);
      req.end();
    });
  const token = hex32();
  const ping = await get(`/__rsmps/ping?token=${token}`);
  check('ping over pinned https', ping.pinned && ping.status === 200 && JSON.parse(ping.body).ok === true && JSON.parse(ping.body).known === false);
  const page = await get('/phone?token=x');
  check('phone page served', page.status === 200 && /<html/i.test(page.body), { bytes: page.body.length });
  const asset = /(?:src|href)="(\.?\/?assets\/[^"]+\.js)"/.exec(page.body)?.[1];
  const assetRes = asset ? await get('/' + asset.replace(/^\.?\//, '')) : null;
  check('phone asset served', assetRes?.status === 200, asset);
  for (const p of ['/', '/index.html', '/__rsmps/lan-info', '/package.json', '/assets/../main.mjs', '/%2e%2e/package.json', '/phone-cert.pem'])
    check(`404 for ${p}`, (await get(p)).status === 404);

  const open = (role, tok, origin) =>
    new Promise((ok) => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}/__rsmps/phone-ws?role=${role}&token=${tok}`, { rejectUnauthorized: false, servername: '', ...(origin ? { origin } : {}) });
      ws.on('upgrade', (res) => !pinOk(res.socket) && ws.terminate());
      const msgs = [];
      const wait = [];
      ws.on('message', (d, bin) => {
        const m = bin ? { binary: new Uint8Array(d).length } : JSON.parse(d.toString());
        msgs.push(m);
        wait.splice(0).forEach((f) => f());
      });
      const r = { ws, msgs, closed: null, next: async (t = 3000) => (msgs.length ? msgs.shift() : (await Promise.race([new Promise((o) => wait.push(o)), sleep(t)]), msgs.shift())) };
      ws.on('close', (code) => {
        r.closed = code;
        wait.splice(0).forEach((f) => f());
      });
      ws.on('error', () => undefined);
      ws.on('open', () => ok(r));
      ws.on('close', () => ok(r));
    });

  const desk = await open('desktop', token, ctx.appOrigin);
  check('desktop registered', (await desk.next())?.type === 'registered');
  check('unknown token rejected (4404)', (await (async () => { const p = await open('phone', hex32()); await sleep(300); return p.closed; })()) === 4404);
  const badTok = await open('phone', 'nope');
  await sleep(300);
  check('bad token rejected (4400)', badTok.closed === 4400);
  const dup = await open('desktop', token, ctx.appOrigin);
  await sleep(300);
  check('duplicate token rejected (4410)', dup.closed === 4410);
  const stranger = await open('desktop', hex32(), 'https://evil.example');
  await sleep(300);
  check('desktop role from another origin rejected', stranger.closed === 4400);

  const phone = await open('phone', token);
  check('phone ready', (await phone.next())?.type === 'ready');
  check('desktop told phone joined', (await desk.next())?.type === 'phone-joined');
  const phone2 = await open('phone', token);
  await sleep(300);
  check('second phone rejected (4409)', phone2.closed === 4409);
  desk.ws.send(JSON.stringify({ type: 'offer', sdp: 'x' }));
  check('relay desktop to phone', (await phone.next())?.type === 'offer');
  phone.ws.send(new Uint8Array([1, 2, 3, 4]));
  check('relay phone to desktop (binary)', (await desk.next())?.binary === 4);

  // The renderer trusts this server's certificate and nothing else.
  const mine = await ctx.evalInPage(`new Promise((ok) => { const w = new WebSocket('wss://127.0.0.1:${port}/__rsmps/phone-ws?role=desktop&token=${hex32()}'); w.onmessage = (e) => { ok('open:' + e.data); w.close(); }; w.onerror = () => ok('error'); setTimeout(() => ok('timeout'), 6000); })`);
  check('renderer connects to own server (cert trusted, CSP allows)', typeof mine === 'string' && mine.includes('registered'), mine);
  const other = await generate([{ name: 'commonName', value: '127.0.0.1' }], { keyType: 'ec', curve: 'P-256', algorithm: 'sha256' });
  const stranger2 = createServer({ key: other.private, cert: other.cert }, (_q, r) => r.end('x'));
  await new Promise((ok) => stranger2.listen(0, '127.0.0.1', ok));
  const sp = stranger2.address().port;
  const theirs = await ctx.evalInPage(`new Promise((ok) => { const w = new WebSocket('wss://127.0.0.1:${sp}/'); w.onopen = () => ok('OPEN (bad)'); w.onerror = () => ok('error'); setTimeout(() => ok('timeout'), 6000); })`);
  stranger2.close();
  check('renderer still rejects other self-signed certificates', theirs === 'error', theirs);

  // Closing the last desktop link stops the server by itself.
  desk.ws.close();
  for (let i = 0; i < 30 && svc.state !== 'off'; i++) await sleep(200);
  check('auto-stop after the last link closed', svc.state === 'off');
  check('port closed again', await refused(port));
  phone.ws.terminate();

  // Idle timeout (simulated clock): started, untouched for longer than the limit.
  await svc.start();
  svc._touch(Date.now() - 11 * 60 * 1000);
  for (let i = 0; i < 70 && svc.state !== 'off'; i++) await sleep(500);
  check('auto-stop after 10 minutes without activity', svc.state === 'off' && (await refused(port)));

  const failed = checks.filter((c) => !c.ok);
  return { ok: failed.length === 0, pinnedFingerprint: `sha256/${pinned}`, checks, failed: failed.map((c) => c.name) };
}
