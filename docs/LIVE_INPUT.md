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

Use a phone as a live camera without any app: scan a QR code, allow the camera, and the picture appears in the
**Phone Camera** node (`phone-camera`). It only works when you run the suite locally in LAN mode; it does not work on the
hosted (GitHub Pages) build.

### Steps

1. Stop the normal dev server and start the LAN one: `npm run dev:lan`. It prints the addresses (for example
   `https://192.168.0.5:5173/`). Open that address on the computer (not `localhost`, so the phone can reach the same origin).
2. Add a **Phone Camera** node, open its inspector and press **Link a phone**. A QR code appears.
3. Scan it with the phone's camera app and open the link. The phone shows a warning that the connection is not private:
   choose **Advanced**, then **Proceed**. This is your own computer's self-signed certificate.
4. Allow the camera. The phone shows a big status line; when it says "Sending your camera" the picture is in the node.
   The phone page can switch camera (rear by default), change resolution and toggle the torch where supported, and keeps the
   screen awake. It reconnects by itself after a network hiccup.
5. **Disconnect** in the inspector (or close the phone page) ends the session. Sessions live in memory: after reloading the app
   make a new QR code.

### Requirements and limits

- **Same Wi-Fi / network.** Both devices must be on the same network. Guest Wi-Fi often has "client isolation" (AP isolation)
  which blocks phone-to-computer traffic: use the normal network or a phone hotspot the computer joins.
- **https is required by phones** for camera access, which is why LAN mode uses a self-signed certificate.
- **Video travels with WebRTC** (peer to peer on the LAN, host candidates only: no STUN/TURN server is configured and nothing
  leaves your network). If WebRTC does not connect within about 4 seconds the phone sends JPEG frames through the dev server
  instead (lower frame rate and quality, but it works through more networks).
- Live preview only, like the other live inputs: record it before you export.

### Security notes

- It is **opt-in**: plain `npm run dev` is unchanged (http, localhost only).
- While `npm run dev:lan` runs, **the dev server (and your project's source) is reachable by every device on the network.**
  Only use it on a network you trust, and stop it when you are done.
- A pairing token is 128 bits of randomness made on the computer and embedded in the QR code. It is single use: one phone per
  token, it expires 5 minutes after it was made if nobody joined, it ends when the computer page closes, and a wrong token
  is rejected. The server only relays messages between the two sides; it stores nothing and writes nothing to disk.
- Anyone who sees the QR code while it is valid (a screenshot, a shoulder surfer) could join first. Disconnect when finished.

### Troubleshooting

- **Windows firewall prompt:** when Node asks for network access, allow it on **private networks**. Without that the phone
  cannot reach the computer.
- **The phone cannot open the address:** check it is on the same Wi-Fi, that the address in the QR code is the computer's
  LAN address, and that no VPN is taking over the route. If the computer has several addresses, the app puts the one of the
  page you opened into the code (open the app via the LAN address you want).
- **"Waiting for the phone" never ends:** the certificate warning page may still be open on the phone; proceed past it.
- **Picture stutters:** you are probably in the JPEG fallback (the phone page says "fallback mode"); lower the resolution on
  the phone page or use a network without client isolation.
