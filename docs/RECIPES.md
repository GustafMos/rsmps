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
