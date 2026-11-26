# Changelog

All notable changes to RipScorpy Media Processing Suite (formerly PixelArtify Studio) are documented here.

## Unreleased

## [0.35.1] - 2026-11-26

### Fixed
- **World AR: the finished video is now made after recording.** Leaving the AR view right after pressing Stop could report the view as closed before the recording had been stored, so the automatic "Save video" never started and nothing was said about it. Closing now waits for the recording to be stored; a message "Making the finished video now…" appears when the render starts, and a plain message appears whenever it cannot start. The finished file is named "AR video take …" and the untouched camera clip "AR camera clip take …" (kept in Media only), so they cannot be mixed up. The Save as video button is shown whenever the node holds a recording.

## [0.35.0] - 2026-11-26

### Added
- **World AR recordings can be saved as a video file.** After recording in the AR view, the recorded camera clip is rendered with the viewed graph's picture on top, following the recorded camera movement, and downloaded as a file and added to Media, the same way the Recorder's "effects after" mode works. With the new "Save video" switch on (the default) this starts by itself when the AR view is closed; the World AR panel also has a **Save as video** button with progress, time left and Cancel. The recording and its camera clip are kept, so the graph can be changed and the video saved again. A recording without a camera picture can be saved as the object alone. Recordings made before this version do not remember their camera clip and need recording again. Experimental: tested against a simulated AR session only.

## [0.34.0] - 2026-11-26

### Added
- **World AR Camera has a Picture output.** The live camera picture is now available from the World AR Camera node itself, so it can be wired into a Material's colour map (the room as a texture on the object) or into any effect while the AR view is open. Outside the AR view the same output gives the normal back camera, so the graph can be built and previewed in the viewer. On phones that do not hand the camera picture over in AR the output is see-through and the panel says so. Experimental: tested against a simulated AR session only.

## [0.33.1] - 2026-11-26

### Fixed
- **World AR Camera no longer stalls on "Waiting for the camera…".** While the AR view is open the phone's AR system owns the camera, so a Webcam node in the viewed graph could not get a picture and nothing was drawn. Webcam nodes now give a see-through picture during AR, so a graph such as Webcam, Merge and 3D Object shows just the object over the real camera view. The app's own camera is released when Start AR is pressed and comes back after Exit. The message shown when a picture cannot be rendered now says what to do, and sits below the phone's status bar.

## [0.33.0] - 2026-11-26

### Added
- **Sweep 360.** A new node that builds a 360 panorama over time: wire a Webcam into it and Phone Motion's Yaw, Pitch and Roll (Sensors from: This device), then turn around and each camera frame is painted where the phone is pointing, like a photo sphere. Settings: View angle (the camera's field of view), Edge softness, Paint (Always, Only new areas, Paused), Fade old, Empty look (Black, Transparent, Blurred fill), Mirror picture, Canvas height, and Clear (wire a tap to it to wipe). Output as a panorama, Tiny planet, Look around, or **Follow phone**, which shows the live picture surrounded by what was painted before. It relies on the phone's motion sensors, so it drifts, and only the area being pointed at is live; a sweep is live state and is not rebuilt by scrubbing or export. Tested with a simulated sweep only.

## [0.32.0] - 2026-11-26

### Added
- **Fake 360.** A new node that builds a full 360 panorama from one or two ordinary pictures, for example a phone's front and back cameras. The pictures are placed exactly where the cameras look (set each camera's view angle), and the rest of the sphere is filled: Mirror, Stretch edges, Blur out or Blend both. With only a front picture wired, it is reused for the back. Output as a 2:1 panorama, a **Tiny planet**, or **Look around** (an ordinary view into the panorama whose Look turn and Look tilt can be wired to Phone Motion). It is a fake: only the parts the cameras see are real.

## [0.31.0] - 2026-11-26

### Added
- **World AR Camera (experimental): the phone's own AR tracking.** A new node that uses the browser's built-in AR (WebXR, on phones that support it, in Chrome on Android) so 3D objects stay fixed in the room. Wire its Camera output into a 3D Object or Model 3D, view that node, select the World AR Camera and press **Start AR**. Move the phone until a ring appears on the floor or a table, tap to place; drag moves the object, two fingers turn and resize it; Reset, Record and Exit are on screen. On a device or browser without AR the button is greyed out with the reason, and the rest of the app is unaffected. This has only been tested against a simulated AR session, never on a real device: a small readout at the bottom right of the AR view shows numbers worth reporting back.

## [0.30.0] - 2026-11-26

### Added
- **Marker AR: objects that stay put on a printed marker.** The new **Marker Camera** node finds a printed square marker in the camera picture and works out where the camera is, so a 3D Object or Model 3D wired to its Camera output stands on the marker as you move around it. Print the marker from the node's inspector (PDF or picture, A4 or Letter, at 100% size) or show the new **AR Marker** node on a second screen. Settings: Field of view (45 degrees by default; change it if the object leans or slides), what to do when the marker is lost (keep, hide or fade), smoothing, and "Show what is found" to draw the outline and axes. Outputs include the camera, found, distance, and position / turn as vector wires. The template "An object standing on a marker" sets the wiring up. Tested on synthetic pictures only, not yet with a real camera.

## [0.29.0] - 2026-11-26

### Added
- **Vector wires: one cable for X, Y and Z.** A new wire type carries three numbers together. Wherever a node has X / Y / Z settings (Move, Rotate, Spin on the 3D nodes and many others) it also has one bundled socket, such as "Rotate XYZ", that drives all of them; two-value settings such as a centre point accept a vector wire too. The bundled sockets are an option: they stay hidden until wired, until you expand the node, or while you are placing a vector wire. A wire on a single setting still wins for that setting, and the single sockets work as before.
- **New nodes: Combine XYZ, Separate XYZ, Vector and Vector Math** (add, subtract, multiply, scale, mix, length, normalize, cross, dot). Smooth and Delay Value take vectors as well as numbers.
- **Vector outputs on Phone Motion, Motion Path and Region Info**, so for example the phone's tilt can drive an object's rotation with one wire.

## [0.28.0] - 2026-11-26

### Added
- **Move and turn 3D objects by dragging in the viewer.** Select an Object 3D, Model 3D, Shape 3D, Image to 3D or splat node and the viewer shows a small bar with **Move**, **Turn** and **Size**. Move: drag the circle; the knob beside it pushes the object away or pulls it closer. Turn: drag on the object to turn it freely, drag the outer ring to roll it. Size: drag the corner knob. Works with a finger or a mouse; one drag is one undo step; press the lit button again to put the handles away. Settings driven by a wire are left alone.
- **Reset buttons for 3D placement.** The inspector has a "Place in 3D" section with Reset position, Reset rotation (every angle to exactly 0) and Reset all, and the viewer bar has a Reset for the current mode. Glass and Hypercube get the reset buttons too.

## [0.27.0] - 2026-11-26

### Added
- **Smooth recording: effects are applied after you stop.** The Recorder has a new "Quality" setting. **Smooth, effects after** records the live pictures themselves (Webcam, Phone Camera, URL / Stream) at the camera's full frame rate, together with the sound, the live sound values and the phone's motion sensors, and renders the effects onto them frame by frame when you stop. The clip is smooth even when the preview stutters on a slow device. **As seen, instant** is the recording as before. **Automatic** (the default) uses smooth on phones and tablets. While the effects are rendered the Recorder shows progress, the time left and Cancel; the page must stay open. The untouched camera clips stay in Media ("Keep raw clips"), so the same take can be tried with other effects, and "Render again" appears if rendering was cancelled or failed. Not yet tried on a real phone.

## [0.26.1] - 2026-11-26

### Added
- **3D objects can spin around their own axes.** Object 3D, Model 3D, Shape 3D, Image to 3D and the splat viewer have a new "Spin around" setting next to Spin X / Y / Z: **The object's own axes** (the default for new nodes) or The scene's axes. On its own axes an object spins about itself however it is tilted: tilt a disc with Rotate X and Z, set Spin Y to 1, and it turns on its own tilted spindle like a record. Before, the spin was added to the rotation angles, so a tilted object wobbled round the scene's upright axis. Nodes in existing projects keep spinning the way they did until you change the setting.

## [0.26.0] - 2026-11-26

### Added
- **Hypercube node** (Generate): a cube of 3, 4, 5 or 6 dimensions (4D, the tesseract, by default) turning in its higher dimensions, drawn as glowing lines with faint glass faces. Motion looks (Slow tumble, Inside out, Through itself, Chaos, Custom), all in whole turns per loop; colours by dimension or by depth; corner dots; a transparent background to sit over a picture. A wired picture is shown on the faces of the inner or outer cube, or behind the lines.
- **Frame Array node** (Time): many frames of a clip shown at once as panes standing in 3D space, so time becomes depth. Layouts Stack, Row, Ring, Helix, Grid 3D and Tunnel; the frames can flow past a fixed "now", every pane can play, or the panes can hold still frames with a moving highlight; a swinging or orbiting camera; pane opacity, borders, fade with distance. Every pane is one more evaluation of what is wired in (10 by default, 32 at most).
- **Phone Motion: the sensors of this device.** A new "Sensors from" setting: Linked phone (as before, through the QR link) or **This device**, the phone or tablet the app is running on. A node added on a phone starts on This device. Orientation (yaw, pitch, roll), rotation rate, acceleration, shake, tilt and compass heading come from the device's own sensors, turned so "left" is left however the phone is held. The sensors are listened to only while something uses them. An **Allow motion sensors** button in the node's settings asks for permission where the browser needs it (iPhone, iPad) and shows whether values are arriving.
- **Phone Motion: Jolt and Gravity outputs.** Jolt gives a short pulse per bump; Gravity X / Y say which way is down on the screen (-1..1), for making things fall or slide. They work for a linked phone too.
- **AR Camera node** (Input): a 3D camera that follows the phone's orientation, so a 3D object stays put in the room while you turn the phone (turning only: it does not follow you walking). Wire it into a 3D object's Camera input and merge the result over the Webcam's back camera. Recenter sets straight ahead; Field of view (across the shorter side, 45 by default) is adjusted until the object stops sliding against the camera picture. Recording a take works as on Phone Motion, so an export is repeatable.
- Not included: touch on the viewer as an input (one finger already pans the view and two zoom it, so it needs its own mode), and battery, light and location.

## [0.25.0] - 2026-11-25

### Added
- **Droste Spiral: more shapes.** Copy shape now offers Picture frame, Round, Square, Diamond, Hexagon, Triangle, Star, Flower and Heart (with a Points setting for star and flower). **Petals** scallops every turn of the spiral into a flower or a cog (with depth and a spin per loop), and **Whirl** turns the copies more the further in they are, so even straight nesting becomes a whirlpool.
- **Droste Spiral: a Driver input.** Wire any picture in (Noise, an Oscilloscope, a clip) and its bright and dark parts push the spiral in and out ("Driver push") and round its middle ("Driver turn"). The push happens at every size at once, so the whole tunnel breathes with the driver. "Driver reads" chooses whether the driver lies over the frame or is wrapped along the spiral so the same disturbance repeats in every copy. Mid-grey leaves the spiral alone. Number settings such as Shrink, Rotate and Whirl can still be wired to numbers (a sound level, for example).

## [0.24.0] - 2026-11-25

### Added
- **AI Style Transfer: much stronger looks.** A new **Look** setting: Painterly (the result so far), **Material** (the picture is rebuilt out of actual pieces of the other picture, arranged along its own shapes), **Hallucination** (material, repainted twice, with the pieces crawling; the default for new nodes) and Custom, which shows Material, Piece size, Style strength (up to 2), Passes (up to 3) and Crawl.
- **A Style input.** Wire any third picture in and it becomes the material both shots dissolve into in the middle of the transition: A, then the style's hallucination, then B. A strongly textured picture (eyes, scales, feathers, cells) gives by far the strongest result; two smooth photos painted with each other stay murky.
- **Texture size** (Half / As it is / Double): how coarse the borrowed material is. Half gives a dense swarm, Double big strokes.
- **Held, no transition** under "Driven by": repaints a whole clip with the Style picture (or B) instead of making a transition. This is also what happens when B is not wired.
- **Crawl** makes the pieces reshuffle from frame to frame; Steady is its opposite. Nodes saved before this version keep the Painterly look and their stored results.

## [0.23.0] - 2026-11-25

### Added
- **AI Depth: Edge detail** (on by default). The depth map is enlarged with the picture as a guide, so its soft, blobby edges snap onto the real edges of the picture (hair lines, rims, ropes). It only moves depth edges where the picture has an edge and never copies the picture's texture into the depth. "Edge detail" 0 gives the old result exactly; "Edge reach" sets how far an edge may move. It works on the stored result, so changing it does not run the model again. AI depth in existing projects looks crisper after this update.
- **AI Depth: Detail** (Standard / High, 2 x 2 tiles / Very high, 3 x 3 tiles). The model also looks at overlapping close-ups of the picture and their fine detail is merged into the whole-picture depth, which recovers things the single run loses entirely: strands of hair, bicycle spokes, thin ropes. 4 or 9 more model runs per frame, and a larger stored result.
- No new depth model: Depth Anything V2 Base and Large, Distill-Any-Depth, Depth Pro and others were tried or checked. At the same input size none is visibly sharper at its edges than the current model (they share the same patch grid), and the better-known larger ones are licensed for non-commercial use only.

## [0.22.0] - 2026-11-25

### Added
- **Depth Scan node** (Filter): scanner effects that move through the depth of a picture. Wire the picture into Image and a depth map (AI Depth, Depth Estimate, or any grey picture) into Depth. Styles: **Scan wave** (a sheet of light at one distance, sweeping from near to far and outlining everything it passes, with an afterglow), **Contours** (lines of equal distance flowing through the scene), **Grid**, **Dots** (a laser-scanner point cloud, larger where the scene is near) and **Scanlines** (thicker where the scene is near), the last three pushed aside by the depth so they wrap round the shapes. Sweeps per loop in either direction, or a Position you can wire a number into (a sound level, for example); number of waves, line thickness, afterglow, density, depth push, colour, colour by depth, glow. The picture can stay, be dimmed, be hidden, or be **revealed** by the wave as it passes. For lines drawn in relief by a depth map, Scan Line Relief already takes one in its Height input.

## [0.21.1] - 2026-11-21

### Fixed
- **Webcam: its microphone was never opened unless the project also had a Microphone node.** The check "does this project need a microphone at all" only looked for Microphone nodes, so a Webcam on its own stayed silent whatever was wired and whether or not Hear myself was on. Both checks now use one list. The "Enable audio" button also says "+ mic" when a Webcam's sound is wired.

## [0.21.0] - 2026-11-21

### Added
- **Recorder: a Sound input.** Wire any sound into the Recorder and that is what the clip carries, whether or not you also hear it (it no longer has to reach an Audio Output to be recorded). The Recorder passes the sound on through a Sound output, so it can sit in a sound chain the way it sits in a picture chain. With nothing wired in it records the sound that is playing, as before, and says so.
- **Webcam: sound outputs.** The Webcam node has a Sound output and a Silent tap, fed by a microphone of your choice (new Sound settings: Microphone, Input gain, Hear myself, Noise gate). The microphone is opened, and its permission asked for, only once one of those outputs is wired. Wire the Silent tap into a Recorder to record the camera with its sound without hearing yourself.
- **Record button in the viewer.** While the project has a Recorder node, a Record / Stop button sits in the top right corner of the viewer: it works the Recorder you are viewing, or the first one.

### Fixed
- The audio node list check in the test suite had been failing since the Oscilloscope was added (its category was not on the list).

## [0.20.0] - 2026-11-20

### Added
- **AI Style Transfer node** (Filter): the real neural version of the style-transfer transition. Picture A is repainted by a neural network in the texture and colours of picture B and becomes B. It runs in your browser (nothing is uploaded) with the AdaIN model: two files, 27 MB together, downloaded once after you press "Download the model", checked against a fingerprint, MIT licensed (the encoder is the first layers of VGG-19). It cannot run live: press **Render** in the node's settings to paint the transition once and store it, like Codec Datamosh; before that the node shows a plain dissolve from A to B with the same timing. Driven by: A to B over the loop, A to B and back, or a part of the project. Longest side 512, 768 or 896 (larger = more squares per frame = slower), Steady (blends each painted frame with the one before, against flicker), and Painting and Ends fade, which act on the stored result without rendering again. Expect several seconds per frame on a computer's processor and more on a phone. Style Melt remains as the instant, non-AI imitation.

## [0.19.0] - 2026-11-20

### Added
- **Mandelbulb: a picture or video as its texture** (a first test of pictures as surface inputs). Wire anything into the new Texture input and it is wrapped round the bulb like a map round a globe: Texture amount mixes it with the colour set, Texture repeats and Texture spin place and turn it, and **Relief** lets the picture's bright and dark push the surface out and in, so a video makes the bulb itself move.

## [0.18.3] - 2026-11-20

### Added
- **Start screen: "Start empty" and "Only an Output" are the first and largest choices.** Start empty keeps the usual Media In wired to an Output; Only an Output starts with nothing but the Output node, for generators, text, 3D or sound.

### Fixed
- **Noise: a square with a hard corner in the picture on some graphics cards.** The corners of a noise square were numbered in a way a graphics driver may round a hair differently from one square to the next, and the noise's hash turns a hair into a completely different value: one corner then had two values. The corners are now numbered with whole numbers, which cannot round. This is in the shared noise, so it also covers Liquid Warp, Light Leak, Style Melt, Reaction Diffusion and every other node built on it. Pictures are unchanged where they were already right.
- **The start screen no longer comes back when you empty a project.** Opening a template and deleting everything but the Output threw you back to the template picker. It now only shows for a project nothing has been done to yet.

## [0.18.2] - 2026-11-20

### Fixed
- **Glass: the sparkling lines along the strip joints, and the effect being too weak after 0.18.1.** The strips are now fused into one piece of glass with a stepped face, so light no longer crosses thin air gaps between them. A new **Edges** setting follows several rays per pixel (Smooth = 4, the default; Best = 9; Fast = 1), which turns what is left at the edges of any glass shape into clean lines. The strips are strong again by default (Wedge 16 degrees, range up to 40; more colour split; the picture stands further behind the glass), this time without the noise.

## [0.18.1] - 2026-11-20

### Fixed
- **Glass: coloured pixel noise in the strips and in reeded glass.** The tilted strips were far too steep a wedge, and steeper the more strips there were, so almost every ray was trapped inside the glass and came out somewhere different for every pixel. The wedge is now an angle of its own (new **Wedge** setting, 8 degrees by default, 0 = flat strips), the pane ends on a whole strip instead of part-way through one, and reeded glass is a pane with gentle ridges instead of whole round rods. A ray that is still trapped after two bounces now shows what lies straight behind instead of noise. Projects that used the strips will look calmer: raise Wedge for a stronger throw.

## [0.18.0] - 2026-11-20

### Added
- **Glass node** (Filter): a piece of glass held in front of the picture, with light followed through it. For every pixel a ray is bent on the way into the glass, walked through it and bent again on the way out, separately for red, green and blue, so the picture is thrown aside and split into colour fringes the way real glass does it; the surface also mirrors (more at grazing angles) and glints. 14 shapes: tilted strips (wedge strips that each show a shifted copy), reeded glass, prism, sphere, cube, diamond, long crystal, lens, ring, cylinder, hexagon bar, flat pane, wavy pane, pyramid. Size, position, strip count and angle, thickness; tilt, turn and roll with a whole-turn spin on each; hand sway and drift, as if the glass were held in front of the lens (loops with the project); bending strength, colour split, picture distance, reflection, glint, frosting and glass colour. Outside the glass the picture is untouched.

## [0.17.0] - 2026-11-20

### Added
- **Style Melt node** (Filter): a transition in the manner of the "AI style transfer" transitions of late-2010s music videos. Picture A is first repainted with the colours and texture of picture B (in shuffled patches that run along A's outlines), then its shapes melt into B's, and B settles into itself; progress 0 is exactly A and 1 is exactly B. Drive it with the Progress setting (wire a number to animate it) or let it run A to B, or A to B and back, over the loop. Strength, patch size, shuffle, follow outlines, texture size, texture boost and churn. It is made without a neural network: it rearranges the texture that is there instead of inventing new texture, so it is the same family of look, not the same thing.

## [0.16.0] - 2026-11-19

### Added
- **Droste Spiral node** (Transform): the picture inside itself, for ever. Shrink ratio, spiral arms (0 = straight nesting, 1 = the classic spiral, more or negative for other windings), picture-frame or round copies, and an endless zoom in or out that loops exactly, plus spin.
- **Hyperbolic Tiling node** (Transform): tiles a disc with copies of the picture that shrink toward the rim, like Escher's Circle Limit. Sides per tile and tiles per corner (raised by itself when the pair does not fit), picture zoom, disc size, spin, a drift that slides the middle of the disc out and back, picture spin, tile edges, and black, transparent or mirrored outside.
- **Liquid Warp node** (Filter): melts the picture into flowing swirls. Looks: Under water, Melting, Marble, Acid trip and Custom (amount, swirl count, folds); strength, flow per loop, and a colour swirl like oil on water.
- **Mandelbulb node** (Generate): a fractal in three dimensions that the camera circles while its shape breathes. Power, morph, camera distance, orbit, turn and height, the fractal colour sets, background (alpha 0 for transparent), detail, steps, and a Resolution setting (half by default) because it is heavy.
- **Reaction Diffusion node** (Generate): living patterns like leopard spots, zebra stripes and coral that slowly morph. Pattern size, spots-to-maze, rounds, flow, two colours and an edge colour. Wire a picture in and the pattern grows along its shapes. Every frame is grown from scratch, so it loops and exports like any other node.

## [0.15.0] - 2026-11-19

### Added
- **Fractal node** (Generate): Mandelbrot, Julia, Burning ship, Tricorn, Newton and Phoenix. Move, zoom (each step doubles; about 17 steps before the numbers run out of digits), rotate, detail, power (more arms), eight colour sets, colour bands, and motion that loops by construction: colour cycles, spin, zoom breathing and a Julia number that circles so the shape morphs. Wire a picture in and it is stamped along the fractal's own shapes.
- **Fractal Mirror node** (Transform): folds, turns and enlarges your picture again and again, so it becomes a kaleidoscope inside a kaleidoscope. Rounds, enlarge, turn, shift, optional rosette petals, spin and breathing.
- **Kaleidoscope Regions node** (Transform): cuts the picture into squares, hexagons, irregular cells or rings and makes every region its own kaleidoscope. Each region shows its own place (the picture stays readable, broken into facets) or the same spot (a wall of identical jewels); mirrors per region, zoom, turn, random turn, spin with neighbours turning opposite ways, dark facet edges.

## [0.14.0] - 2026-11-19

### Added
- **Oscilloscope node** (Generate): draws the wave of a sound as a glowing line, like the screen of a sampler or a lab scope. Wire any sound in (a clip, the microphone, a synth, the output of effects). Time shown (2 to 250 ms), Steady (a held note stands still), styles Line, Filled, Mirrored and Dots, left to right or top to bottom, thickness, glow, line and glow colors, a background whose alpha lets it sit over another picture, and Pixel size for the blocky look of a small low-resolution screen. Works in exports like the other sound-to-picture nodes.

## [0.13.0] - 2026-11-19

### Added
- **Codec Datamosh node** (Filter): real datamoshing. The picture is compressed with a real video codec in the browser (H.264, or VP9 where that fails), the compressed stream is damaged on purpose and decoded again, so every block, smear and colour bleed is the codec's own. Remove key frames at cuts (found automatically) or at listed frames, so the new shot's motion moves the old shot's picture; Bloom repeats one delta frame so its motion piles up; "Key frame every" lets the picture heal; Compression makes the artefacts chunkier. It cannot be calculated live: press **Mosh** in the node's settings to render, mosh and store the whole project once (like a bake). Until then the picture passes through unchanged; after a change it says it is out of date and keeps showing the old mosh until you mosh again. Datamosh Span and Motion Smear remain as the live imitations.
- **HAP clips play.** HAP, HAP Alpha, HAP Q and HAP Q Alpha `.mov` files import and play like any clip. On a graphics card that reads the compressed textures directly (desktop cards) each frame is unwrapped and handed to the card as it is; elsewhere the frames are decoded on the processor, which works but is slow. Every frame is independent, so scrubbing and time effects cost one frame each.
- **Desktop app: HAP in "Make fast copy".** When the desktop app's FFmpeg has the HAP encoder, Media In's Fast copy offers HAP, HAP Q and HAP Alpha next to H.264 (sound kept as PCM). Worth it for several clips at once or clips with transparency on a desktop graphics card; the files are large. The web version is unchanged. The FFmpeg from the add-on catalogue may not include the HAP encoder: then the choice does not appear until a fuller FFmpeg build is located in the add-on settings.

### Fixed
- Camera Shake looks with steps (Walking, Running, Shoulder camera, Car ride, Earthquake) now join exactly at the end of a loop: the left-right tilt of steps needed an even number of steps per loop.

## [0.12.0] - 2026-11-19

### Added
- **Media In: "Make fast copy".** Converts a video clip to the form that plays quickest in this app and switches the node to it: H.264 (decoded by the graphics chip on phones and computers; VP9 or VP8 where the browser has no H.264 encoder) with every frame a key frame, at 720p, 1080p or the original size. Camera and phone clips store a full picture only every second or two, so scrubbing, the loop wrapping round, playing backwards and effects that read several moments (Datamosh, Motion Smear, Echo, Time Displace, Retime) have to decode many frames to show one; in a fast copy every frame costs one decode. The file is larger than the original at the same size; the original stays in Media, and the sound is kept.

## [0.11.2] - 2026-11-19

### Added
- **CRT Display: "Curved screen" switch** (Geometry). Off gives a flat picture that fills the whole frame: no curvature, no rounded corners, no dark edge cut out. It works with every preset (before, the curvature of a preset could only be removed by switching to Custom and setting everything by hand); scanlines, mask, glow and colour stay as they are.

## [0.11.1] - 2026-11-19

### Fixed
- **Retime's stop-motion now works on a live camera.** A webcam, phone camera or network stream wired into Retime with "Stop-motion fps" set looked exactly the same as without it: stop-motion asks its input for the same held moment on several frames, and a live source only ever answered with the present. Live sources now keep the picture they took for a held moment until another moment is asked for, so the camera picture steps at the stop-motion rate. Playback has to be running, since time has to move for the picture to step.

## [0.11.0] - 2026-11-19

### Added
- **Camera Shake node** (Transform): the movement of a camera in real hands: slow wander, quick tremor, tilt, the bob of steps and a slow in-and-out drift, with the motion blur a real shutter records (0.5 = a 180 degree shutter). Looks: Tripod breathing, Handheld steady, Handheld, Shoulder camera, Walking, Running, Long lens, Car ride, Documentary nervous, Earthquake, and Custom. Zooms in just enough to hide the edges (or mirror, repeat, transparent). Loops with the project.
- **Gate Weave node** (Stylize): the unsteadiness of film in the machine, moving once per film frame: slow drift along the film, a jump every frame, a trace of tilt, wavering exposure, and on worn machines frames that slip and show the frame line. Looks: 35mm camera, 35mm projector, 16mm, Super 8, Worn projector, Hand cranked, Losing the loop, and Custom. Film speed can be the project rate or 24, 18, 16 or 12 frames a second.
- **Light Leak node** (Stylize): warm glows creeping in from the edges that wander, swell and fade. Looks: Subtle warm, Warm leak, Red burn, End of the roll, Cool blue, Prism, Flash frames, and Custom.
- **Film templates** on the start screen: Super 8 home movie, 16mm documentary and 35mm cinema, each a full chain (Camera Shake, Film Stock, Halation, Film Gauge, Gate Weave, and Light Leak for Super 8).
- Film Gauge has a "Gate weave" switch, to turn its simple weave off when a Gate Weave node follows.

## [0.10.0] - 2026-11-19

### Added
- **Halation node** (Filter): the red-orange glow film makes around bright lights. The default is modelled on 35mm film: it works on light (not display values), gives clipped whites their brightness back, spreads the light that bounces off the back of the film and adds it mostly to the red layer; an even surface is left untouched. Looks for 16mm, Super 8, 65mm, film without a backing layer and black-and-white film, and unrealistic ones (Neon city, Blood moon, Toxic, Ice, Fever dream, Meltdown). Custom shows light returned, spread, highlight stops, wide share and halo color.
- **Film Stock node** (Color): 18 stocks from a model of how film layers answer light (layer mixing, per-layer speed and contrast, an S-curve with a soft shoulder, colour as dye density, a black that is not black): portrait, vivid, golden and cool green negatives, cinema tungsten and daylight, two slide films, bleach bypass, cross processed, expired, redscale, purple shift, infrared color and four black-and-white stocks. Exposure in stops, contrast, saturation, fade and strength. It is a parametric model tuned by eye, not measured data of real stocks.
- **Film Gauge node** (Stylize): the feel of a film format and its projector: Super 8, 16mm, Super 16, 35mm, 65mm, plus Home movie and Lost reel. Softness, grain, gate weave, flicker, dust and hairs, scratches, dark corners and the rounded gate edge, all sized as a share of the picture so a look is the same at every resolution. "Change every N" gives the stutter of film shot at a lower frame rate.
- For a full film look, chain them: Film Stock, then Halation, then Film Gauge.

## [0.9.3] - 2026-11-19

### Added
- **Recorder: the clip is also saved as a file.** When you stop a recording, the clip is downloaded to this device as a video file (the Downloads folder) as well as added to Media. The new "Save as a file" setting on the Recorder node turns this off. "Save last clip as file" in the node's settings saves the last recording of this session again.

## [0.9.2] - 2026-11-19

### Changed
- **Lens Distortion is much stronger and has looks.** A new Look setting with ready-made lenses: Wide lens, Action camera, Fisheye (the default), Extreme fisheye, Door peephole, Pincushion, and two corrections (Fix: phone wide lens, Fix: action camera). Custom shows mode, amount, zoom and the rest. The Amount range now reaches a full fisheye bulge; before, even the maximum was a mild bend that was hard to see on a real picture. Projects that used the node in 0.9.0 or 0.9.1 show the Fisheye look until Look is set to Custom.

## [0.9.1] - 2026-11-19

### Added
- **Webcam: "Allow camera" button.** The Webcam node's settings show whether the camera is allowed for this site and a button that makes the browser ask right now. If the camera is blocked, it says where to unblock it.

### Fixed
- **The camera permission question no longer appears at random moments.** The camera was closed and opened again whenever the graphics device was reset (phones do this, for example after the tab was in the background); it now stays open. A camera that was refused is not asked for again until you press "Allow camera", and a camera that fails for another reason (in use, unplugged) is retried every 5 seconds instead of on every frame.

## [0.9.0] - 2026-11-19

### Added
- **Lens Distortion node** (Filter): bends the picture like a lens (barrel / fisheye above 0, pincushion below), or, in Undistort mode, removes that bend from footage so straight lines are straight again. Undistort with the same amount exactly undoes Distort. Center, zoom, "Fill the frame" (zooms in just enough that no empty edge shows) and a choice of what shows outside the picture (transparent, repeated edge, mirror).
- **Glints node** (Filter): star-shaped rays from the brightest points, like a star filter on a lens. Threshold, number of star points (2 = one anamorphic streak, 4 = cross, 6, 8 ...), length, angle, intensity, ray color and "Rays only" for blending them yourself. (Round bokeh discs were already there: Lens Blur, with its highlight gain.)
- **Phone: the Graph tab shows the picture behind the nodes.** The picture fills the whole tab, the nodes float over it, and an eye button in the corner hides and shows the nodes. With the nodes hidden, touches reach the picture (zoom, pan, on-picture handles). Play and the time bar stay at the bottom.
- **Phone: the viewer strip above the Inspector can be resized**: drag the grip on its lower edge. The height is remembered.

## [0.8.0] - 2026-11-19

### Added
- **Beta notice.** A Beta badge next to the name, a note on the start screen and a section in About say that RSMPS is in early development and that many features are not fully tested, with a link to report a bug.
- **Every version is released.** When the version number in `package.json` changes on the main branch, a GitHub Release with that version's notes from this file is made automatically.
- **Recorder node** (Time): wire a picture through it and press Record in its settings: it shows that node in the viewer, starts playback and records what flows through it, with the sound that is playing, into a clip in Media (H.264 MP4, up to 30 minutes). It passes the picture on unchanged, so it can sit anywhere in a chain. "While recording": **Time runs on** (the clock keeps going until you stop, so effects keep changing instead of repeating every loop) or **Loop the project**.
- **Time can run on past the project length.** With Loop off the loop progress keeps counting past 1 instead of jumping back, which the Recorder uses while recording; inside the project length nothing changes.
- **Go live** (desktop app): stream the output with its sound to Twitch, YouTube or any RTMP address, from a button in the transport. The app records what the viewer shows together with the sound mix and FFmpeg (the add-on) sends it as H.264 + AAC at the size and bitrate you choose; a red LIVE clock shows the state and ends the stream. The stream key stays on the computer and is stored only on request. Not in the web version: a web page cannot open the connection streaming services use.
- **Play to** in the transport: choose the output device the sound plays through. Pointed at a virtual audio cable (VB-Cable, BlackHole), the processed sound becomes the microphone of another program, such as a call or a stream. Chrome and Edge on a computer and the desktop app; the choice is remembered. Recipe: "Use the app as a microphone or a camera for other programs".
- **Pitch Correct** (audio effect): tunes a voice or a single instrument to the nearest note of a scale and key, from gentle correction to the hard robotic effect (Retune 0 ms). It rebuilds the sound from pieces of the voice's own wave, so the voice keeps its character when tuned or shifted by whole semitones (no chipmunk effect); consonants and noise pass unchanged. Amount, Shift, Mix for doubling, and Low delay for singing live.
- **The camera of the phone the app runs on.** The Webcam node has a Side setting (back / front camera) for phones and tablets; on a phone a new Webcam starts on the back camera, unmirrored, and choosing Phone Camera on the website adds a Webcam instead (Phone Camera links a second phone to a computer).
- **Any picture into a mask input.** Dropping a picture wire (a gradient, noise, text, a depth map, a photo) on a mask input now adds an Image to Mask node in between, in one undo step: its brightness is the mask, or its alpha or one color. Mask sockets are no longer dimmed while dragging a picture wire.
- **Depth as a mask.** Depth from Picture, AI Depth and Depth Convert have a Mask output (near = white) that goes straight into any mask input: limit an effect to the foreground, fade it with distance. Mask Invert selects the background, Mask Levels narrows it to a band of depth.
- **Particles from a picture.** The Particles node has a Particle picture input: wire an image with transparency, a Shape or Text and every particle is drawn as that, moving exactly like the chosen type (same paths, life, fades, sizes and loop). Turn: like the type (confetti tumbles and flips, rain and sparks point along their path, the others stay upright), upright, point where it goes, or spin. "Color it" multiplies the picture by the particle colors.
- **Chords in a key.** The Chord node has "In key: triad" and "In key: seventh": pick a scale and key and every note gets the chord that belongs to it (in C major: C major, D minor, E minor ...). With Audio to MIDI in front, singing a melody plays its harmony.
- **Samsung Log** in the Color Space and LUT nodes ("Samsung Log Rec.2020"): the transfer function of the Samsung Log White Paper (2025) with its BT.2020 gamut, so From: Samsung Log, To: sRGB is the complete conversion of Galaxy log footage. Checked against the paper's table of encoded values.
- **Enable audio wires the sound.** When the picture comes from a video with sound and no Audio Output plays anything, Enable audio adds an Audio Output wired to that clip's Sound (one undo step), so what you hear is what is exported. With audio already on, a "Hear the clip" button does the same.
- **The export dialog says what sound the video gets:** what is wired into the Audio Output, the clip's own sound (with a button to add an Audio Output for it), or none and why.
- **The project takes the frame rate of its first video.** Adding the first video to a project that still has the default 24 fps sets the project to the clip's rate (25 for a 25 fps clip), in the same undo step. A rate you set yourself is never changed.
- **Record on live picture inputs.** Webcam, Phone Camera and URL / Stream nodes have a Record button: the incoming picture is saved as a clip in Media (picture only, up to 30 minutes).
- **Auto bitrate** on the Output for the built-in MP4 and WebM codecs: the first frames of an export are measured and the bitrate is set to what the picture needs. On by default; projects with a bitrate set by hand keep it.
- **Frames** field next to Length in the transport: set the project length in frames.

### Fixed
- **"Rendering was paused" when nothing was rendering.** The watchdog started a 15-second countdown at every edit, also one that needs no new picture (moving a node, a change in a branch that is not on screen, edits while an export or a scan holds the renderer, a tab in the background), and paused rendering when no new frame arrived. It now times the frame that is actually being rendered: an idle app is never paused, time in a background tab is not counted, and only one frame that takes more than 15 seconds pauses rendering.
- **Scan: leaving the scan tab no longer cancels or restarts the scan.** A scan project keeps its pages and a running scan while you work in another tab, says when it is ready, and shows the result at once when you return; before, leaving cancelled it and coming back analysed every photo again. The pages are released when the scan project is closed.
- **Scan: the progress bar no longer stands at 100 % while the frames are still being put together.** Once every photo is read it shows a moving bar and says so.
- **Audio to MIDI played many notes that were not sung.** Wide vibrato trilled between neighbouring notes, a slide or a scoop into a note played every note it passed, and the pitch dropping as a note died away started a new one. Notes now follow the settled pitch: a note starts when the voice holds still, and changes only when the voice holds another note and the centre of the pitch has moved there too. One sung note is one note (vibrato up to a semitone and a half, slides, scoops, fall-offs).
- Adding a sound effect with a Media In (or any node with a picture and a sound output) selected now inserts it into the sound chain, like picture effects join the picture chain. Before it was left unwired.
- **Ticking instead of sound** from videos recorded with uncompressed (Linear PCM) sound by phone apps such as Blackmagic Camera, in the preview and in every export. These files store the sound one recorded buffer per table entry; only one sample of each buffer was read. PCM sound in MP4 and MOV is now read from the file's own tables, which also fixes packed 24-bit sound that a file labels as 32-bit.
- Sound in MP4 and M4A exports is handed to the browser's audio encoder in whole AAC frames. In browsers whose encoder pads each call with silence, the uneven pieces sent before were heard as a regular ticking.
- Exported sound of a video was silent (and waveforms and Beat Detect went empty) after the clip had been played in the preview, when the file's sample rate equals the sound card's (usually 48 kHz): the player handed the library's decoded sound to the audio thread instead of a copy.
- Sound of 5.1 and other surround files is folded down to stereo with the centre and surround channels; before only front left and right were used, so speech was missing.
- Command line: with several batch items every exported video got the sound of the first item; a trimmed or speed-changed Media In now maps its sound exactly as the app does.
- H.264 exports from Firefox no longer start clean and turn blocky after about two seconds on busy pictures (grain, dither, analog noise).
- The "Use this value" button of the large-number warning did nothing in some fields.
- The memory bar froze while rendering was off.
- `npm run dev:lan` now keeps the app at `http://localhost:5173`, so it shows the same projects as `npm run dev`; the phone gets an https address of its own on the next port.

## [0.7.1] - 2026-11-17

### Added

- **One format registry, and the app writes most formats itself.** Every output format is one row of `src/io/export-codecs.ts` with a route: the app's own encoder, the browser's encoder or FFmpeg, and the Output node's lists, the dropdown tags, the command line and the docs are generated from or checked against it. A format that could be written two ways has one entry and the app picks the route. **HAP, HAP Alpha, HAP Q, Motion JPEG MOV, PNG MOV, a new Uncompressed MOV, animated GIF and animated PNG are now written by the app itself**, in the web version too, with no FFmpeg. HAP is compressed on the GPU (about a millisecond for a 1080p frame; the Output's "HAP quality: Better" refines on the processor, slowly) and has a "Smaller files" (Snappy) option; GIF has palette (per frame or shared), dither, colors and loop settings. The "For: VJ software" preset still never picks HAP by itself.
- **More picture formats.** The Output node's Image format (stills and image sequences) now lists, in groups, Web (PNG, WebP, JPEG, AVIF where the browser can write it), Lossless (QOI, TIFF, TGA, BMP), High dynamic range (OpenEXR, Radiance HDR, 16-bit TIFF, DPX) and Other (ICO, PPM, JPEG 2000). DPX and JPEG 2000 need FFmpeg; the rest are written by the app. OpenEXR and Radiance HDR keep values above 1.0 and are written linear (new `Gpu.readFloat`: half-float readback of the engine's rgba16float images).
- **More sound formats.** The Audio Output has a "Sound file" setting for its stand-alone export: WAV 16 / 24 / 32-bit float, AIFF and FLAC 16 / 24-bit (written by the app), AAC and Opus WebM (the browser), MP3, Opus OGG, Vorbis and ALAC (FFmpeg). A format that cannot be written falls back to 32-bit float WAV with a note in the export notes.
- **Big files stream.** MOV files the app writes are written as they are made (index at the end of the file): the desktop app writes straight to the file you chose through new `/__rsmps/export/file/` endpoints, Chrome and Edge ask where to save (File System Access API), and other browsers keep the file in memory with a plain refusal above about 1.5 GB. A 4K, 100-frame HAP export (790 MB) peaked at about 220 MB of process memory in the command line, and a 25-frame 4K export (200 MB) at 128 MB of JavaScript heap in the browser.
- **Command line:** `rsmps formats` lists every format with its route and whether it works on this machine; `--format` takes the new picture and sound formats, `--codec` the new ids (`raw-mov`), and the app's own formats need no FFmpeg. `--set Out.hapQuality=better`, `hapSnappy`, `gifDither` and the other new Output params work. `scripts/check-formats.mjs` exports and validates every available format through the real export code, and `scripts/gen-format-docs.mjs` regenerates the tables in docs/CLI.md and docs/FORMATS.md. docs/FORMATS.md is now the user-facing format guide.
- **DXV-compatible and many more video formats through FFmpeg.** One table (`src/io/export-codecs.ts`) now drives the Output node's codec list, the dropdown tags, the desktop and CLI
  FFmpeg arguments and the docs. New: DXV-compatible, HAP, HAP Alpha, HAP Q, Motion JPEG MOV, ProRes-compatible Proxy / LT / 422 / XQ, DNxHR-compatible LB to 444, CineForm-compatible (with an alpha
  variant), FFV1, UT Video, uncompressed 10-bit and RGBA, H.264 / H.265 by quality or all-intra, AV1 by quality, VP8, MPEG-2, MPEG-4, and animated WebP and AVIF.
  The dropdown is grouped (General, VJ software, Editing, Lossless, Delivery, Animated picture, Legacy). These are written by your own FFmpeg; trademarked names use the "-compatible" wording.
- **The app asks your FFmpeg what it can do.** `ffmpeg -hide_banner -encoders` is read once per FFmpeg and reported with its add-on status; a format whose encoder is missing is shown disabled with
  "not in this FFmpeg", and exporting one fails early with a plain message. The command line does the same.
- **"For" preset for video** (General, VJ software, Editing, Web / social). It resolves against what is really available (DXV-compatible, else ProRes-compatible, else all-key-frame H.264) and lists any fallback in the
  export notes. Command line: `--for vj|editing|web`, `--codec dxv|hap|hap-alpha` and the rest of the table.
- `scripts/check-ffmpeg-codecs.mjs <ffmpeg>` encodes a one-second test clip with every row of the table, re-reads it and checks alpha where claimed.
- The image sequence and audio-only formats of the table are now wired into the exporter (see above); DPX, JPEG 2000, MP3, Opus, Vorbis and ALAC go through the FFmpeg add-on in the desktop app (new `export/ffmpeg/still` and `export/ffmpeg/sound` endpoints) and through the command line's FFmpeg.

### Changed

- Bitrate and All key frames are hidden for formats that do not use them (ProRes-compatible, DXV-compatible, HAP, lossless, quality-based).
- The Output node's video codec hint, the About box and the README name Resolume, DXV, DNxHR and CineForm as trademarks of their owners.
- The viewer toolbar folds its secondary buttons step by step (pixel size, snap, magnifier and background, then frame and batch, then Snapshot / A/B / Node…, then Output) into one "…" menu when the pane is narrow, so it stays on one row at 1440 px and at most two at 1024 px. On a phone it shows only the node name and the preview scale ("Output · 25%"); everything else is in the viewer header's "…".
- "Compare with node…" evaluates the other node off screen at the current frame and preview scale, so the viewer no longer jumps to that node for a moment, and a slow node is waited for. Renaming a snapshot is an inline field instead of a browser prompt.
- Node-body labels were shortened (Top size, Input space, Output space, Edge style, Outside map, Clip fit, Image fit, Record audio and others), rows show their full text as a tooltip, and the Outputs list in the media panel no longer cuts names for the size.
- Image format and Quality only show for the Output kinds that use them. The Scan tab start screen has one set of buttons, and its title shows the tab name. The Phone Motion "not linked" note is a note, not an error; empty data fields say what is missing ("No take recorded") instead of "null". The MIDI mappings dialog is compact when empty, multi-line text fields use the normal font.
- "Sprite sheet" is the one spelling in labels and docs. Start-screen template tiles show a neutral tile with the group icon until the picture is ready (and in safe mode) instead of a black box.
- SDF 3D: the groups of shapes that are on start open again (a broken pattern kept every group closed).

## [0.7.0] - 2026-11-17

### Added

- **Beat Detect (Math and utility):** a sound in, beat numbers out: hit and beat pulses, beat and bar ramps, tempo, kick, snare and hat hits, loudness and a beat count (to step a Switch or Frame Interleave).
  Live (microphone, phone) it is a causal detector that locks onto the tempo in a few seconds; for a sound file, "Analyze sound file" listens to the whole file once and stores exact hits and beats, with
  offset, fixed tempo, double / half time and snap to loop. Exports reproduce it exactly.
- **React to sound:** right-click any number setting to wire it to loudness, the beat, kick, snare or hat in one undo step (Beat Detect and a Remap Range are added, the look does not jump); Stop reacting undoes it.
  Five new presets: Pulse with the beat, Glitch on snare, Hue cycle per bar, Strobe cut on beats, Zoom punch per beat.
- **MIDI learn on any setting:** right-click a number, switch or choice, then move a knob or press a pad. Range, curve, invert, button mode (toggle, momentary, step through), pick-up or jump takeover, several controls per
  setting, a dot on mapped settings, a MIDI mappings dialog, and Record automation (a pass of a knob becomes a Keyframes node). Mappings are saved in the project and written into the settings, so exports match.
- **Output window (performance mode):** a second, interface-free window with the viewer's picture for a projector or second monitor; full screen with F or a double-click, hidden cursor, fit / fill / 1:1, sharp pixels,
  background color, clean feed, Blackout and Freeze (rebindable keys). The desktop app opens it on a chosen or the second display.
- **Sampler:** a new "One sound per key" mode (a drum kit from a list of sounds), choke groups and Reverse.
- **Snapshots and A/B compare in the viewer:** Shift+S stores what the viewer shows (up to 12 per project, the least recently used goes first, cleared with the project). Click one to compare it with the live image:
  Wipe (draggable line with an angle), Side by side, Toggle (hold Q), Onion and Difference with gain. "Node..." compares the view with another node at this frame, and the default
  suggestion is the node's own input ("what did this node change"). Zoom and pan are linked; comparing while playing can lower the frame rate.
- **Render queue:** File > Render queue... or Export > Add to render queue. Add this project, another open tab or a saved `.rsmps.json` file; switch outputs on and off per job, give a
  file name pattern, reorder, duplicate, skip, pause, cancel, retry. Jobs survive a reload (a job that was running comes back as "interrupted"). Processes that must run first run
  before each job. Files go into a folder you choose once (browsers with the File System Access API) or download as one zip per job. Nothing shuts the computer down.
- **Start screen and templates:** an empty project shows tiles by group (Pixel art, Video art, 3D, Paper & scan, Audio-reactive, Color, Captions) and your recent projects; File > New from
  template... opens the same gallery. 14 templates in the preset format, tested against the real node registry; most need no media.
- **Share a look by file or link:** File > Share this look... writes the graph without media as a small `.rsmps.json` file or copies a link (the data sits after the `#`, so it is never sent
  to a server). Opening a shared file or link asks first, shows what is inside (node types, custom shader, plugins it needs) and opens it in a new tab. It is treated as untrusted data:
  size and depth limits, an inflation cap, unsafe keys removed, live camera and web sources removed, groups validated.
- **Stop-motion capture (File > Stop-motion capture...):** camera in, a big capture button (Space or Enter), onion skin of the last 1 to 3 pictures with opacity and a difference ghost,
  a filmstrip with delete, reorder, duplicate and per-drawing holds, shoot on ones, twos or threes, preview at the project frame rate, timelapse, grid and level, best-effort exposure
  and focus lock. The result is a picture sequence in the media library. (Using the phone itself as the tripod camera is not done yet.)
- **Splat from Video (desktop app, optional add-ons):** a clip or a photo set in, a 3D Gaussian splat scene out, plus the camera move of the original
  shot as a Camera output (match-moving: render the scene, or other 3D nodes, from the real camera path). The node picks frames along the camera
  movement (sharpest in each stretch), then its Reconstruct process runs two separate open-source programs on your computer: COLMAP (BSD-3-Clause)
  finds the cameras and Brush (Apache-2.0) trains the splats. Neither is bundled: Plugins > Official add-ons downloads them from their GitHub releases
  only when you press Install (pinned version, size and SHA-256, license shown; a NVIDIA-accelerated COLMAP is a separate choice; Locate uses
  copies you already have, the only way on Linux for COLMAP). Draft / Normal / High training presets, sequential or exhaustive matching, incremental
  or global solving, solved cameras kept for re-training. Everything runs locally; nothing is uploaded. See docs/SPLATS.md.
- **Gaussian Splat:** "Fade tiny splats" is now off by default. Files from standard trainers (Brush, the original 3DGS) are not trained with that
  compensation; with it on they looked washed out and see-through (measured on a trained scene: 2.6 dB lower PSNR, SSIM 0.82 instead of 0.90).
- **Group nodes:** select nodes and press Ctrl+G: they become one node wired exactly as before (Ctrl+Shift+G puts them back). Double-click (or Tab) opens a group in the same graph view with a
  breadcrumb and Group Input / Output markers (drop a wire on their "+" to add a port); Esc closes it. Expose inner parameters on the group (right-click > Expose on group, or the Exposed list
  in the inspector: search, rename, reorder), set its title, color stripe and description, rename its ports. Groups nest, save, undo, copy and paste like any node, and cost nothing: the
  engine flattens them, so a grouped graph renders the same pixels with the same work. Frames moved to Shift+G.
- **Repeat groups:** apply a chain of nodes N times (Chain: each pass on the previous one; Accumulate: each pass on the original, blended over the result so far). The Iteration node gives
  the pass number so any parameter can change per pass; Count can be wired or animated (up to 64). See "Fall into a logo, recolored at each pass" in docs/RECIPES.md.
- **Cache regions:** Bake selection (Ctrl+Shift+B) now groups the selection and bakes the group: a named region that costs nothing once baked, goes live again when anything inside or
  before it changes, and never re-bakes by itself. Cache / Bake nodes still work (right-click > Bake with Cache nodes).
- **Saved nodes:** "Save as node..." keeps a group in your add menu (with a name, category, keywords and description); Export node file writes a small `.rsmps-node.json` that anyone can drop
  on their graph. Files are data only and are checked on import (known node types, nesting, size). Adding one makes an editable copy, not a live link. `io.nodePresets` is the API.

- **Materials on flat pictures:** Material 2D (a picture's transparency becomes a bevelled object lit by any Material node: chrome, gold, plastic, clay, glass that refracts a Background, toon, hologram, wire contours; aimable and
  sweepable light, fill light, shadow, per-art-pixel lighting for pixel sprites, optional Normal map and Height outputs), Normal Map (brightness, silhouette bevel or a height picture to a normal map, OpenGL / DirectX, tileable, 4 / 8
  direction pixel-art normals) and Displace by Map (red / green, brightness gradient, normal map or optical-flow driven warp with edge modes, prism split, whole-cycle map scroll and art-grid snapping).
- **Materials everywhere in 3D:** the Material input now works on custom 3D models (the model's own UVs for color and normal maps, triplanar when it has none) and on 3D Array (lit cards, with the Material's normal map and new light
  settings on the node). Graphs without a Material render exactly as before.
- **AI Depth (optional):** real depth maps from a small neural model (Depth Anything V2 Small, Apache-2.0) that runs on your own
  GPU, in the browser and the desktop app; nothing is uploaded. The 50 MB model is not included and is never downloaded by
  itself: Plugins > AI models has a Download button (pinned version, SHA-256 checked, license and source shown, Remove). The
  AI Depth node is a process node: it shows the quick Depth from Picture guess until you press Estimate depth, then stores a
  steady 16-bit depth for the whole clip (each frame fitted onto the previous one, one range for the clip, optional smoothing
  in time, Every N frames, 392 / 518 / 700 model size). Same output convention as Depth from Picture, so Picture to Splats,
  Lens Blur, Depth Slice and Image to 3D take it unchanged. Without WebGPU it runs on the processor, slowly, and says so.
  The command line cannot run the model; it uses a stored result or the usual process export gate.
- **Game assets (docs/GAME_ASSETS.md):** Sprite Sheet In (a sheet from a wired picture or a file, sliced by grid, by the gaps between sprites or by pasted Aseprite / TexturePacker JSON with trimmed frames, durations and animation tags; plays as an animation or as batch items, with trim, anchor, ping-pong and frame lists).
  The Output's sprite sheet got layouts (grid, single row / column, shelf-packed), trim, padding, extrude, power of two, a maximum page size with several pages, per-frame pivot, one sheet from every batch item with a tag per item, metadata as generic JSON (the old keys are
  all still there), Aseprite JSON, TexturePacker JSON or CSS sprites, a "For" preset (Godot, Unity, GameMaker, RPG Maker, Web: starting points) and a Bleed color option that writes straight-alpha PNGs with the nearest opaque color under transparent pixels. The same from the command line
  (`--for`, `--sheet-layout`, `--trim`, `--extrude`, `--pot`, `--max-sheet`, `--sheet-meta`, `--sheet-from`, `--bleed`) plus `--report json|text` (size, colors, frames and off-palette fraction per file).
- **Pixel look tools:** Pixel Outline (inside / outside, 4 or 8 connected, selective darker-neighbor or palette color, per side, second outline), Sprite Shadow (drop, ground, contact; solid or dithered), Pixel Cleanup (hard alpha, stray pixels, 1 px holes, edge colors, elbow trimming),
  Palette Lock (snap / highlight / report with off-palette and color counts) and Batch Palette (one shared palette for a whole set, read by a process job). Tiles: Make Seamless (offset blend, mirror, edge match, pixel-art mode), Autotile (the 47 tile blob set or the 16 tile edge set from five pieces) and Tileset Map (paint a terrain mask with that set, one GPU pass).

### Fixed

- Video export in Firefox: H.264 files stored their frames out of order with timing that strict players cannot honor, which
  showed as a stutter or a held frame at the loop point (seen in Resolume). The export now measures the browser's encoder with
  a few tiny frames first and keeps every frame in order, starting at time 0; in Firefox that means the H.264 Baseline profile.
- The export says so when the browser cannot encode the chosen codec and another one was used, and every exported video is
  checked after writing (frame count, order, start time).
- Output: new "All key frames" option for loops played in VJ software and for editing.
- The GPU memory budget can be raised up to 24 GB (was 4 GB).

- **Screenshot QA pass over the desktop layout:** inspector labels wrap instead of being cut off, the viewer status chip keeps the node name when the toolbar wraps, the selection toolbar no longer hides under the graph toolbar, long inspectors (SDF 3D) start with their groups closed, the AI Depth and Splat from Video panels no longer overflow, group ports no longer break onto two lines, "1 keys" is "1 key", and user-visible text uses US spelling (color, gray, center, analyze). The Logo fall template now shows its effect (a letter with a hole, which Infinite Zoom needs).

- A duplicated or pasted node no longer shares its bake or analysis result with the original (the copy starts unprocessed), and stored results that nothing references any more are
  removed when the project is loaded.
- The "run processes before export" question uses the app's own dialog instead of the browser's.

## [0.6.0] - 2026-11-16

### Added

- **Arrays:** Array (grid, line, ring, endless tiling, per-copy steps and time offset), Infinite Zoom (fall into a picture
  forever, recoloured per level), 3D Array (cards in a grid, tunnel, ring or helix), Scatter, Kaleidoscope.
- **Time:** Feedback, Time Displace, Optical Flow, Motion Smear, Frame Interleave (weave several clips frame by frame),
  Render Scale (compute everything before it at a lower resolution and enlarge it back: the look of the playback preview).
- **3D:** Image to 3D (extrude or lathe any picture, walls from the edge pixels, depth-map relief), SDF 3D (blended shapes,
  morph, repetition), a shared Deform group (noise, twist, bend, melt, explode, morph), a Material node with eleven looks,
  and a depth output on the 3D nodes.
- **Gaussian splats:** a Gaussian Splat node for .ply and .splat files, and Picture to Splats (a picture plus a depth map
  becomes a splat cloud, on video too).
- **Colour grading:** White Balance (linear light), Saturation / Vibrance (luminance preserving), Lift Gamma Gain with
  ASC CDL, Curves with hue curves, Exposure, Colour Space, LUT (.cube), Qualifier (colour key to mask), Scope.
- **Paper:** blank sheets for drawn animation, onion-skin rounds, exposure sheet, holds, rotoscope sheets (faint, outline,
  blue) with guide removal, paper layers, flipbook and zine layouts, ink separations, SVG for pen plotters, a scanned
  texture shelf with a Paper / Texture Overlay node.
- **Phone:** motion sensors (orientation, shake, touch pad) as a Phone Motion node with a camera rig, recorded takes with
  smoothing; Scan with phone (shoot sheets straight into the Scan tab and preview the result on the phone); the phone can
  link without a camera.
- **Process mode:** nodes can run long jobs in the background behind a stand-in; Bake and Track (Analyse clip) use it; a
  Processes list; exports run pending jobs first.
- **Subtitles** node: .srt and .vtt (or typed lines) as styled, animated captions with chunk, karaoke and typewriter
  layouts, safe areas for vertical video and a built-in pixel-art look.
- **Depth from Picture** (an instant depth guess from simple cues, with paint corrections) and Depth Convert.
- **Media panel:** collapses to a rail, bins saved with the project, type filters, search, list view, usage badges.
- Specks / Dropouts node; type selector to convert between Merge, Mix, Stack and Switch; full-resolution frame button and
  preview scale readout in the viewer; desktop update notice.

### Fixed

- Joining two outputs: every wire of both outputs now follows the new Merge.
- Number fields no longer jump to huge values when clicked.
- Analog Video dropouts no longer line up in columns; they are now editable specks.
- Digital Glitch is rebuilt around abrupt, bursty events of ten kinds; graphs that used the old node load with a different look.

### Changed

- Sheets are scanned in parallel and each photo scans about twice as fast.
- No two nodes share a name (3D Camera, Webcam, Audio Echo, Frame Echo, Audio Timeline and others were renamed; old names
  still work in search), names and labels use one spelling (Color, Gray, Center), and parameter labels are short.

## [0.5.0] - 2026-11-16

### Added

- **Media Timeline** node: a small video editor inside the graph. Wire in any number of picture and sound sources, arrange
  them as clips on tracks (move, trim, split, fades, cross-dissolve) and get one picture and one sound output. It can set
  the length of the whole project.
- **Custom Shader** node: write a WGSL effect in the inspector, with examples, wire-able sliders and compile errors shown
  on the node.
- **Recolor** node: fill (a black logo becomes white, transparency kept), ink on paper, swap one colour, duotone.
- 3D Object: "Custom model…" in the shape list loads a .glb, .gltf or .obj; the primitives stay the default.
- Pixelate takes a mask and can keep the source size. Dither and Quantize have a Pixel size, so a masked or tracked
  region of full-resolution footage is dithered on a coarse grid in one node.
- Cache / Bake: bake a node or a selection to stored frames from the inspector, the selection toolbar, the context menu
  or Ctrl+Shift+B; baked regions are dimmed and marked stale when something upstream changes.
- Safe mode and crash recovery: after an unclean exit the app starts with rendering paused and offers to undo the last
  change or open a backup. Rolling backups per project (File > Backups), a Pause rendering switch, an error screen
  instead of a blank page, and in the desktop app a reload-in-safe-mode path when the window or GPU process dies.
- Memory popover with a real breakdown, a RAM budget and cache quality.
- CLI: `print` output kind. Touch: pinch-zoom and two-finger pan on the graph. About dialog.

### Fixed

- Any edit anywhere dropped every cached playback frame; only edits that feed the viewed node do now.
- Heavy graphs never filled the playback cache, so loops re-rendered on every pass.
- Tracking repeated detection for frames it had already analysed.
- Pixel Sort used several gigabytes of GPU memory at 4K.
- Dither on masked regions ran per source pixel (slow and too fine).

### Changed

- A version tag now publishes a source-only GitHub Release; desktop installers are built by a manually started workflow.
- README showcase uses the author's own footage and scans.

## [0.4.0] - 2026-11-15

A ground-up rewrite. Graphs and presets saved by earlier versions do not load.

### Changed

- New engine: every node is a self-contained file that receives real data on its sockets and returns real data. Node order
  is honoured everywhere, including on video. The old fixed pipeline is gone.
- Rendering runs on a single WebGPU device; WebGL2 and the CPU fallback are removed. WebGPU is required.
- Lengths are authored in unit pixels and scaled per image, so mixed-resolution batches and the playback proxy match.
- Animation loops by construction when Loop is on; nothing animates by default.
- New interface generated from node definitions: categorised add menu, inline controls on nodes, built-in colour picker,
  Palette Studio, rebindable shortcuts and per-node hotkeys, layer lists, chain insertion.

### Added

- More than 160 nodes across Generate, Color, Filter, Stylize, Pixel Art, Transform, Composite, Mask, Layers, Detect & Track,
  Time, Math, Audio Source, Audio Effects and Synth & MIDI.
- Audio and MIDI pipeline in the same graph: microphone, pitch to MIDI, synths, effects, mixing; sound can drive any
  number parameter.
- Camera node (perspective, orthographic, isometric, fisheye, panoramic, cylindrical) for 3D objects.
- Subject mask, edge-fill inpainting, layer splitting and looping parallax.
- Detect & Track nodes with regions-to-mask, overlays, trails, follow-crop and stamping.
- Print sheets with machine-readable markers, and a Scan tab that rebuilds frames from photos of the printed sheets.
- Headless CLI on the same engine, with PNG sequences and ProRes 4444 with alpha.
- Plugins are single-file node definitions, stored in the browser and restored on reload.
- Safe mode (`?safe`) to open a project without rendering.

### Fixed

- The last group of dither algorithms (pattern, palette-blend, Riemersma), blue noise and Shiau–Fan were incorrect and
  have been rebuilt.

### Removed

- The old engine (`src/core`), interface (`src/app`) and CLI.

## [0.2.1] - 2026-11-13

### Fixed

- Self-contained Animate/Timeline graphs no longer ask for a Media input when
  rendering animation. The Output inspector now shows **Render animation** and
  renders the composited node tree directly; the video-input button is hidden
  when no video source exists. The video button also delegates to the animation
  renderer if a self-contained animation is present.
- Animation export estimate and output frame count now follow the Animate or
  Timeline fps.

## [0.2.0] - 2026-11-13

### Added

- **Background node** — solid colour, linear/radial gradients, checkerboard,
  stripes, grid, dots and noise. Connect media to place the pattern behind it,
  or use it as a standalone generated image.
- **3D object node** — cube, sphere, cylinder, cone, torus and pyramid rendered
  with an orthographic camera, z-buffer and Lambert shading. Rotate, move,
  scale, zoom and light the object; composite it over media or a background.
- **Animate node** — formula-driven continuous motion with a Motion output.
  Drive 3D objects and backgrounds with `t`, `frame`, `lt`, trig, interpolation
  and clamping functions. Includes duration/fps/loop controls and horizontal or
  two-axis wrap modes, plus a viewer timeline with play/pause and scrubbing.
- **Timeline node** — stretches still media across a chosen duration and frame
  rate so animated effects, grain and overlays can play over an image.
- **Retime node** — stop-motion sampling down to a lower frame rate, and a
  block-matching optical-flow mode that interpolates new frames for smoother
  output. Applied during video/spritesheet export; stop motion also previews
  with a quantised video clock.
- **Animated film grain and noise displacement** — enable **Animate** on either
  effect in the Pre-process or Post-process inspector.
- **Timeline animation export** — the Output inspector can render Animate or
  Timeline graphs to video, spritesheet or both.
- **Node groups** — Ctrl/Cmd-click nodes, then group them. Groups can collapse
  to a single box with combined input/output dots, be duplicated as a whole
  (including internal wires and input assets), or be ungrouped.
- **GPU layer compositing** — the final Compose layers blend now runs through a
  WebGL2 ping-pong compositor with automatic CPU fallback.
- **GPU edge maps** — Sobel/chroma gradients and non-maximum suppression now run
  on the GPU inside the sampler.
- **Preset CPU warnings** — the preset browser shows an amber `!` and the exact
  CPU-heavy stages used by a preset.
- **Direct-canvas playback** — video and animation playback paint straight to
  the preview canvas without PNG encoding or a React render per frame.
- GPU layers badge and improved CPU warning text for layer inpainting and
  detail high-pass layers.

### Changed

- Processing before a generator is now baked before the generated pixels are
  added. A 3D object added near the end of a graph is no longer re-pixelated,
  dithered or post-processed by nodes that came before it; only downstream
  nodes affect it.
- Adding an Output node now makes it the active preview.
- Small-art working supersampling was reduced to 2×.
- Version bumped to 0.2.0.

### Fixed

- Playback freeze caused by `requestAnimationFrame` throttling when the page
  lacked focus.
- Duplicate React keys in the asset rail after applying presets.
- Stale preview image encoding during playback.
- Frame-rate and duration handling for stop-motion and interpolation exports.

## [0.1.0] - 2026-11-11

- Initial public release: node graph, edge-aware pixelation, palettes, dithering,
  preprocessing/postprocessing, layers and inpainting, magic mask tracking, GPU
  sampler/dither/resize/effects, presets, batch/video/spritesheet/A4 export,
  CLI and documentation.
