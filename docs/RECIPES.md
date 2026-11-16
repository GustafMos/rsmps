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
   smoothing 3 px, *Thicker where bright* 1, *Brightness lights the lines* 1, glow 0.9, line colour electric blue
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
displacement for a mountain-range look, or turn on *Lines hide the ones behind* for a ridge-line plot.

**Echo trails**: Echo Trail with ten fading echoes, each a little smaller, shifted and hue-turned. With moving footage the echoes
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
2. **ASCII Art** (`ascii-art`): Characters *Classic ramp*, Character width 8 px, *Choose characters by* **Shape** (edges become `/ \ | _`),
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
Fit decides how clips of another shape sit in the frame (Fit inside, Fill, Stretch); the Background colour shows where no clip is.

## More presets

**ASCII terminal**: Color Adjust, then ASCII Art in green terminal colours with glow.

**Dither morph (two clips)**: two empty Media In nodes (A and B) feed Morph / Transition in an ordered-dither style; an Animate node drives
its Progress with one smooth A to B to A cycle per loop.
