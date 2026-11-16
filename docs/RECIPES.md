# Recipes

Ready-made graphs live in `src/io/presets/*.json` and appear in the app's preset list. Each one has an empty
**Media In**: drop your own picture or footage onto it. This page explains how the looks are built, so you can
make your own variants by hand.

## Blue scan glow (the electric-blue line figure)

The look: a subject drawn only in glowing horizontal lines (fat where it is bright, thin where it is dark),
scattered soft orbs, wavy dashed vertical lines down the left, a field of fine speckle on the right, all blue on black.
The preset is called **Blue scan glow**. To build it by hand:

1. **Media In**: your footage, ideally a person against a plain background. Set the project to 1080 x 1920 for a portrait look.
2. **Subject Mask** then **Cutout**: removes the background so only the subject is drawn. (Skip both if the background is already black.)
3. **Levels** (black point 0.15, white point 0.95): spreads the subject's shading over the full range. This matters:
   the line thickness comes from brightness, so a flat grey subject gives flat lines.
4. **Scan Line Relief** (`line-modulation`): the heart of the look. Line count 130, thickness 3.4 px, displacement 9 px,
   smoothing 3 px, *Bright = thicker* 1, *Light lines* 1, glow 0.9, line colour electric blue
   (0.12, 0.45, 1), background black. More lines = finer; thicker lines = raise Thickness (and lower Line count).
5. **Bloom** (threshold 0.3, radius 16, intensity 1.2): gives the lines their halo.
6. **Particles** twice (type Fireflies, own colours blue/light blue): one layer of 9 large orbs (size 90) and one of 45 small ones (size 22).
   Merge them over a black **Solid** with blend *Add*. They loop exactly.
7. Dashed wavy verticals: **Pattern** (Stripes, angle 90, cell 54, width 2, blue) multiplied by a second **Pattern**
   (Stripes, angle 0, cell 18, width 8, black/white) in a **Merge** set to *Multiply*: that cuts the lines into dashes.
   Feed that into **Noise Displace** (amount 26, feature size 220, evolution 1) to make them wave, then merge it with *Add*
   and a **Gradient Mask** that is 1 at the left edge and 0 in the middle, so it only shows on the left.
8. Speckle field: **Noise** (scale 2, 1 octave) into **Threshold** (level 0.86, light colour blue, dark colour black): sparse blue dots.
   Merge with *Add* through a **Gradient Mask** that is 0 in the middle and 1 on the right.
9. Final **Bloom** (threshold 0.2, radius 40, intensity 1.0) over everything so the orbs and lines share one soft glow, then **Output**.

For a different colour change the line colour (step 4), the Particles colours, the Pattern colour and the Threshold light colour
(and the Bloom tint). For a warmer, more "oscilloscope" look use white or green lines with less glow.
Everything that moves (orbs, wavy lines) is driven by the project loop, so the result loops when the project loops.

## Other presets

**Pixel art + CRT**: Pixelate to 180 rows, extract a 16-colour palette from the result, dither it (Bayer 4x4) and send it through
CRT Display (arcade). CRT Display enlarges small pictures by a whole number so the phosphor mask has room to show.

**Game Boy handheld**: greyscale, pixelate to 144 rows, dither to the four-green Game Boy palette, then CRT Display in its
flat LCD look with a little ghosting (phosphor persistence) like the slow LCD of the original.

**VHS tape**: Analog Video (VHS preset, animated) for colour bleed, tracking noise and dropouts, plus a touch of chromatic
aberration, scan lines, film grain and a vignette.

**Composite console (NTSC)**: Pixelate to 224 rows, then Analog Video (console preset) which turns dither patterns into the
rainbow fringes of a real composite cable, then CRT Display (consumer TV).

**Halftone print**: a little extra contrast and saturation, then CMYK Halftone with 8 px dots at 25 degrees.

**Scan line relief**: the same Scan Line Relief node as above in a cyan-on-black style with a soft bloom. Try raising the
displacement for a mountain-range look, or turn on *Occlusion* for a ridge-line plot.

**Echo trails**: Warped Echo with ten fading echoes, each a little smaller, shifted and hue-turned. With moving footage the echoes
come from earlier frames; on a still image they are copies of it.

**Parallax from one image**: Subject Mask finds the main subject, Split Layers cuts it from the background (and fills the hole behind it),
and Parallax moves the two at different speeds in a gentle loop.

**Sprite outline + palette swap**: Pixelate, cut the subject out, draw a one-pixel dark outline around it, then swap the sprite's own
(extracted) colours for the PICO-8 palette.

**Scanned drawing clean-up**: Paper Clean (flatten light, whiten paper, fade pale guides), Despeckle (remove dust), Line Art (crisp
solid lines) and Upscale (edge-sharpened 2x). Put the **Scan** frames in through Media In.

## Morph between two clips on the beat

1. Add two **Media In** nodes and drop clip A on one and clip B on the other.
2. Add **Morph / Transition** (`transition`). Wire clip A into **A** and clip B into **B**. Pick a style: for a dither look use
   *Dither · Ordered 4×4*, *Blue-noise dissolve* or *Halftone dots grow*; *Pattern size* sets how big the dither cells are.
3. Drive **Progress** (it is also a socket) from the music: add **Sound to Numbers** (`audio-level`) on your audio and wire its
   *Loudness* (or *Bass*) into a **Smooth** node, then the Smooth output into Progress. Set Sound to Numbers *From* 0 and *To* 1 so a loud
   beat pushes the picture towards B and silence falls back to A. With **Note Pulse** (`midi-trigger`) from a drum track instead, each hit
   flicks the morph, and Smooth's attack and release shape the flick.
4. For a morph that needs no music, wire an **Animate** node (Sine, 1 repeat per loop) into Progress: A turns into B and back, looping exactly.
   **Morph / Transition (timed)** does the same with its own start, length, hold and ping-pong controls.
5. B is fitted to A's frame, so clips of different sizes work. Progress 0 is exactly A and progress 1 is exactly B in every style.

## ASCII video with terminal glow

1. **Media In** with a clip, then optionally **Color Adjust** (contrast 1.15) so there is more range for the characters to show.
2. **ASCII Art** (`ascii-art`): Characters *Classic ramp*, Character width 8 px, *Match by* **Shape** (edges become `/ \ | _`),
   Colour **Terminal** (green phosphor), Contrast 1.5, Glow 0.8. Raise Character width for chunkier text, or pick *Braille dots* with
   a small width for a fine, almost photographic look.
3. For a crisp export, set *Output size* to **Exact character grid**: the picture is exactly columns × font width pixels, so the
   text is pixel-perfect (the second output, *Glyph mask*, is the text shapes alone, for compositing).
4. Add **CRT Display** (Trinitron or consumer preset) after it for scan lines and a curved screen. The finished chain is the
   **ASCII terminal** preset.

## Edit several clips into one video

1. Add a **Media Timeline** (`media-timeline`, category Time). Wire each clip into its **Clips** input: a **Media In** with a video, a
   generator, or a whole effect chain: anything that produces a picture. Every new wire is added at the end of the timeline, with the
   file's own length (5 s when it is not known), so three wires already make a playable sequence. A file with sound also gets a linked
   sound clip.
2. Select the node and press **Open editor** in the inspector: a strip opens under the graph. Drag a clip to move it (also to another
   track: higher tracks are in front), drag its edges to trim, drag the corner handles to fade, **S** splits at the playhead, **Del**
   deletes, edges snap to other clips and the playhead (hold **Alt** to move freely). Double-click a clip for opacity / volume and
   exact fades. Clips that overlap on the same track cross-dissolve over the overlap.
3. Tick **Set project length** (in the strip or the inspector) so playback and export are exactly as long as the edit. The Length field
   in the transport is then locked to it.
4. For sound, wire the node's **Sound** output into an **Audio Output**; that is what you hear and what is exported with the video. Sound
   from a wired source that is not a file (a synth, for example) goes into the **Sounds** input: it is gated and faded by its clip but
   cannot be moved in time.

Only the clips visible at the current frame are evaluated, so a long edit of heavy sources costs the same as one clip.
Fit decides how clips of another shape sit in the frame (Fit inside, Fill, Stretch); the Background color shows where no clip is.

## Weave several clips frame by frame

Add a **Frame Interleave** (`frame-interleave`, category Time) and wire two or more videos into **Sources**; the wire order is the order of the sources (reorder the wires like layers). Only the one source that the current frame needs is evaluated, so the node costs one source evaluation per frame (two with Blend) and, with Blend 0 and sources of the project's size, no GPU pass at all: it hands on the picture it pulled. It has no sound: take that from one source or from a Media Timeline.

"v2f3" below = source 2, its frame 3. These are the first 12 output frames (they are the node's tests, word for word).

**Alternate** (mode *in-step*): output frame n shows source (n mod count) at its own frame n. The length is unchanged; each source is seen every Nth frame.

| sources | frames 1 to 12 |
| --- | --- |
| 2 | v1f1 v2f2 v1f3 v2f4 v1f5 v2f6 v1f7 v2f8 v1f9 v2f10 v1f11 v2f12 |
| 3 | v1f1 v2f2 v3f3 v1f4 v2f5 v3f6 v1f7 v2f8 v3f9 v1f10 v2f11 v3f12 |
| 5 | v1f1 v2f2 v3f3 v4f4 v5f5 v1f6 v2f7 v3f8 v4f9 v5f10 v1f11 v2f12 |

**Every frame of every source, longer** (mode *every-frame*, Timing *Make it longer*): nothing is skipped, the result holds the frames of all sources combined, so it is N times as long. Tick **Set project length** and fill in **Source length** (filled in for you from the first wired Media In) to make the project that long.

| sources | frames 1 to 12 |
| --- | --- |
| 2 | v1f1 v2f1 v1f2 v2f2 v1f3 v2f3 v1f4 v2f4 v1f5 v2f5 v1f6 v2f6 |
| 3 | v1f1 v2f1 v3f1 v1f2 v2f2 v3f2 v1f3 v2f3 v3f3 v1f4 v2f4 v3f4 |
| 5 | v1f1 v2f1 v3f1 v4f1 v5f1 v1f2 v2f2 v3f2 v4f2 v5f2 v1f3 v2f3 |

**Every frame, keep the length** (Timing *Keep the length*): every source shows the same moment within a cycle and time moves at normal speed. This differs from the alternate mode: there source 2 shows frame 2 where here it shows frame 1.

| sources | frames 1 to 12 |
| --- | --- |
| 2 | v1f1 v2f1 v1f3 v2f3 v1f5 v2f5 v1f7 v2f7 v1f9 v2f9 v1f11 v2f11 |
| 3 | v1f1 v2f1 v3f1 v1f4 v2f4 v3f4 v1f7 v2f7 v3f7 v1f10 v2f10 v3f10 |
| 5 | v1f1 v2f1 v3f1 v4f1 v5f1 v1f6 v2f6 v3f6 v4f6 v5f6 v1f11 v2f11 |

**Pattern**: one number per source, how many frames in a row it holds per cycle (empty = 1 each; a list of the wrong length or a bad number falls back to 1 each and the node says so).

| case | frames 1 to 12 |
| --- | --- |
| 2 sources, pattern 2,1, alternate | v1f1 v1f2 v2f3 v1f4 v1f5 v2f6 v1f7 v1f8 v2f9 v1f10 v1f11 v2f12 |
| 2 sources, pattern 2,1, longer | v1f1 v1f2 v2f1 v1f3 v1f4 v2f2 v1f5 v1f6 v2f3 v1f7 v1f8 v2f4 |
| 2 sources, pattern 2,1, keep length | v1f1 v1f2 v2f1 v1f4 v1f5 v2f4 v1f7 v1f8 v2f7 v1f10 v1f11 v2f10 |
| 3 sources, pattern 1,1,3, alternate | v1f1 v2f2 v3f3 v3f4 v3f5 v1f6 v2f7 v3f8 v3f9 v3f10 v1f11 v2f12 |
| 3 sources, pattern 1,1,3, longer | v1f1 v2f1 v3f1 v3f2 v3f3 v1f2 v2f2 v3f4 v3f5 v3f6 v1f3 v2f3 |
| 3 sources, pattern 1,1,3, keep length | v1f1 v2f1 v3f1 v3f2 v3f3 v1f6 v2f6 v3f6 v3f7 v3f8 v1f11 v2f11 |

**Hold** shows each step for that many frames (shoot on twos), after the pattern; **Start offsets** (frames, one per source) move a source in time.

| case | frames 1 to 12 |
| --- | --- |
| 2 sources, hold 2, alternate | v1f1 v1f2 v2f3 v2f4 v1f5 v1f6 v2f7 v2f8 v1f9 v1f10 v2f11 v2f12 |
| 2 sources, hold 2, longer | v1f1 v1f1 v2f1 v2f1 v1f2 v1f2 v2f2 v2f2 v1f3 v1f3 v2f3 v2f3 |
| 2 sources, hold 2, keep length | v1f1 v1f1 v2f1 v2f1 v1f5 v1f5 v2f5 v2f5 v1f9 v1f9 v2f9 v2f9 |
| 3 sources, hold 3, longer | v1f1 v1f1 v1f1 v2f1 v2f1 v2f1 v3f1 v3f1 v3f1 v1f2 v1f2 v1f2 |
| 2 sources, pattern 2,1, hold 2, longer | v1f1 v1f1 v1f2 v1f2 v2f1 v2f1 v1f3 v1f3 v1f4 v1f4 v2f2 v2f2 |
| 2 sources, offsets 0,2, alternate | v1f1 v2f4 v1f3 v2f6 v1f5 v2f8 v1f7 v2f10 v1f9 v2f12 v1f11 v2f14 |
| 2 sources, offsets 0,3, longer | v1f1 v2f4 v1f2 v2f5 v1f3 v2f6 v1f4 v2f7 v1f5 v2f8 v1f6 v2f9 |

A source past its length starts over (**Loop sources**, on by default; the length is *Source length*, or the project length when that is 0) or stays on its last frame.
**Blend** above 0 mixes each picture with the previous one (one more source evaluation and one pass per frame). **Fit to frame** is for sources of other sizes
(Fit inside is the default; sources that already have the frame size are never copied).
With Loop on, the project length should be a whole number of cycles (cycle = sum of the pattern x hold); otherwise the last cycle is cut and the node's summary says
"cycle of 5 does not divide 96 frames".

## More presets

**ASCII terminal**: Color Adjust, then ASCII Art in green terminal colours with glow.

**Dither morph (two clips)**: two empty Media In nodes (A and B) feed Morph / Transition in an ordered-dither style; an Animate node drives
its Progress with one smooth A to B to A cycle per loop.

## Video feedback and time tricks

Time nodes ask their input for other frames, so they need moving footage (a still picture comes back unchanged and costs nothing). Costs below are per
frame while playing forward.

- **Tunnel / trails (Feedback, Time)**: Media In, then Feedback with Zoom 1.03, Turn 2 deg, Hue shift 4, Gain 0.93, Memory 30. The trail is a bounded fold over
  Memory to twice Memory frames (so any frame renders alone and a looping project loops); playing forward the previous result is reused: 1 pass and 1 input
  evaluation per frame. After a jump in time the first frame replays up to 2x Memory frames. Wire a noise image to Warp to make the trail wobble.
- **Slit scan (Slit Scan, Filter) / Time Displace (Time)**: every row shows a different moment, or a map picture chooses the moment per pixel (black = now, white =
  Range seconds away). A horizontal gradient map gives a column scan, noise gives ghostly melting time. N slices = ceil(N / 8) passes and one input
  evaluation per distinct frame, never more than the frames in the range.
- **Optical Flow (Detect & Track)**: outputs `flow` (rg = motion as a fraction of the picture per frame, right and down positive; use it with any node that reads
  an image as a displacement) and a colour wheel (hue = direction). About 11 small passes at half resolution; lower Flow resolution to make it cheaper.
- **Motion Smear (Time), the datamosh look**: Media In straight into Motion Smear, New key frame every 24, Block size 16, Bleed 1.2. Each key frame is held and then
  dragged along the clip's measured motion, so shapes bleed and melt until the next key frame. Choose a refresh interval that divides the loop length
  so the loop seam lands on a key frame. Wire a second clip to Held frame to drag that picture along the first clip's motion.

## Fall into a logo forever (Infinite Zoom)

A black logo that contains a smaller copy of itself in its hole, forever, with a different colour on each pass, falling in a perfect loop.

1. **Media In** (your logo with transparency, or a drawing: put it through **Recolor** in Ink mode first so the paper becomes transparent).
2. **Infinite Zoom** after it. Set **Next center** to the middle of a hole or counter of the logo (drag the Centre until the little copy lands inside it)
   and **Copy scale** so that copy fits inside that hole (the lens of an O: about 0.55; the loop is clean for any picture, but the tunnel looks best when the copy fits).
3. **Recolour each level**: Fill. Edit **Level colours** (the palette) to the colours you want; level 1 takes the first colour, level 2 the second, round and round.
   Wire a Palette Extract node into the Level colours socket to take them from another picture.
4. **Levels per loop**: set it to the palette length (4 colours, 4) so colours loop too. With **Colours stay with each copy** off, the colours belong to the depth on
   screen instead and any whole number loops. Add **Turn per level** (e.g. 20) and **Spiral twist** (1) for the spiral fall; **Fade per level** darkens the deep end.
5. Optional: wire a second picture into **Inner picture** to morph into it as it falls; put **Array** (Infinite grid, brick offset, Scroll X/Y, Hue shift per copy) behind it as a
   self-recolouring wallpaper, or **3D Array** (Tunnel, Travel 2, Depth fog, Colour steps follow: depth) for cards flying at you.

Cost: Infinite Zoom is one pass whose work is the levels still visible; Array and Kaleidoscope are one pass whatever the copy count; 3D Array is one instanced draw.

## 3D from pictures, blobs and materials (Image to 3D, SDF 3D, Material, Deform)

**A pixel-art sprite as a chunky voxel object.** Pixelate a picture (or use a sprite with transparent background) and wire it into **Image to 3D**. Pixel art keeps its
art grid, so the silhouette is traced pixel by pixel: every wall takes the colour of the pixel at that edge (*Side walls: Edge pixels*), holes stay holes. Thickness 0.4-0.6,
a slow *Spin Y* of 1 turn per loop, **Soft shadows** and **Ambient occlusion** on, *Cel shading* for the console look. *Quality: High* when it is for export.

**A logo as a coin or a card.** Wire the logo into **Image to 3D** (*Silhouette edges: Smooth*), thickness 0.15, and a **Back image** so the other side shows its own picture.
For embossing, wire a depth map (a blurred copy of the logo, or a gradient) into **Depth map** and raise **Relief** to 0.2-0.4: the front is displaced, the walls follow.
*Side walls: Edge pixels, darkened* gives a metal rim; add a **Material** (Metal) for the shine.

**A vase from a drawing.** Draw (or cut out) half a bottle, set **Mode: Lathe**: the silhouette is spun around the vertical axis. Wire a texture into **Side image** and set
*Side walls: Side image* to wrap it around.

**A liquid blob that morphs.** **SDF 3D** with two or three spheres, shape 2 and 3 *Union* with Smoothness 0.5-0.8: metaballs with blended colours. **Gooeyness** scales every
blend at once, so one number wired to sound makes the whole blob more or less liquid. Move shape 3's Y with **Animate** (sine, whole cycles) to make it orbit. For a morph between
two forms turn on *Morph 1 to 2* (sphere into box, say) and animate **Morph amount** with a **Keyframes** node. A 2D logo or a tracked mask wired into **2D shape**
becomes an extruded shape of its own (set a shape to *2D picture*) that blends smoothly with the primitives.

**An endless world.** One rounded box, **Repeat X/Y/Z** with spacing 1.5-3, a **3D Camera** with *Dolly* motion: the camera flies through copies that never run out. *Mirror* and
*Kaleidoscope* turn one shape into a pattern. Cost is the number of march steps, so keep *Quality: Normal* and few shapes.

**Wobble, melt, explode.** The **Deform** group on 3D Object, Image to 3D and SDF 3D: *Noise displace* 0.15 with *Noise animation* 1 cycle makes the surface crawl in a perfect loop;
*Melt* sags it, *Twist/Bend/Taper* shape it, *Morph to sphere* inflates anything into a ball, *Explode* splits it into blocks that fly apart and (with *cycles* 1) reassemble.
Wire a picture into **Displace map** to push the surface by brightness. *Low-fi vertices* snaps geometry to a coarse grid for the early-3D-console look. All amounts are
sockets: wire audio loudness into *Noise displace* and it pulses with the music.

**Materials.** **Material** makes a surface look (matte, clay, plastic, metal, glass, toon, emissive, hologram, matcap, wire grid) from a colour, roughness, rim light and optional
pictures: colour map, normal map, roughness map, emission map, matcap, a 360° environment for reflections. Wire its output into the **Material** input of 3D Object, Image to 3D
or SDF 3D; one Material can feed several objects. Glass refracts a picture wired into *Background*. Hologram scanlines move in whole cycles per loop. Without a Material
connected, the 3D nodes look exactly as before. (Custom 3D models and 3D Array do not take a Material yet.)

**Fog and depth of field.** Every 3D node has a **Depth** output: distance from the camera (in scene units) in all three colour channels, alpha 1 where the object is. Feed it to a
**Gradient Map** or **Levels** to turn it into a mask, then blur or fade the picture with it. It is only rendered when something is wired to it.

Cost (1920x1080, headless GPU, default settings, warm shader): 3D Object about 2 ms; Image to 3D 6-8 ms (about half is the 10-pass silhouette field); SDF 3D with two spheres about
4 ms, 8 spheres about 9 ms; shadows add 3 ms, noise displacement 4 ms, High quality about doubles, an infinite 3-axis repeat is the most expensive thing here (about 20 ms).

## Steer a 3D object and the camera with your phone

Needs the phone link (see `docs/LIVE_INPUT.md`): the desktop app, or `npm run dev:lan`.

1. Add a **Phone Motion** node and press **Link a phone** in its inspector; scan the QR code. On the phone press **Start motion**. The panel shows a small cube that follows the phone.
   Hold the phone upright the way you will use it and press **Recenter**.
2. Add a **3D Object**. Wire Phone Motion's **Object rotate X / Y / Z** into the object's **Rotate X / Y / Z** (the sockets next to each slider). The object now copies the phone's orientation.
   If an axis feels mirrored tick **Invert X / Y / Z** on Phone Motion.
3. To look around a scene instead: add a **Phone 3D Camera Rig**, wire **Yaw / Pitch / Roll** from Phone Motion into it and its **Camera** output into the 3D Object's **Camera** input. Turn on **Orbit mode** to swing
   the camera round the object with the phone, **Lock roll** to keep the horizon level.
4. Move through the scene: wire **Position X / Y / Z** into the rig's **Move X / Y / Z** and set *Units per meter*. With nothing else on, position comes from the touch pad: tick **Touch pad** on the phone and drag with two fingers.
5. Record it: press **Record motion** in the inspector, play the move, press **Stop**. The node switches to **Source: Recorded take**, so the move plays back without the phone and exports exactly. Raise
   **Take smoothing** (with **Keep fast moves**) to calm a shaky take and press **Smooth take** to keep it.

## Gaussian splats (Gaussian Splat, Picture to Splats)

**View a scan.** Import a `.ply` from a 3D Gaussian Splatting trainer (or a `.splat` file; compressed `.ply` / `.spz` are not supported) into the library, add a **Gaussian Splat** node and choose the file in its *Splat file* field. *Fit to view* centres and scales the scan (floaters are
ignored). Many scans are upside down: *Which way is up* is **Automatic** (a guess: a note in the file, else the ground plane of a flat scene, else the trainer's y-down frame); pick *Y points down* or *Z points up* if it is wrong. Wire a **Camera** (orbit with *Motion: Orbit around*, 1 cycle) for a
perfect turntable loop, or use *Spin Y* on the node itself. Remove floaters with **Crop** (box or sphere, keep inside or outside) and **Min opacity**.

**Chunky pixel-art splats.** *Splat shape: Square* (screen-aligned squares) or *Sharp* (hard ellipses), *Splat size* 1.5-3, then **Pixelate** and **Quantize** after it. Few, big squares read as voxels. *Blending: Draft* gives a flat, unsorted look.

**Fast or exact.** *Blending: Sorted* is exact and is re-sorted only when the camera moves (about 25 ms per frame at 1 M splats, a few ms for typical scans; a still camera costs nothing extra). *Draft* has no sort and is a little off in dense areas; *Automatic* uses Sorted for export and still
preview and Draft only while playing at a reduced proxy. *Max splats* keeps the largest, most opaque splats (the same ones every time). Memory is about 100 bytes per splat.

**Soft 2.5D parallax from any photo.** Wire a picture into **Picture to Splats** and a **3D Camera** into its *Camera (view)*: a slow *Dolly* or *Orbit* of a few degrees gives a painterly parallax move. With no depth the shape is a GUESS (default: a dome bulging at the centre); for real relief wire a depth
map (from a depth-estimation tool, or hand-painted: white = near) into **Depth** and set *Near / Far distance* (the further apart, the stronger the parallax). **Edge break** (0.4-0.7) shrinks or drops the splats that would smear across a depth jump; 0 shows the full rubber-sheet look.
*Splats across* 640 (about 230,000 splats) is instant; video works every frame because the splats are made on the GPU from each frame and need no sorting.

**Parallax from a 3D render with its exact depth.** **3D Object** (or **SDF 3D**, **Image to 3D**) has a **Depth** output. Wire its **Image** into Picture to Splats' *Picture* and its **Depth** into *Depth*, set *Depth picture is: From 3D nodes*, wire the SAME **Camera** into the 3D node's *Camera* and into
Picture to Splats' *Capture camera*, and wire a second **3D Camera** (orbiting, or any move) into *Camera (view)*. You now fly around a single render, with exact depth, without re-rendering the 3D scene; the further the view moves from the original, the more of the missing back side shows.

**Depth of a splat scene.** Gaussian Splat's **Depth** output (alpha-weighted distance along the view ray, the same encoding as the 3D nodes) feeds **Gradient Map** / **Levels** for fog and depth-of-field masks, exactly like the Depth of 3D Object.

Cost (1920x1080, headless GPU, warm): Gaussian Splat 100k / 500k / 1M splats sorted with the camera still 2 / 9 / 14 ms, with the camera moving (re-sort every frame) 4 / 19 / 33 ms, Draft 2 / 14 / 14 ms. Picture to Splats at the default 640 across (230,400 splats) about 2 ms,
921,600 splats about 3 ms, with the Depth output about 4 ms. Parsing a 1 M splat `.ply` (65 MB) takes about 0.35 s once per file.

## Give a photo depth (Depth from Picture)

**Give a photo depth.** Wire a picture into **Depth from Picture**, then wire its **Depth** output into **Picture to Splats** (*Depth*), **Lens Blur** (*Depth*), **Depth Slice** (*Depth map*) or **Image to 3D** (*Depth map*, with *Relief* above 0). It is a fast guess made from cheap cues, not a measurement: white = near, black = far, the same convention every depth consumer reads, so nothing needs inverting.
Start with a **Look** (Portrait, Landscape, Room, Graphic, Moving camera, Flat with subject), then dial the cue sliders (0 = off; they are relative weights). Wire **Preview** (a colored near / far tint over the picture) to see what it decided. In **Picture to Splats**, set *Near / Far distance* 3.5 / 5.5 and a slow camera move: the subject and the foreground now slide against the background instead of bending as one sheet.
Fix mistakes by hand: paint a **Paint Mask** over what should be nearer and wire it to *Nearer paint* (or over what should be farther into *Farther paint*); its brush softness is the falloff. For video turn **Stabilize** on (the range is measured once, at *Analyze at*, so it never flickers) and, for a moving camera over a still scene, wire an **Optical Flow** node into *Flow* and raise *Motion*.
A distance picture from a 3D node (its **Depth** output) is a different convention: put it through **Depth Convert** (*3D distance to depth map*) before it goes into Lens Blur, Depth Slice or Image to 3D. Picture to Splats reads it directly with *Depth picture is: From 3D nodes*.

## Keep the look of the playback preview (Render Scale)

While a heavy graph plays, RSMPS renders the WHOLE graph at a lower resolution (the viewer shows "Preview 25%") and enlarges it. Effects are computed on fewer pixels, so the picture comes out softer and grainier than the export,
and sometimes you like it better. To keep that look in the export:

1. Play the project until the toolbar says e.g. **Preview 25%** (or just press the button: with the preview at 100% it uses the last preview scale you saw, else 25%).
2. Press **Keep this look** in the viewer toolbar. A **Render Scale** node (Transform) appears right before the Output (or after the viewed node, if it is not an Output), set to that percentage with the **Smooth** filter. One undo step; pressing it again only changes the percentage.
3. Export as usual. A 4K project stays 4K: everything before the node is rendered at the lower resolution (about scale squared as much work), then enlarged back to the full frame. Raise **Render at** for a finer look, choose **Sharp pixels** for hard blocks or **Soft** for a gentler enlarge.

- **Render at** is a share of the full resolution (presets 100, 75, 50, 33, 25, 12.5; any value from 5). 100% does nothing.
- **Match preview**: during playback at a coarser proxy the node does not go finer than that proxy, so it stays fast; paused and in exports you always get exactly the percentage. Switch it off to see the exact export look while playing (slower).
- **Mix** blends with the true full-resolution picture (the graph is then rendered twice).
- Two Render Scale nodes in a row do not multiply: the coarser one wins.
- **Full res** (Shift+R) in the viewer renders just the current frame at full quality, to check details without leaving the preview; it goes away when you change frame, edit, or press play.

## Captions for vertical video (Subtitles)

The **Subtitles** node (Generate) turns an `.srt` / `.vtt` file, or lines you type, into a caption overlay on a TRANSPARENT picture the size of the project. It is a normal picture, so anything can follow it.

1. Drop the `.srt` / `.vtt` onto the graph (a Subtitles node appears with the file), or add **Subtitles** and type one caption per line in *Text*. A line can start with `[1.5-3.0]` (seconds or m:ss.s); lines without times share the project length.
2. Put the result over the footage: **Merge** with the video as *Background* and Subtitles as *Foreground* (*Foreground size: Stretch*).
3. Pick a **Look**: Classic, Bold caption (word pop), Karaoke highlight, Typewriter, Pixel 8-bit, Pixel dithered, Boxed word, Big single word, Lyric wave. A look only overrides the controls it lists; **Custom** uses every control as set (a new node starts on Bold caption). In a 9:16 project set **Safe area** to TikTok, Reels or Shorts to keep clear of the app's buttons (approximate guides, only applied to portrait frames).
4. Timing: **Offset** delays the captions, **Speed** fits a retimed clip, **Loop** makes captions pushed past the end come back at the start (a seamless loop). Without a VTT word timestamp, a caption's duration is shared over its words by letter count, with a longer pause after `, ; : . ! ?`.

**Pixel-art lettering.** *Pixel size* above 0 draws the text on a grid of that many pixels per art pixel and enlarges it crisply; *Snap to the grid*, *1-bit edges* and *1 px outline* keep a pixel font sharp. The picture carries the grid (docs/ENGINE.md rule 28), so a **Dither** or **Quantize** after it works on the same pixels. The *Dithered gradient* fill dithers between two colors inside the node. Dithering the merged picture (Merge, then Dither) gives the captions the same palette as the footage.

**Letters filled with video.** Wire any picture into **Fill**: the letters show it (the outline and box keep their own colors). **Word colors** takes a palette: word *n* uses color *n* of it. **Text mask** outputs the letters' coverage; **Cue showing**, **Cue progress** and **Word index** are numbers for driving other nodes (a flash on every word, a zoom on the cue).

Cost: each distinct word is drawn once into an atlas (with its distance field) per 24 captions of the file; playing a frame then costs one small instanced draw and no rasterising, whatever the file length (atlases are kept in a bounded cache, 8 pages / 128 MB). Known limits: emoji come out as single-color silhouettes, no letter spacing control (the host's text call has none), CJK text without spaces is one "word" per caption.
