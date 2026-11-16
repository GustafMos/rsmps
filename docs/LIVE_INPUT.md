# Live picture inputs

Two input nodes bring a live picture into the graph: **Camera** (`camera-in`) and **URL / Stream** (`url-in`).
They work in the live preview only. Exports and headless runs have no camera or network picture, so the node
shows an error there: record the source to a file first and use that file as Media In.

## Camera

Pick a camera in the node (empty = the default camera). The browser asks for permission once; camera names
appear in the list only after that. The stream opens when the first frame is requested, is shared by every node
using the same camera and resolution, and is closed about 5 seconds after nothing asks for it (and when you switch
project). Camera access needs a secure page: `https://` or `http://localhost`.

## URL / Stream

| Type | What it is | How it is read |
| --- | --- | --- |
| Picture, refreshed | a still or an IP-camera "snapshot" URL | re-fetched every N seconds (cache-busted with `_rsmps=`) |
| MJPEG stream | `multipart/x-mixed-replace`, what most phone "IP webcam" apps serve | an `<img>` the browser keeps updating |
| Video file | `.mp4` / `.webm` … that the browser can play | a muted, looping `<video>` |
| Auto | video extensions mean video file, anything else is read like an MJPEG stream (stills work too) | |

### What browsers allow (this is the part that usually goes wrong)

1. **CORS.** The page may only put a remote picture on the GPU if the server sends
   `Access-Control-Allow-Origin` (`*` or this page's origin). Without it the picture can be shown by a plain
   `<img>`, but not read. The node then says: "The server at <host> does not allow other sites to read its picture (CORS)…"
   or, when the load itself is blocked, "Could not load the picture from <host>… must also send CORS headers".
2. **Mixed content.** On an `https://` page the address must be `https://` too. `http://localhost` is exempt.
3. **Same network.** A phone on Wi-Fi is reachable at its LAN address (`http://192.168.x.y:8080/video`); the
   computer must be on the same network and no firewall in between.

### Using a phone as a camera

Run a phone app that serves MJPEG or snapshots over the LAN ("IP Webcam" style) and turn on its CORS /
"allow cross-origin" setting if it has one. During development the suite runs at `http://localhost:5173`, so
`http://` phone addresses are allowed. If the app cannot send CORS headers, put a small proxy that adds
`Access-Control-Allow-Origin: *` in front of it. WebRTC (browser-to-browser) is not supported in this version.

### How it stays live while nothing else changes

The player gives each live node a hidden `liveTick` value that grows with every render, so the evaluation
cache cannot serve a frozen picture, and while paused it keeps re-rendering at the project fps as long as a live node
feeds the viewed node. The RAM frame cache is bypassed for such graphs.

## Phone as a camera (QR)

Use a phone as a live camera without any app: scan a QR code, allow the camera, and the picture appears in the **Phone Camera**
node (`phone-camera`). It only works when you run the suite locally in LAN mode; it does not work on the hosted (GitHub Pages) build.

### Easiest: Tailscale (no certificate warning)

If Tailscale is on the computer and the phone (same account / tailnet):

1. One time, in the Tailscale admin console (https://login.tailscale.com/admin/dns) turn on **MagicDNS** and press **Enable HTTPS**.
2. Start the app with `npm run dev:lan -- --tailscale`. It asks Tailscale for a real certificate for this computer's name
   (`machine.tailnet.ts.net`, saved in the git-ignored `.certs/` folder) and prints the addresses. The phone then trusts the
   page: **no "not private" warning**, and camera access works.
3. Open the app on the computer, add a **Phone Camera** node, press **Link a phone**, choose the address "Tailscale name ... (trusted
   https)" and scan the QR code with the phone.

If `tailscale cert` fails, the message says why (usually step 1). You can also bring your own certificate:
`RSMPS_CERT=cert.pem RSMPS_KEY=key.pem npm run dev:lan`.

### Plain Wi-Fi (self-signed certificate, one warning)

1. `npm run dev:lan`. It prints the addresses best-first: the Wi-Fi/Ethernet address first, then Tailscale, then virtual adapters
   (Hyper-V/WSL/VirtualBox) which a phone cannot reach.
2. In the app press **Link a phone**; the dropdown lists the same addresses. Pick the one on the phone's network and scan the code.
3. The phone warns that the connection is not private: choose **Advanced**, then **Proceed**. This is your own computer.
4. Allow the camera. The phone shows what worked: "Reached your computer", "Code accepted", "Video connected".

**Windows firewall:** Windows Security > Firewall & network protection > Allow an app through firewall > **Node.js JavaScript
Runtime** > tick **Private**. The Wi-Fi network profile must be **Private** (Settings > Network > Wi-Fi > the network > Private).
**Guest Wi-Fi / "AP isolation"** blocks phone-to-computer traffic: use the normal network, a phone hotspot the computer joins, or
Tailscale. If no phone reaches the computer within 20 seconds the app shows this checklist next to the QR code.

### How it works and what it needs

- **Open the app from the same server the QR code points at.** The code always uses the address and port of the page you have open,
  so it reaches the server that knows the code. If another server is running on a different port (for example plain `npm run dev`),
  a phone using its address gets "This code is not known to the computer": scan the code shown by the app you are using. The
  Phone Camera link is only offered when the page comes from the `dev:lan` server.
- **The code lives 15 minutes** and the clock restarts when the phone's page first reaches the computer (time spent on the
  certificate warning is not lost). It is single use: one phone per code. A countdown is shown in the app.
- **Video travels with WebRTC** (peer to peer, host candidates only: no STUN/TURN server, nothing leaves your network; over Tailscale
  the 100.x address is used). If WebRTC does not connect within about 4 seconds the phone sends JPEG frames through the dev server
  instead (lower quality, still works through the same secure WebSocket).
- Live preview only, like the other live inputs: record it before you export.

### Security notes

- It is **opt-in**: plain `npm run dev` is unchanged (http, localhost only).
- While `npm run dev:lan` runs, **the dev server (and your project's source) is reachable by every device on the network** (and
  accepts any host name, so `machine.tailnet.ts.net` works). Only use it on a network you trust and stop it when you are done.
- A pairing token is 128 bits of randomness made on the computer. The server only relays messages between the two sides; it stores
  nothing and writes nothing to disk. Anyone who sees the QR code while it is valid could join first: disconnect when finished.
- Certificates are never committed (`.certs/` is git-ignored).

### Troubleshooting

- **The phone cannot open the address:** the first address may be a virtual adapter or a network the phone is not on. Pick another
  in the dropdown; check the firewall and the "Private" network profile above.
- **"This code is not known to the computer":** the code belongs to a different server process or an older session. Scan the QR code
  that is currently shown in the app; make sure the app tab and the phone use the same `dev:lan` server.
- **"Another phone is already connected" / "This code expired":** make a new QR code.
- **Safari says the certificate is invalid and will not connect the WebSocket:** use the Tailscale route above (a real certificate).
- **Picture stutters:** you are probably in the JPEG fallback (the phone page says "fallback mode"); lower the resolution on the phone
  page or use a network without client isolation.
