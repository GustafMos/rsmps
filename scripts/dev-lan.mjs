// npm run dev:lan — opt-in LAN mode: https with a self-signed certificate, reachable from a phone on the same network.
// Plain `npm run dev` is unchanged (http, localhost only).
import { createServer } from 'vite';

process.env.RSMPS_LAN = '1';
const port = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7)) || undefined;
const server = await createServer(port ? { server: { port } } : {});
await server.listen();
server.printUrls();
