/**
 * Vite plugin: the phone link (opt-in LAN mode only, RSMPS_LAN=1).
 *
 *  - GET /__rsmps/lan-info      { lan: true, origins: [...] } so the app knows it can show a QR code.
 *  - WebSocket /__rsmps/phone-ws?role=desktop|phone&token=<32 hex>   pairs a desktop session with one phone and relays
 *    signalling (WebRTC offer/answer/ICE) and fallback JPEG frames. No other endpoints, nothing written to disk.
 *  - /phone                     serves phone.html (the standalone phone page; any mode, it is only a page).
 */
import type { IncomingMessage } from 'node:http';
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

export function phoneLink(opts: { lan: boolean; https?: boolean; /** machine.tailnet.ts.net when a Tailscale certificate is in use. */ tailnetName?: string }): Plugin {
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
      const candidates = () => {
        const list = lanCandidates().map((c) => ({ ...c, url: `${proto}://${c.address}:${port()}` }));
        // The Tailscale HTTPS name (browser-trusted certificate, no warning on the phone) is the preferred address when there is one.
        if (opts.tailnetName) list.unshift({ address: opts.tailnetName, adapter: 'Tailscale', kind: 'tailscale' as const, label: `Tailscale name ${opts.tailnetName} (trusted https)`, url: `${proto}://${opts.tailnetName}:${port()}` });
        return list;
      };
      const origins = (): string[] => candidates().map((c) => c.url);

      server.middlewares.use(INFO_PATH, (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify({ lan: true, origins: origins(), candidates: candidates(), port: port(), protocol: proto }));
      });

      // "Your phone reached this computer": the phone page calls this first, with its token, before it opens the WebSocket.
      server.middlewares.use(PING_PATH, (req, res) => {
        const token = new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? '';
        const known = sessions.reached(token, Date.now(), String(req.socket.remoteAddress ?? ''));
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

      server.httpServer?.once('listening', () => {
        const list = candidates();
        const cert = opts.tailnetName ? 'Tailscale certificate: trusted by phones, no warning' : opts.https === false ? 'plain http (test mode)' : 'https, certificate may show a warning on the phone';
        console.log(
          `\n  RSMPS LAN mode (${cert})\n  Addresses, best first (the app offers these for the QR code):\n${list.map((c, i) => `   ${i === 0 ? '>' : ' '} ${c.url}/   ${c.label}`).join('\n') || '    (no network address found)'}\n  The dev server is reachable by every device on this network while it runs.\n  If a phone cannot connect: Windows Security > Firewall & network protection > Allow an app through firewall > Node.js JavaScript Runtime > Private.\n  The Wi-Fi network must be "Private", and guest / AP-isolated Wi-Fi blocks phone-to-computer traffic (try the Tailscale address).\n`,
        );
      });
    },
  };
}
