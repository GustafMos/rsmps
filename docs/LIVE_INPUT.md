# Live picture inputs

Three input nodes bring a live picture into the graph: **Webcam** (`camera-in`), **URL / Stream** (`url-in`) and
**Phone Camera** (`phone-camera`, see "Phone as a camera (QR)" below). They work in the live preview only. Exports and
headless runs have no camera or network picture, so the node shows an error there: press **Record** on the node to save
the picture as a clip in Media, then use that clip with Media In.

## Recording a live picture

Each of the three nodes has a **Record** button in the inspector. Press it, and the incoming picture is recorded; the button
shows **Stop** and the running time. Press Stop and the clip appears in the Media library as an ordinary video (a note says
so, with its length). Wire it into the graph with a Media In node; the graph is not changed for you.

- The button is available once the node shows a picture: view the node (or something after it) first.
- Picture only, no sound in this version.
- The clip has the size of the incoming picture (the long side is at most 1920 pixels, sides are even numbers) and the
  project frame rate (between 5 and 60 fps). It is H.264 in an MP4 file, or VP9 in a WebM file where the browser cannot
  encode H.264. Frames carry the real time they arrived at, so the clip plays at real speed even when the computer was busy.
- The clip looks like the node's output: Mirror (Webcam, Phone Camera) and Rotate (Phone Camera) are applied. Freeze is
  not: the camera keeps being recorded while the node holds a frame.
- One recording at a time. A recording ends by itself after 30 minutes or 1.5 GB (it is held in memory until it is saved)
  and is still saved. It is also stopped and saved when the node is deleted or another project is opened.
- A browser tab in the background runs timers slowly, so a recording made while the tab is hidden has few frames. Keep the
  tab visible while recording.
- Names look like `Webcam take 2026-11-17 18.42.05.mp4`, `Phone take ...`, `Stream take ...`.

## Webcam

Pick a camera in the node (empty = the default camera). The browser asks for permission once; camera names
appear in the list only after that. The stream opens when the first frame is requested, is shared by every node
using the same camera and resolution, and is closed about 5 seconds after nothing asks for it (and when you switch
project). Camera access needs a secure page: `https://` or `http://localhost`.

## Stop-motion capture

File > Stop-motion capture... opens a camera panel for frame-by-frame animation. Start the camera, press **Capture** (or Space / Enter; browsers do not hand volume keys to web pages, so
a Bluetooth remote only works when it sends one of those keys). The last 1 to 3 pictures are laid over the live view as an **onion skin** (opacity slider; "Ghost difference" shows only what
changed). The filmstrip lets you reorder, duplicate and delete drawings and give one drawing a longer hold; "Shoot on" sets ones, twos or threes for all. **Capture every N s** takes
timelapse pictures on a fixed grid. "Lock exposure and focus" asks the camera for manual exposure and focus (only some cameras allow it from a browser; the panel says what the camera offers).
Where the browser has ImageCapture the still is the camera's full-resolution photo, otherwise the current video frame. **Save to library** stores a picture sequence at the project frame rate
(holds are baked in); **Save and open** also opens it in a new project (Media In to Output). Everything stays on your computer.

Not done yet: the phone as the capture rig (a `stopmotion` phone mode next to camera, scan and controller, with the onion skin shown on the phone). The pure transfer state it needs (chunks, acks,
size checks) is already in `src/io/stopmotion.ts` (`FrameTransfer`) and tested; the phone page and the link negotiation are not written. Until then use the Phone Camera node to see the phone live.

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

- **Two addresses, one server.** On the computer the app runs at `http://localhost:5173`, the same address as plain `npm run dev`
  (a browser stores projects per address, so both modes show the same projects). Phones need https for camera access, so LAN mode
  opens a second, https address on the next free port (5174) that passes everything on to the same server; the QR code points there.
- **Open the app from the same server the QR code points at.** The code always uses the address and port of the page you have open,
  so it reaches the server that knows the code. If another server is running on a different port (for example plain `npm run dev`),
  a phone using its address gets "This code is not known to the computer": scan the code shown by the app you are using. The
  Phone Camera link is only offered when the page comes from the `dev:lan` server.
- **The code lives 15 minutes** and the clock restarts when the phone's page first reaches the computer (time spent on the
  certificate warning is not lost). It is single use: one phone per code. A countdown is shown in the app.
- **Video travels with WebRTC** (peer to peer, host candidates only: no STUN/TURN server, nothing leaves your network; over Tailscale
  the 100.x address is used). If WebRTC does not connect within about 4 seconds the phone sends JPEG frames through the dev server
  instead (lower quality, still works through the same secure WebSocket).
- Live preview only, like the other live inputs: press Record on the node and use the clip to export (see "Recording a live picture").

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
| `geo` | meters east / north of the first fix, speed, altitude change, accuracy (never absolute coordinates) |
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

**Position is not computed from the accelerometer.** Double-integrating acceleration drifts by meters within seconds, so no number from it is offered.
Position comes from, in this order: **AR tracking** (Android, if you turn it on), else **location** (meters from where you started: only useful outdoors,
meters accurate), else the **touch pad as a virtual dolly** (two fingers pan = x / y, pinch = z, and it stays where you leave it). Recenter zeroes all three.
The inspector says which one is active.

### Phone Motion

Wire any output into any number setting. Angles are degrees and continuous (they keep counting past ±180 instead of jumping). Yaw turns right, pitch looks up,
roll tilts clockwise. **Angles**: *Relative to Recenter* (default; the first pose is neutral until you press Recenter) or *Absolute*, which falls back to relative on a phone without a compass.
Per-axis sensitivity, invert, dead zone, limit and a "tilt for full stick" range shape the response; **Smoothing** removes shake with little lag (one-euro filter).
Outputs: yaw / pitch / roll, **Object rotate X / Y / Z**, rotation rate, acceleration, shake (0..1), tilt X / Y (-1..1, a joystick), touch X / Y, touch count, pinch, twist, pan, compass
heading, position X / Y / Z, a tap pulse, a **Jolt** pulse (one per bump or flick) and **Gravity X / Y** (which way is down on the screen, -1..1: upright is (0, -1), flat on a table (0, 0); wire them
into a position to make things fall). To steer a 3D Object wire **Object rotate X / Y / Z** into its *Rotate X / Y / Z*: they are computed in exactly the
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

### This device's own sensors (the app running on a phone or tablet)

When the app itself runs on a phone or tablet, no second phone and no LAN mode are needed: set **Sensors from** to **This device** on Phone Motion (or AR Camera). A node added on a
phone or tablet starts that way, the same way the Webcam starts on the phone's own back camera. The device's `deviceorientation` / `devicemotion` events are fed into the same motion
session a linked phone feeds (`src/io/device-sensors.ts`, session name `this-device`), so smoothing, Recenter, recording a take and exporting from a take are the same code.

- **When the sensors run.** Only while something reads them: a node that feeds the viewer, or the node's inspector being open. A few seconds after the last read the listeners are removed.
- **Permission.** Android Chrome asks nothing: the values simply arrive (the page must be https, which the hosted app is). iPhone and iPad deliver nothing until you press
  **Allow motion sensors** in the inspector and answer the browser's question. The app never asks by itself. The panel says what it sees: receiving, waiting, blocked, not a secure page,
  or "no motion sensors" (a computer).
- **Screen rotation.** Orientation, rotation rate, acceleration and gravity are given along the screen as it is shown now, so "tilt left" is left in portrait and in landscape.
- **Compass.** The orientation comes from the steady gyro-only sensor; where the browser also has a north-referenced one (Android Chrome's `deviceorientationabsolute`, the iPhone's compass
  heading) it is used only to know where north is, for *Angles: Absolute* and the heading output.
- **What is there.** Orientation, rotation rate, acceleration, shake, jolt, gravity, compass. Not there on this device: the touch pad, position and location outputs (they stay at their
  neutral values). Touches on the viewer already zoom and pan the picture and move the on-picture handles, so they are not also turned into numbers.
- **Privacy.** The values never leave the page.

### AR Camera (a 3D camera that follows the phone)

**AR Camera** (`ar-camera`) outputs a normal camera whose direction is the phone's, so a 3D Object stays where it is in the room while you look around. It follows turning only: walking is
not tracked, so the scene moves with you. It reads the orientation as a rotation (a quaternion), not as three angles, so pointing the phone straight up or down works like any other direction.
The orientation it uses stays true to gravity (the horizon is level wherever you press Recenter); **Recenter** only decides which direction is straight ahead.

- **Field of view** must match the real camera for the object to stick to the camera picture: it is measured across the picture's shorter side (like 3D Camera), about 40 for a phone's main
  camera in wide (16:9) video and about 52 in 4:3. Turn slowly and adjust until the object stops sliding.
- **Distance** is how far in front of you the middle of the 3D scene is; **Eye height** raises the camera so the scene sits lower. **Smoothing** calms the camera; too much makes the object trail.
- Same sources and takes as Phone Motion: *Sensors from* (this device or a linked phone), **Record motion**, *Source: Recorded take*, take smoothing. An export needs a recorded take, and the
  camera picture under it must be recorded too (the Webcam's Record button, or the Recorder node): record both in the same go if they have to match.
- Recipe: `docs/RECIPES.md`, "A 3D object that stays put in the room".

### Other sensors that could be used

Already in: touch (multi-touch pad), compass, location, AR pose. Possible next: the **microphone** (already available through Sound to Numbers), the **ambient light sensor**
(`AmbientLightSensor`, behind a flag in Chrome), **camera-based tracking** (face or hand tracking on the video link is possible but heavy) and **Bluetooth or gamepad** devices
paired with the phone. Proximity and barometer are not exposed to web pages.

### Privacy

Sensor data goes only over the existing authenticated link to your own computer. Location is off unless you turn it on (its own permission prompt), is sent relative to where you started,
and is never stored unless you record it into a take. Nothing is sent to any other server.

### What can only be confirmed on a real phone

For this device's own sensors: that tilting the top of the phone away from you raises Pitch and turning to the right raises Yaw, that Gravity X is above 0 with the right edge lower, that
landscape reads like portrait (it assumes `screen.orientation.angle` is 90 with the top edge to the left), that the iPhone's question appears from the button, and the AR Camera's field of view and lag against the camera picture.

The iOS permission prompt, the actual sensor values and signs on a given phone (iOS and Android report acceleration with gravity with opposite signs), compass-corrected yaw on iPhone, landscape
rotation, the touch pad feel and multi-touch limits, location, the AR toggle, and how the 3D Object follows the phone visually (the math is tested; a mirrored axis is fixed with *Invert*).

## MIDI learn: any setting from a knob, fader or pad

Right-click any number, switch or choice, in the inspector or on a node, and pick **MIDI learn**. Move a knob, push a fader, press a pad or bend the wheel on any connected controller: the
next message binds to that setting. A small orange dot on the setting shows that it is mapped and pulses as the control moves. **Unlearn MIDI** removes it. **MIDI mappings...** (the same menu,
or the **Output** button in the viewer) lists every mapping and edits it:

| Column | What it does |
| --- | --- |
| Low / High | The value at the bottom and top of the control. Defaults to the setting's usual range (not its extreme limits). Low above High turns the control around. |
| Curve | Linear, Exponential (fine control at the bottom) or Logarithmic (fine control at the top). |
| Invert | Flips the control. On a switch it makes a momentary pad turn the switch off while held. |
| Buttons | For switches and choices. Toggle: each press flips it. Momentary: on while held. Step through: each press moves to the next option of a choice and wraps. |
| Takeover | **Pick up** (default): after the setting was changed by hand, by undo or by another control, a knob does nothing until it passes the setting's value, so there is no jump. **Jump**: the setting follows the control at once. |

Several controls can drive one setting and one control can drive several settings. A mapping is stored in the project (`midiMap`, next to the media bins), is undone with the project,
and the mapped value is written into the setting itself, so a saved project, an export and the command line see exactly what you played. A sweep of a knob is one undo step.
A setting that a wire already drives ignores its mapping. Mappings of nodes inside a group wait until you open that group.

**Record automation** (mapping dialog, or the setting's menu): the project loops, you play the control for one pass of the loop, and the movement becomes a **Keyframes** node wired to the
setting, simplified to a handful of keys, so a performance becomes editable keyframes.

**Permissions.** MIDI uses the browser's own permission: the first MIDI learn asks. If it was blocked, allow MIDI for the site (the lock icon in the address bar, Site settings) and try again.
The desktop app already grants MIDI to its own window. Projects that have mappings listen again by themselves only when the browser already allows MIDI, so opening a project never shows a surprise prompt.
No hardware was available while this was written: it is tested with simulated messages (byte decoding, matching, curves, takeover, buttons, undo, recording and storage are unit tests).

## Output window (performance mode)

**Output** in the viewer bar (or Ctrl+Shift+O, rebindable under Keyboard shortcuts) opens a second window that shows only the picture, with no interface. Drag it to the projector or second monitor
and press **F** or double-click for full screen (Esc leaves it); the cursor hides after 2 seconds. The main window keeps everything. In the window:

| Key | |
| --- | --- |
| F or double-click | Full screen |
| B (Alt+B in the main window) | Blackout |
| Space (Alt+F in the main window) | Freeze the picture |
| 1 / 2 / 3 | Fit / Fill / Pixels 1:1 |

The Output menu also sets nearest-neighbor scaling (on by default, right for pixel art), the background color, a clean feed (no on-screen hint at all) and, in the desktop app, which display it opens
on (automatic = the first display that is not the main window's). **It shows what the player renders, so the playback proxy applies**: the output is as sharp as the viewer's Preview percentage.
Pause and use Full res, or lower the proxy, when you need the sharpest still. Keep the main window visible (not minimized): the picture is drawn by it.

How the picture gets there: the viewer's canvas is captured into a video in the popup (`captureStream`), so no JavaScript touches a frame and a frame is only sent when the player drew one, at the cost of about one
frame of latency. If the browser gives no picture that way within 1.5 seconds it switches to copying the canvas every animation frame, which has no extra latency but costs a copy. If the browser blocks the window,
allow pop-ups for the site (the icon at the right of the address bar) and press Output again. Not tested on a real second monitor or projector.

## Beat Detect: live and analyzed

**Beat Detect** (Math and utility) turns a sound into numbers: `Hit` (a pulse that jumps to 1 on every sharp sound and fades over *Pulse ms*), `Beat pulse`, `Beat ramp` (0 to 1 through each beat),
`Bar ramp` (through each bar, *Beats per bar*), `Tempo` (BPM), `Kick`, `Snare`, `Hat` (hits in the low, mid and high band), `Loudness` and `Beat count` (a whole number that grows by one per beat: wire it into a Switch
index or a Frame Interleave to step through pictures). Wire any sound into its Sound input. Because the audio engine only runs a node that has something wired in, **the Sound input must be wired in both modes**.

* **Live** (microphone, phone audio, or any file you did not analyze): a causal detector. It reports hits about 15 to 30 ms after they sound and locks onto the tempo after about 4 to 5 seconds of steady music.
  The grid then runs ahead of the sound (negative *Offset ms* pre-compensates a slow display). It follows slow tempo changes, and lets go of the tempo after about 4 seconds without a beat.
* **Analyzed** (a sound file): choose the file under *Sound file*, press **Analyze sound file** in the inspector. The whole file is listened to once, hits and a beat grid are stored in the node, and the outputs are
  then a pure function of the time: exact, with look-ahead, identical in every export, and correct after seeking. Wire the same file (an Audio File, or a Media In) into the Sound input. Nudges for the analyzed grid:
  *Offset ms*, *Fixed tempo* (a steady grid at that BPM on the first analyzed beat), *Double time*, *Half time*, and *Snap to loop*: with Loop on, if the loop is within 0.12 of a beat of a whole number of beats, the
  beats are made to divide the loop exactly (off by default; it also makes the grid steady).
  Sound that only exists as the output of the audio graph (a mixed Audio Timeline) cannot be analyzed ahead of time: a process job can read a file or a recorded take, not the rendered graph. Use Live for those, or record the take.

Exports do not need the analysis: they replay the audio graph offline and the detector gives the same numbers on every run. Analyzing makes them exact and better than the live detector.

Right-click a number setting and pick **React to sound** to wire it in one step: Loudness, Beat pulse, Kick, Snare, Hat, Any hit or Beat ramp go through one shared Beat Detect and a **Remap Range** node into the setting. The setting's
current value is the value at silence (the look does not jump); the Remap's *To max* is how far it goes. It is one undo step; **Stop reacting** removes the wiring and restores the value. The presets
Pulse with the beat, Glitch on snare, Hue cycle per bar, Strobe cut on beats and Zoom punch per beat show it ready made.
