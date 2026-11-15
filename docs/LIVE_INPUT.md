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
