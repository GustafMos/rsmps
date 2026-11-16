// The phone link server of the desktop app: an https server that exists only while the user has asked for a phone link.
//
// It serves ONLY the phone page and its assets from the app bundle, /__rsmps/ping and the pairing WebSocket
// (/__rsmps/phone-ws). Everything else is 404. The pairing logic is the very same module the Vite dev plugin uses
// (vite-plugins/phone-session.ts, bundled in by desktop/scripts/bundle-phone.mjs), so there is one implementation.
// Nothing is logged that identifies a session (no tokens, no addresses of phones).
import { createServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { createSecureContext } from 'node:tls';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { CLOSE_CODES, PhoneSessions } from '../../vite-plugins/phone-session.ts';
import { INFO_PATH, PING_PATH, WS_PATH, lanCandidates } from '../../vite-plugins/phone-link.ts';
import { ensureCertificate, fingerprintOf } from './cert.mjs';
import { tailscaleCertificate } from './tailscale.mjs';

export { INFO_PATH, PING_PATH, WS_PATH };

export const IDLE_STOP_MS = 10 * 60 * 1000;
const DEFAULT_PORT = 47831;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
};

/** Can we listen on this port (all interfaces) right now? */
function portFree(port) {
  return new Promise((ok) => {
    const s = createNetServer();
    s.once('error', () => ok(false));
    s.listen(port, '0.0.0.0', () => s.close(() => ok(true)));
  });
}

/**
 * @param {{ userData: string, webRoot: string, appOrigin: string }} cfg
 *   appOrigin: the origin of the desktop app's own pages (the desktop side of a session must come from there).
 */
export function createPhoneService({ userData, webRoot, appOrigin }) {
  const settingsFile = join(userData, 'phone-settings.json');
  /** @type {{ port?: number, consent: 'ask' | 'allow', tailscale: boolean }} */
  let settings = { consent: 'ask', tailscale: false };
  try {
    settings = { ...settings, ...JSON.parse(readFileSync(settingsFile, 'utf8')) };
  } catch {
    /* defaults */
  }
  const saveSettings = () => {
    try {
      mkdirSync(dirname(settingsFile), { recursive: true });
      writeFileSync(settingsFile, JSON.stringify(settings));
    } catch {
      /* a convenience only */
    }
  };

  /** @type {'off' | 'starting' | 'on' | 'error'} */
  let state = 'off';
  let error = '';
  let port = 0;
  let server = null;
  let wss = null;
  let sessions = new PhoneSessions();
  let sweepTimer = null;
  let idleTimer = null;
  let lastActivity = 0;
  let everHadSession = false;
  let tls = null; // { fingerprints: Set<string> (base64 sha256), tailnetName?: string }
  let starting = null;
  const listeners = new Set();
  const root = resolve(webRoot);

  const emit = () => listeners.forEach((l) => l(state));
  const setState = (s, err = '') => {
    state = s;
    error = err;
    emit();
  };
  const touch = () => {
    lastActivity = Date.now();
  };

  const candidates = () => lanCandidates().map((c) => ({ ...c, url: `https://${c.address}:${port}` }));

  function info() {
    const list = candidates();
    if (tls?.tailnetName && state === 'on') list.unshift({ address: tls.tailnetName, adapter: 'Tailscale', kind: 'tailscale', label: `Tailscale name ${tls.tailnetName} (trusted https)`, url: `https://${tls.tailnetName}:${port}` });
    return {
      lan: state === 'on',
      desktop: true,
      state,
      ...(error ? { error } : {}),
      origins: list.map((c) => c.url),
      candidates: list,
      port,
      protocol: 'https',
      ws: `wss://127.0.0.1:${port}`,
      tailscale: settings.tailscale,
    };
  }

  /** Decide the port for this run of the app (stable between runs so a firewall rule stays valid). Call once at startup. */
  async function reservePort() {
    for (const p of [settings.port, DEFAULT_PORT]) {
      if (p && (await portFree(p))) return (port = settings.port = p), saveSettings(), port;
    }
    for (let i = 0; i < 20; i++) {
      const p = 20000 + Math.floor(Math.random() * 40000);
      if (await portFree(p)) return (port = settings.port = p), saveSettings(), port;
    }
    port = settings.port ?? DEFAULT_PORT;
    return port;
  }

  // ---- HTTP ---------------------------------------------------------------------------------------------------------

  function allowedFile(pathname) {
    if (pathname === '/phone' || pathname === '/phone/') return join(root, 'phone.html');
    if (!/^\/(assets|fonts)\/[\w.\-/]+$/.test(pathname) && !/^\/[\w.-]+\.(png|ico|svg)$/.test(pathname)) return null;
    if (pathname.includes('..')) return null;
    const file = resolve(root, '.' + pathname);
    return file.startsWith(root + sep) ? file : null;
  }

  function onRequest(req, res) {
    touch();
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (status, body, type = 'text/plain; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      res.end(body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(404, 'Not found');
    if (url.pathname === PING_PATH) {
      const token = url.searchParams.get('token') ?? '';
      const known = sessions.reached(token, Date.now(), String(req.socket.remoteAddress ?? ''));
      return send(200, JSON.stringify({ ok: true, known }), 'application/json');
    }
    const file = allowedFile(url.pathname);
    let ok = false;
    try {
      ok = !!file && statSync(file).isFile();
    } catch {
      /* 404 */
    }
    if (!file || !ok) return send(404, 'Not found');
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  }

  // ---- WebSocket pairing (same protocol as vite-plugins/phone-link.ts) ----------------------------------------------

  function onSocket(ws, url, req) {
    const role = url.searchParams.get('role');
    const token = url.searchParams.get('token') ?? '';
    const peer = {
      send: (data, binary) => {
        if (ws.readyState === ws.OPEN) ws.send(data, { binary: binary ?? typeof data !== 'string' });
      },
      close: (code, reason) => ws.close(code, reason),
    };
    if (role !== 'desktop' && role !== 'phone') return ws.close(CLOSE_CODES['bad-token'], 'bad role');
    const origin = req.headers.origin;
    if (role === 'desktop') {
      // The desktop side is this app only: loopback, from the app's own pages. (A web page in a normal browser cannot register.)
      const remote = String(req.socket.remoteAddress ?? '');
      if (!/^(::ffff:)?127\.0\.0\.1$|^::1$/.test(remote) || (origin !== undefined && origin !== appOrigin)) return ws.close(CLOSE_CODES['bad-token'], 'not the app');
    } else if (origin !== undefined) {
      // A phone's page is served by this very server, so its Origin has our Host.
      try {
        if (new URL(origin).host !== req.headers.host) return ws.close(CLOSE_CODES['bad-token'], 'bad origin');
      } catch {
        return ws.close(CLOSE_CODES['bad-token'], 'bad origin');
      }
    }
    const res = role === 'desktop' ? sessions.registerDesktop(token, peer, Date.now()) : sessions.joinPhone(token, peer, Date.now());
    if (!res.ok) return ws.close(CLOSE_CODES[res.reason], res.reason);
    touch();
    if (role === 'desktop') everHadSession = true;
    if (role === 'phone') peer.send(JSON.stringify({ type: 'ready' }));
    else peer.send(JSON.stringify({ type: 'registered', expiresAt: sessions.expiresAt(token) }));
    ws.on('message', (data, isBinary) => {
      touch();
      sessions.relay(token, role, isBinary ? new Uint8Array(data) : data.toString(), isBinary);
    });
    ws.on('close', () => {
      sessions.closed(token, role, peer);
      // The last Phone Camera link was closed: nobody needs the open port any more.
      if (role === 'desktop' && everHadSession && sessions.size === 0) setTimeout(() => state === 'on' && sessions.size === 0 && void stop(), 1500).unref();
    });
    ws.on('error', () => ws.close());
  }

  // ---- lifecycle ------------------------------------------------------------------------------------------------------

  async function doStart() {
    setState('starting');
    try {
      if (!port) await reservePort();
      const ips = candidates().map((c) => c.address);
      const own = await ensureCertificate(userData, ips);
      const ctxSelf = createSecureContext({ key: own.key, cert: own.cert });
      const fingerprints = new Set([own.fingerprint]);
      let ctxTail = null;
      let tailnetName;
      if (settings.tailscale) {
        const ts = await tailscaleCertificate(userData);
        if (ts.ok) {
          ctxTail = createSecureContext({ key: ts.key, cert: ts.cert });
          tailnetName = ts.name;
          fingerprints.add(fingerprintOf(ts.cert.split(/(?<=-----END CERTIFICATE-----)/)[0]));
        }
      }
      tls = { fingerprints, tailnetName };
      sessions = new PhoneSessions();
      everHadSession = false;
      wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
      server = createServer({
        key: own.key,
        cert: own.cert,
        minVersion: 'TLSv1.2',
        // Phones that connect by the Tailscale name get the trusted certificate; everyone else the self-signed one.
        SNICallback: (name, cb) => cb(null, ctxTail && name === tailnetName ? ctxTail : ctxSelf),
      }, onRequest);
      server.headersTimeout = 15_000;
      server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (url.pathname !== WS_PATH) return socket.destroy();
        wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, url, req));
      });
      server.on('tlsClientError', () => undefined);
      await new Promise((ok, fail) => {
        server.once('error', fail);
        server.listen(port, '0.0.0.0', () => {
          server.off('error', fail);
          ok();
        });
      });
      server.on('error', () => undefined);
      touch();
      sweepTimer = setInterval(() => sessions.sweep(Date.now()), 15_000);
      idleTimer = setInterval(() => Date.now() - lastActivity > IDLE_STOP_MS && void stop(), 30_000);
      sweepTimer.unref();
      idleTimer.unref();
      setState('on');
    } catch (err) {
      await teardown();
      const code = err && err.code;
      setState('error', code === 'EADDRINUSE' ? `Port ${port} is in use by another program.` : String(err?.message ?? err));
    }
    return info();
  }

  async function teardown() {
    clearInterval(sweepTimer);
    clearInterval(idleTimer);
    sweepTimer = idleTimer = null;
    for (const c of wss?.clients ?? []) c.terminate();
    wss?.close();
    wss = null;
    const s = server;
    server = null;
    if (s) {
      s.closeAllConnections?.();
      await new Promise((ok) => s.close(() => ok()));
    }
    tls = null;
  }

  function start() {
    if (state === 'on') return Promise.resolve(info());
    return (starting ??= doStart().finally(() => (starting = null)));
  }

  async function stop() {
    if (starting) await starting;
    if (state === 'off') return info();
    await teardown();
    setState('off');
    return info();
  }

  return {
    get state() {
      return state;
    },
    get port() {
      return port;
    },
    get settings() {
      return { ...settings };
    },
    setSettings(patch) {
      settings = { ...settings, ...patch };
      saveSettings();
    },
    reservePort,
    info,
    start,
    stop,
    /** Chromium certificate fingerprint ("sha256/<base64>") of what this server presents; used to trust it, nothing else. */
    isOurCertificate: (fingerprint) => !!tls && tls.fingerprints.has(String(fingerprint).replace(/^sha256\//, '')),
    hosts: () => ['127.0.0.1', 'localhost', ...candidates().map((c) => c.address), ...(tls?.tailnetName ? [tls.tailnetName] : [])],
    onChange(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    /** Test hooks. */
    _sessions: () => sessions,
    _touch: (t) => (lastActivity = t),
    _fingerprints: () => [...(tls?.fingerprints ?? [])],
  };
}
