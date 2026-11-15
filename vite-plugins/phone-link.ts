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

export const WS_PATH = '/__rsmps/phone-ws';
export const INFO_PATH = '/__rsmps/lan-info';

/** Non-loopback IPv4 addresses of this machine. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

export function phoneLink(opts: { lan: boolean; https?: boolean }): Plugin {
  return {
    name: 'rsmps-phone-link',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url && /^\/phone(\?|$)/.test(req.url)) req.url = '/phone.html' + req.url.slice(6);
        next();
      });
      if (!opts.lan) return;

      const origins = (): string[] => {
        const addr = server.httpServer?.address();
        const port = typeof addr === 'object' && addr ? addr.port : (server.config.server.port ?? 5173);
        return lanAddresses().map((ip) => `${opts.https === false ? 'http' : 'https'}://${ip}:${port}`);
      };

      server.middlewares.use(INFO_PATH, (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify({ lan: true, origins: origins() }));
      });

      const sessions = new PhoneSessions();
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
        else peer.send(JSON.stringify({ type: 'registered' }));
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
        const list = origins();
        console.log(
          `\n  RSMPS LAN mode (https, self-signed certificate)\n${list.map((o) => `    open on this computer or phone: ${o}/`).join('\n') || '    (no network address found)'}\n  The dev server is reachable by every device on this network while it runs.\n`,
        );
      });
    },
  };
}
