/**
 * Vite plugin: the phone link (opt-in LAN mode only, RSMPS_LAN=1).
 *
 *  - GET /__rsmps/lan-info      { lan: true, origins: [...] } so the app knows it can show a QR code.
 *  - WebSocket /__rsmps/phone-ws?role=desktop|phone&token=<32 hex>   pairs a desktop session with one phone and relays
 *    signalling (WebRTC offer/answer/ICE) and fallback JPEG frames. No other endpoints, nothing written to disk.
 *  - /phone                     serves phone.html (the standalone phone page; any mode, it is only a page).
 *
 * The app itself stays on http://localhost:<port> in LAN mode, exactly as in plain `npm run dev`: a browser keeps projects per
 * address, so serving the app over https would show an empty project list. Phones need https (camera access), so LAN mode adds a
 * small https front on the next free port that passes every request on to the dev server. Only the phone uses that address.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import type { Duplex } from 'node:stream';
import type { Plugin } from 'vite';
import { WebSocketServer, type WebSocket } from 'ws';
import { CLOSE_CODES, PhoneSessions, type Peer } from './phone-session';
import { rankAddresses, type Candidate } from './phone-addresses';

export const WS_PATH = '/__rsmps/phone-ws';
export const INFO_PATH = '/__rsmps/lan-info';

/** Ranked addresses of this machine (see phone-addresses.ts). */
export function lanCandidates(): Candidate[] {
  const flat = Object.entries(networkInterfaces()).flatMap(([name, list]) => (list ?? []).map((a) => ({ name, address: a.address, family: a.family, internal: a.internal })));
  return rankAddresses(flat);
}

export const PING_PATH = '/__rsmps/ping';

/**
 * The https front for phones: every request and WebSocket upgrade is passed on to the dev server on localhost.
 * Listens on the first free port from `from` upward; resolves with the server and its port.
 */
export function startHttpsFront(tls: { cert: string | Buffer; key: string | Buffer }, target: () => number, from: number): Promise<{ server: HttpsServer; port: number }> {
  const front = createHttpsServer(tls, (req, res) => {
    const up = httpRequest({ host: 'localhost', port: target(), path: req.url, method: req.method, headers: { ...req.headers, 'x-forwarded-for': String(req.socket.remoteAddress ?? '') } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.statusCode = 502;
      res.end();
    });
    req.pipe(up);
  });
  front.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const up = connect(target(), 'localhost', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const end = () => {
      up.destroy();
      socket.destroy();
    };
    up.on('error', end);
    socket.on('error', end);
    up.on('close', end);
    socket.on('close', end);
  });
  return new Promise((done, fail) => {
    let port = from;
    front.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && port < from + 20) front.listen(++port);
      else fail(err);
    });
    front.on('listening', () => done({ server: front, port }));
    front.listen(port);
  });
}

export function phoneLink(opts: { lan: boolean; https?: boolean; /** A real certificate (for example from Tailscale) for the https front; without one a self-signed certificate is made in .certs/. */ tls?: { cert: Buffer; key: Buffer } | null; /** machine.tailnet.ts.net when a Tailscale certificate is in use. */ tailnetName?: string }): Plugin {
  return {
    name: 'rsmps-phone-link',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url && /^\/phone(\?|$)/.test(req.url)) req.url = '/phone.html' + req.url.slice(6);
        next();
      });
      if (!opts.lan) return;

      const sessions = new PhoneSessions();
      const proto = opts.https === false ? 'http' : 'https';
      const port = (): number => {
        const addr = server.httpServer?.address();
        return typeof addr === 'object' && addr ? addr.port : (server.config.server.port ?? 5173);
      };
      /** Port phones use: the https front when there is one, else the dev server itself (plain-http test mode). */
      let frontPort = 0;
      const phonePort = () => frontPort || port();
      const candidates = () => {
        const list = lanCandidates().map((c) => ({ ...c, url: `${proto}://${c.address}:${phonePort()}` }));
        // The Tailscale HTTPS name (browser-trusted certificate, no warning on the phone) is the preferred address when there is one.
        if (opts.tailnetName) list.unshift({ address: opts.tailnetName, adapter: 'Tailscale', kind: 'tailscale' as const, label: `Tailscale name ${opts.tailnetName} (trusted https)`, url: `${proto}://${opts.tailnetName}:${port()}` });
        return list;
      };
      const origins = (): string[] => candidates().map((c) => c.url);
      const xff = (req: IncomingMessage) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '');

      server.middlewares.use(INFO_PATH, (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify({ lan: true, origins: origins(), candidates: candidates(), port: phonePort(), protocol: proto }));
      });

      // "Your phone reached this computer": the phone page calls this first, with its token, before it opens the WebSocket.
      server.middlewares.use(PING_PATH, (req, res) => {
        const token = new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? '';
        const known = sessions.reached(token, Date.now(), xff(req));
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify({ ok: true, known }));
      });

      const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
      const timer = setInterval(() => sessions.sweep(Date.now()), 15_000);
      server.httpServer?.on('close', () => clearInterval(timer));

      const handle = (ws: WebSocket, url: URL) => {
        const role = url.searchParams.get('role');
        const token = url.searchParams.get('token') ?? '';
        const peer: Peer = {
          send: (data, binary) => {
            if (ws.readyState === ws.OPEN) ws.send(data, { binary: binary ?? typeof data !== 'string' });
          },
          close: (code, reason) => ws.close(code, reason),
        };
        if (role !== 'desktop' && role !== 'phone') {
          ws.close(CLOSE_CODES['bad-token'], 'bad role');
          return;
        }
        const res = role === 'desktop' ? sessions.registerDesktop(token, peer, Date.now()) : sessions.joinPhone(token, peer, Date.now());
        if (!res.ok) {
          ws.close(CLOSE_CODES[res.reason], res.reason);
          return;
        }
        if (role === 'phone') peer.send(JSON.stringify({ type: 'ready' }));
        else peer.send(JSON.stringify({ type: 'registered', expiresAt: sessions.expiresAt(token) }));
        ws.on('message', (data, isBinary) => {
          const payload = isBinary ? new Uint8Array(data as Buffer) : data.toString();
          sessions.relay(token, role, payload, isBinary);
        });
        ws.on('close', () => sessions.closed(token, role, peer));
        ws.on('error', () => ws.close());
      };

      server.httpServer?.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (url.pathname !== WS_PATH) return; // Vite's own HMR socket (and anything else) is handled elsewhere
        wss.handleUpgrade(req, socket, head, (ws) => handle(ws, url));
      });

      server.httpServer?.once('listening', async () => {
        if (opts.https !== false) {
          try {
            let tls: { cert: string | Buffer; key: string | Buffer } | null = opts.tls ?? null;
            if (!tls) {
              // The certificate helper of the desktop app's phone server (plain .mjs, no types): cached in the git-ignored .certs/ folder.
              const mod = (await import(/* @vite-ignore */ '../desktop/phone/cert.mjs' as string)) as { ensureCertificate(dir: string, addresses: string[]): Promise<{ cert: string; key: string }> };
              tls = await mod.ensureCertificate(resolve(server.config.root, '.certs'), lanCandidates().map((c) => c.address));
            }
            const front = await startHttpsFront(tls, port, port() + 1);
            frontPort = front.port;
            server.httpServer?.on('close', () => front.server.close());
          } catch (err) {
            console.error(`
  RSMPS LAN mode: the https address for phones could not be started (${err instanceof Error ? err.message : String(err)}).
`);
            return;
          }
        }
        const list = candidates();
        const cert = opts.tailnetName ? 'Tailscale certificate: trusted by phones, no warning' : opts.https === false ? 'plain http (test mode)' : 'https, certificate may show a warning on the phone';
        console.log(
          `\n  RSMPS LAN mode (${cert})\n  On this computer open the app at http://localhost:${port()}/ (the same address as "npm run dev", so the same projects).\n  Addresses for the phone, best first (the app offers these for the QR code):\n${list.map((c, i) => `   ${i === 0 ? '>' : ' '} ${c.url}/   ${c.label}`).join('\n') || '    (no network address found)'}\n  The phone address is reachable by every device on this network while it runs.\n  If a phone cannot connect: Windows Security > Firewall & network protection > Allow an app through firewall > Node.js JavaScript Runtime > Private.\n  The Wi-Fi network must be "Private", and guest / AP-isolated Wi-Fi blocks phone-to-computer traffic (try the Tailscale address).\n`,
        );
      });
    },
  };
}
