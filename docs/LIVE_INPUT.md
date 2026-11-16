# Live picture inputs

Two input nodes bring a live picture into the graph: **Webcam** (`camera-in`) and **URL / Stream** (`url-in`).
They work in the live preview only. Exports and headless runs have no camera or network picture, so the node
shows an error there: record the source to a file first and use that file as Media In.

## Webcam

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

### What the phone page does: modes

The pairing link opens the page in one of three modes (an optional `&mode=camera|scan|controller` after the unchanged token; no parameter means camera, as before). The three buttons at the top of
the page switch between them, and the computer can switch a phone that is already linked (the Scan tab does this to reuse a linked phone instead of showing a second QR code).

| Mode | The phone sends | The link counts as complete when |
| --- | --- | --- |
| **Webcam** | camera picture (WebRTC, JPEG fallback) and microphone | frames arrive (as before) |
| **Scan** | full-resolution photos of printed sheets, see PRINT_AND_SCAN.md "Scan with phone" | the phone's `hello` arrives |
| **Controller only** | motion, touch, location (the Motion section) and no picture | the phone's `hello` arrives |

The phone says what it does with a small typed message, `hello {mode, media}` (`media`: `video`, `none` or `refused`), at every connect and every mode change. Without a picture the link no longer waits for
camera or microphone frames: if you refuse the camera, or choose Controller only or Scan, the pairing ticks complete (the third one reads "Scan mode ready", "Controller linked" or "Phone linked (no picture)")
and the phone shows as connected in the app. A Phone Camera node of such a phone has no picture to show. Camera mode with a working camera is unchanged: connected means video frames are flowing.
The page also says in one line that pictures, photos and motion go only to your own computer over this link.

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

### The phone's microphone

The phone page asks for the camera and the microphone together. If one is refused the other still works (camera only, or sound
only: a wireless microphone). The sound travels in the same direct WebRTC link as the picture and appears on the **Phone Camera**
node's `Sound` and `tap` outputs, for example into Sound to Numbers, an Audio Timeline's `recordAudio`, or a MIDI-from-audio chain. It is
raw (no echo cancellation, noise suppression or automatic gain; mono) and is **never played** on the computer or the phone, so there
is no feedback. The phone page has a Microphone on/off button and a level meter. In the JPEG fallback there is no sound; the app
says "Video only: ... Sound needs a direct connection". Starting the audio engine (the Enable audio prompt) is still a click.

### In the desktop app

The packaged desktop app (RSMPS for Windows, macOS, Linux) needs no command line: **Link a phone** starts a small https server
inside the app, only for as long as you use it.

- The first time, a native dialog asks "Allow phones on your network to connect to RSMPS?" (Allow / Not now, with "Don't ask
  again"). The **Phone** menu shows "Phone link: Off / On", the addresses a phone can use (click to copy) and two settings.
- On Windows the system firewall then asks whether RSMPS may talk on the network: allow it on **private** networks. RSMPS never
  changes firewall rules itself. If you press Cancel, phones cannot connect; open Windows Security, Firewall, "Allow an app through
  firewall" and tick RSMPS for Private.
- The server serves only the phone page, `/__rsmps/ping` and the pairing WebSocket; everything else is 404. It listens on a stable
  port (47831 unless that is taken), uses a self-signed certificate made on first use in the app's data folder (the phone shows the
  usual warning once: Advanced, Proceed), and stops by itself when the last Phone Camera link is closed or after 10 minutes
  without use, and when you quit.
- Tailscale: in **Phone > Use Tailscale certificate when available**, RSMPS runs `tailscale cert` and phones that open the
  Tailscale name get a trusted certificate (no warning). It needs the `tailscale` command and HTTPS enabled for your tailnet.
- Everything else (QR code, camera, microphone, troubleshooting) works as described above.

## The phone as a controller (motion, touch, location)

The phone page also has a **Motion** section. Press **Start motion** and the phone streams its gyroscope orientation, rotation rate, acceleration,
touch pad and (only if you turn them on) location and AR position to the computer, over the same secure WebSocket that already links it. No second
connection is opened. The **Phone Motion** node (`phone-motion`) turns it into numbers for any setting; **Phone 3D Camera Rig** (`phone-camera-rig`) turns
yaw / pitch / roll into a camera. Nothing is sent until you press Start; streaming stops while the phone page is hidden or the screen is locked.

### What the phone sends

Small JSON text frames (about 120 bytes each, at most 60 per second, one per animation frame; the rate can be lowered to 30 or 15 on the page). Both the dev server and the
desktop app relay text frames untouched (they share `PhoneSessions`), so neither needed a change.

| Message | Fields |
| --- | --- |
| `caps` | which sensors exist (`orientation`, `motion`, `absolute`, `geo`, `ar`, `touch`, `ios`), the rate cap and what is switched on. Re-sent after every change and after a reconnect. |
| `motion` | `t` (phone clock, ms), `q` orientation quaternion [x y z w] (W3C alpha/beta/gamma with the screen orientation applied), `abs` (1 = referenced to north), `h` compass heading (iOS), `r` rotation rate deg/s, `a` acceleration without gravity and `g` with gravity (m/s²) |
| `touch` | up to 5 touches `[id, x, y, pressure]` (0..1 across the pad), pinch scale `ps`, twist `tw` (deg), two-finger pan `pn`, gesture counter `g` |
| `geo` | metres east / north of the first fix, speed, altitude change, accuracy (never absolute coordinates) |
| `ar` | WebXR viewer pose: position (m) and quaternion |
| `mevent` | `recenter`, `tap`, `doubletap` (a double tap on the pad recenters) |

The computer checks every frame (a bad one is ignored), maps the phone's clock to its own, keeps a short buffer and answers 40 ms behind "now" with
spherical interpolation, so Wi-Fi jitter does not show. Every number a node reads in one render comes from the same instant.

### Sensors: what works where

| | iPhone (Safari) | Android (Chrome) |
| --- | --- | --- |
| Permission | One tap on **Start motion** raises the system prompt (`requestPermission` has to come from a tap). If refused: Settings > Safari > Motion & Orientation Access, reload the page. | None needed. |
| Orientation (gyro) | yes | yes |
| Rotation rate, acceleration | yes | yes (a few cheap phones have no gyro) |
| Absolute yaw (north) | from the compass heading (`webkitCompassHeading`), corrected on the fly; drifts a little when the compass is disturbed | `deviceorientationabsolute`, steady |
| Touch pad | yes | yes |
| Location | separate permission, only when you tick it | same |
| Position tracking (AR) | not available (no WebXR in Safari) | only where `immersive-ar` is supported (ARCore). **Not tested on a real device.** The checkbox is hidden elsewhere. |
| Needs https | yes | yes (the phone link already is) |

What drifts and what does not: the gyro's pitch and roll are anchored by gravity and do not drift. **Yaw** (turning) is relative on iPhone and on Android
without the compass: it starts at the pose where you pressed Recenter and can creep slowly, so press **Recenter** (or double-tap the pad) whenever it
wanders. The compass heading is absolute but noisy near metal and speakers.

**Position is not computed from the accelerometer.** Double-integrating acceleration drifts by metres within seconds, so no number from it is offered.
Position comes from, in this order: **AR tracking** (Android, if you turn it on), else **location** (metres from where you started: only useful outdoors,
metres accurate), else the **touch pad as a virtual dolly** (two fingers pan = x / y, pinch = z, and it stays where you leave it). Recenter zeroes all three.
The inspector says which one is active.

### Phone Motion

Wire any output into any number setting. Angles are degrees and continuous (they keep counting past ±180 instead of jumping). Yaw turns right, pitch looks up,
roll tilts clockwise. **Angles**: *Relative to Recenter* (default; the first pose is neutral until you press Recenter) or *Absolute*, which falls back to relative on a phone without a compass.
Per-axis sensitivity, invert, dead zone, limit and a "tilt for full stick" range shape the response; **Smoothing** removes shake with little lag (one-euro filter).
Outputs: yaw / pitch / roll, **Object rotate X / Y / Z**, rotation rate, acceleration, shake (0..1), tilt X / Y (-1..1, a joystick), touch X / Y, touch count, pinch, twist, pan, compass
heading, position X / Y / Z and a tap pulse. To steer a 3D Object wire **Object rotate X / Y / Z** into its *Rotate X / Y / Z*: they are computed in exactly the
order 3D Object applies its rotation, so even large tilts match the phone (plain yaw / pitch / roll use the camera order and agree with it only for small tilts).
The phone's acceleration *with* gravity is shown in the panel only (it differs between iOS and Android) and is not an output.

### Recording a move (and exporting it)

**Record motion** in the inspector captures every channel until you press **Stop** and stores it on the node as a take: keyframes at the project fps, quantised and
simplified so it stays small. The node then has **Source: Live / Recorded take**. A recorded take is deterministic and needs no phone, so exports and the command
line reproduce it exactly. In **Live** mode an export (or a headless run) uses the take if one exists and otherwise stops with an explicit message: live phone
input does not exist there (the same rule as Phone Camera).

- **Loop take** (+ *Loop blend*) cross-fades the last frames into the first so the move repeats without a jump. Smoothing then wraps around the seam.
- **Take smoothing** smooths the recording at read time (non-destructive, 0 = as recorded) with a zero-lag filter, so the move is not delayed; rotations are smoothed on the
  rotation manifold, not per angle. **Keep fast moves** smooths small jitter more than large deliberate motion. **Smooth take** bakes it in as one undo step; **Reset to raw**
  brings back the original recording (it is always kept); **Delete take** removes it.
- Not offered: converting a take into Keyframes nodes (a take is time-based; Keyframes curves are per loop).

### Phone 3D Camera Rig

Wire Phone Motion's yaw, pitch and roll (and, optionally, position X / Y / Z, scaled by *Units per meter*) into the rig; it outputs a normal camera that goes into any
3D node. Without a wired camera it uses the 3D Camera node's defaults. *Look around* turns the camera where it stands (the phone is a window); *Orbit mode* swings the camera
round the target instead, always looking at it; *Lock roll* keeps the horizon level; *Height offset* raises it.

### Other sensors that could be used

Already in: touch (multi-touch pad), compass, location, AR pose. Possible next: the **microphone** (already available through Sound to Numbers), the **ambient light sensor**
(`AmbientLightSensor`, behind a flag in Chrome), **camera-based tracking** (face or hand tracking on the video link is possible but heavy) and **Bluetooth or gamepad** devices
paired with the phone. Proximity and barometer are not exposed to web pages.

### Privacy

Sensor data goes only over the existing authenticated link to your own computer. Location is off unless you turn it on (its own permission prompt), is sent relative to where you started,
and is never stored unless you record it into a take. Nothing is sent to any other server.

### What can only be confirmed on a real phone

The iOS permission prompt, the actual sensor values and signs on a given phone (iOS and Android report acceleration with gravity with opposite signs), compass-corrected yaw on iPhone, landscape
rotation, the touch pad feel and multi-touch limits, location, the AR toggle, and how the 3D Object follows the phone visually (the maths is tested; a mirrored axis is fixed with *Invert*).
