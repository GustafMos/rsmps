# Gumroad page: RSMPS

Copy for the Gumroad product page. Items marked TODO or "owner's decision" are for the owner to fill in. Nothing here has been
published. Gumroad has no upload API, so the files are added by hand (see `docs/RELEASING.md`, "Gumroad (manual)").

## Settings

- **Product type:** Digital product (a download). Name: **RSMPS: RipScorpy Media Processing Suite (desktop builds)**
- **URL slug:** TODO
- **Pricing:** "Pay what you want" with a minimum and a suggested price (see "Price" below)
- **Content (files to upload):** the Windows installer, the macOS dmg and the Linux AppImage from the GitHub Release (the same
  files that are free there). Add the version number to the product's description note when you upload a new one.

## Tagline

A GPU node graph for pixel art, video and sound, as an offline desktop app.

## Short description (160 characters at most)

> Desktop build of the open-source RSMPS: a GPU node graph for pixel art, dithering, CRT looks, masks, tracking, synths and effects. Runs offline.

(144 characters.)

## Full description

```markdown
**RSMPS (RipScorpy Media Processing Suite)** is a node graph for making game assets in batches: images, video, animation and
sound. You connect small nodes with wires and each one processes what the one before it produced. It runs on your GPU,
offline, with no account and no upload.

**This is open-source software (MIT).** The source code is free on GitHub and there is a free web version. This page is for the
ready-made desktop builds (Windows installer, macOS dmg, Linux AppImage): you skip the setup, and your payment supports further
development.

### What you can do with it

- Pixel art: edge-aware pixelation, 27 dither algorithms, palettes, palette swap, crisp upscale, Palette Studio.
- Looks: CRT display, analog video (VHS, RF), scan lines, scan line relief, halftone, grain, bloom, lens blur, echo trails.
- Batches: many files into one Media In node, the graph runs once per file; a loop switch for seamless animation.
- 3D objects with their own cameras, gradients, noise, particles, text, keyframes and a curve editor.
- Masks, subject mask, inpainting, layer splitting, looping parallax.
- Detect and track: blobs, colour, motion, a tracker, regions to masks, HUD overlays.
- Audio and MIDI in the same graph: microphone, synths, drums, sampler, effects, a Timeline, and Sound to Numbers to drive
  pictures with sound.
- Print and scan back: print frames as sheets, draw on them, photograph them, get the frames back as an animation.
- Plugins: one JavaScript file adds a node. More than 160 nodes in total.

### What you are paying for

Nothing is locked. The web version, the source and the GitHub release builds are free. Paying here gets you the packaged build
and supports the person making it. No licence key, no DRM, no extra features. Pay what you like.

### Not included

- **ProRes and other ffmpeg-only formats are not in the desktop app** (ffmpeg is not bundled). They are available in the free
  command-line renderer in the source repository, which uses your own ffmpeg.
- The phone-as-camera link is off in the desktop app.
- No auto-update (new versions are new downloads) and no code signing yet (one-time warning on Windows and macOS).

### System requirements

- GPU and driver with WebGPU: Windows 10 or later, macOS 12 or later, or Linux with Vulkan (Mesa 22 or newer, or the vendor
  driver). 64-bit only.
- About 400 MB of disk, 8 GB RAM recommended for video work.
- The Windows build is the best tested; macOS and Linux builds come from CI and have had less testing.

### FAQ

**Is it really free?** Yes, the software is MIT licensed and free on GitHub. This is the convenient packaged build.

**Refunds?** TODO (owner): state the policy. Gumroad's own refund terms apply; say here whether you refund on request.

**Updates?** No auto-update. New versions are added to this product as new files; Gumroad emails buyers when you publish an
update (check that setting on the product).

**Linux?** An AppImage: `chmod +x RSMPS-*.AppImage`, then run it. On Ubuntu 24.04 and later it may need `--no-sandbox`
(AppArmor blocks the Chromium sandbox otherwise). Vulkan is needed for WebGPU.

**Windows shows "Windows protected your PC".** The build is not code-signed yet: choose More info, then Run anyway.

**macOS says the developer cannot be verified.** Right-click the app, choose Open, then Open again. On macOS 15 and later:
System Settings, Privacy & Security, Open Anyway. Or `xattr -dr com.apple.quarantine /Applications/RSMPS.app`.

**Does it upload my files?** No. The app makes no network requests of its own.
```

## Not affiliated (include on the page)

RSMPS is an independent project. It is not affiliated with, sponsored by or endorsed by Blackmagic Design, the Blender Foundation, Adobe, Ableton, Apple, or any other company, product or creator mentioned here. DaVinci Resolve, Fusion, Blender, Adobe Color, Ableton Live and ProRes are trademarks of their respective owners. They are named only to describe what inspired this tool or what it works with.

## Price (owner's decision)

- **Minimum:** TODO. Suggested: **$1**, so a purchase is a deliberate choice and not a free-download with extra steps (Gumroad
  can also be set to allow $0; the free builds on GitHub make that pointless as a "sale", but it does collect an email list if
  you want one).
- **Suggested price:** **$8**, the same as on itch.io so the two pages agree. Reasoning: low enough to be an easy yes for a
  hobbyist, high enough to be a real contribution; people who pay what they want usually pay near the pre-filled amount.
- Look up the current Gumroad fees and payout rules before deciding; the minimum should leave you something after fees (a
  $1 payment is much less once a flat fee per sale is taken off).

## Tags / keywords

pixel art, dithering, node editor, shader, game development, asset creation, CRT, VHS, audio, MIDI, open source, WebGPU, tool

## Images: what goes in which slot

All files are in `docs/store/assets/` (regenerate with `node scripts/screenshots/render-showcase.mjs`).

| Gumroad slot | File | Notes |
| --- | --- | --- |
| Thumbnail (600x600) | `gumroad-thumbnail-600x600.png` | the pixel-art look with the title |
| Cover (1280x720) | `gumroad-cover-1280x720.png` | the interface with the hero pipeline |
| Product image 2 | `looks-1280x727.png` | the test picture and eight looks |
| Product image 3 | `screenshot-generators-1280x800.png` | 3D objects, cameras, curve editor |
| Product image 4 | `screenshot-audio-1280x800.png` | synth, timeline, sound to picture |
| Product image 5 | `screenshot-detect-track-1280x800.png` | detect, track, mask |
| Product image 6 | `screenshot-palette-studio-1280x800.png` | Palette Studio |
| Product image 7 | `screenshot-scan-1280x800.png` | print and scan back |
