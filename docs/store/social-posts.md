# Social post drafts

Five short drafts to adapt. Replace the TODO links when the pages exist. Attach the image named under each post. Every claim
below is something the app does today; if you change a post, keep it that way.

## 1. Launch

RSMPS is a node graph for pixel art, video and sound that runs on your GPU, offline. More than 160 nodes: dithering, CRT, masks,
tracking, synths, effects. Open source (MIT). The desktop builds are pay what you want on itch.io (TODO link) and Gumroad
(TODO link); the code and the web version are free: https://github.com/GustafMos/rsmps

Image: `docs/screenshots/01-hero.png`

## 2. Before and after

One test picture, eight looks, each made from one to three nodes: pixel art with dither, CRT, VHS, scan line relief, echo
trail, lens blur, halftone, 3D. All rendered by the same engine the app and the command line use. Graphs are in the repo if you
want to see how each one is built.

Image: `docs/screenshots/looks.png` (or the first and second tile cropped out of it)

## 3. Print and scan

Print your animation as a sheet of frames, draw on the paper, photograph it with a phone, and RSMPS finds the registration marks,
straightens the page and gives you the frames back as an animation. The picture shows a sheet the app printed itself, tilted
and read back. Works with any pen. Docs: docs/PRINT_AND_SCAN.md in the repo.

Image: `docs/screenshots/07a-scan-photos.png` (the photographed sheet and the recovered frames) and `07-scan.png`

## 4. Sing to animate

Sound to Numbers listens to the microphone (or any sound in the graph) and turns loudness, bass, treble and pitch into numbers
that can drive any parameter: scale, rotation, colour, a blur. Sing and the picture moves. It is live only; to export, record
the take in the Timeline node and it exports like any other clip.

Image: `docs/screenshots/03-audio.png` (Sound to Numbers driving a 3D object, next to the timeline). A screen recording of the
mic version would be better if you make one.

## 5. CRT

CRT Display in RSMPS draws every art pixel as a scan line, with a phosphor mask, glow, curved glass and colour bleed, and there
are presets for an arcade cabinet, a consumer TV, a Trinitron, a handheld, a terminal and an LCD. Pixelate, dither to a palette,
then the tube. Looping animations repeat exactly when the Loop switch is on.

Image: `docs/screenshots/anim-crt.webp` (convert to GIF or MP4 if the site does not accept WebP), or the CRT tile of `looks.png`
