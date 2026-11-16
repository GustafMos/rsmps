# itch.io page: RSMPS

Copy for the itch.io project page. Items marked TODO or "owner's decision" are for the owner to fill in. Nothing here has been
published.

## Settings

- **Kind of project:** Downloadable (tools / software). Classification: Tool (or "Other").
- **Title:** RSMPS: RipScorpy Media Processing Suite
- **Project URL slug:** TODO (the same `user/game` value goes into the repository variable `ITCH_TARGET`, see `docs/RELEASING.md`)
- **Pricing:** pay what you want (see "Price" below)
- **Platforms:** Windows, macOS, Linux (builds come from CI; see "System requirements" for how well each is tested)

## Tagline

A GPU node graph for pixel art, video and sound, as an offline desktop app.

## Short description (itch "Short description or tagline", 160 characters at most)

> Desktop build of the open-source RSMPS: a GPU node graph for pixel art, dithering, CRT looks, masks, tracking, synths and effects. Runs offline.

(144 characters.)

## Full description

Paste as Markdown into the itch editor.

```markdown
![RSMPS](TODO: upload docs/store/assets/screenshot-hero-1280x800.png and use its itch URL)

**RSMPS (RipScorpy Media Processing Suite)** is a node graph for making game assets in batches: images, video, animation and
sound. You connect small nodes with wires, and every node processes what the one before it produced. It runs on your GPU
(WebGPU), offline, with no account and no upload.

It started as a pixel-art converter for the game *Filmmaker Survivor* and grew into a general tool.

**This is open-source software (MIT).** The source code is free on GitHub, and there is a free web version. This page sells the
ready-made desktop builds as a convenience, and the money supports further development. See "What you are paying for" below.

## What you can do with it

- **Pixel art:** edge-aware pixelation, 27 dither algorithms, palettes (built-in, custom, extracted from an image), palette
  swap, crisp upscale, and Palette Studio for building palettes from colour harmonies.
- **Looks:** CRT display, analog video (VHS and RF), scan lines, scan line relief, halftone, grain, bloom, lens blur, echo
  and feedback trails, pixel sorting, outlines, watercolour.
- **Batches:** put many files into one Media In node and the graph runs once per file. Lengths scale to each file, so a 480p
  and a 4K source get the same look. Loop switch for seamless animation.
- **3D and animation:** primitive 3D objects with perspective, orthographic, isometric, fisheye, panoramic or cylindrical
  cameras; gradients, noise, particles, text; Animate and Keyframes with a curve editor.
- **Masks and layers:** keys, subject mask, paint mask, inpainting, layer splitting, looping parallax.
- **Detect and track:** blob, colour and motion detectors, a tracker, regions to masks, HUD overlays, trails, follow-crop.
- **Audio and MIDI in the same graph:** microphone, audio files, MIDI keyboard and devices, synths, drums, sampler, effects,
  a Audio Timeline with audio and MIDI tracks. Sound to Numbers turns loudness, pitch and notes into numbers that drive any picture
  parameter.
- **Print and scan back:** print animation frames as sheets with registration marks, draw on them, photograph them, and get
  the frames back aligned as an image sequence.
- **Plugins:** a plugin is one JavaScript file that adds a node.
- More than 160 nodes in total.

## What you are paying for

Nothing is locked. The web version and the source code are free, and the same release files are free to download from
GitHub Releases. Paying here gets you the packaged desktop build without any setup (an installer or an app you can open
offline), and it supports the person making it. There is no licence key and no DRM, and the paid build has no features the free
one lacks. Pay what you like.

## What is not included

- **ProRes-compatible export and video with transparency need FFmpeg, which is not bundled** (its licence would add
  obligations to the package). The desktop app can fetch it as an optional add-on from its official source when you ask, or
  use an FFmpeg you already have; the free command-line renderer (`npm run cli`, see docs/CLI.md) works with your own FFmpeg too. Everything a
  browser can encode (PNG, WebP, JPEG, MP4 in browser codecs, WebM, WAV and more) works in the app.
- **The phone-as-camera link** is off in the desktop app. (It works when you run the web app from source with `npm run dev:lan`.)
- **No auto-update** yet: new versions are new downloads.
- **No code signing yet**, so Windows and macOS show a one-time warning on first start (see the FAQ).

## System requirements

- A GPU and driver with **WebGPU** support: Windows 10 or later (Direct3D 12), macOS 12 or later (Metal), or Linux with
  Vulkan (Mesa 22 or newer, or the vendor driver). Without a working WebGPU adapter the app shows a "Cannot start" screen.
- 64-bit: Windows x64, macOS universal (Intel and Apple silicon), Linux x64.
- About 400 MB of disk space after install; 8 GB of RAM recommended for video work.
- Camera, microphone and MIDI devices are optional; the app asks the system for permission.
- Testing: the Windows build is the best tested. The macOS and Linux builds are produced by CI and have had less testing.

## FAQ

**Is it really free?**
Yes. RSMPS is MIT licensed. The source, the web version and the GitHub release builds are free. This page sells the packaged
desktop build for convenience and to support development.

**Can I get my money back?**
TODO (owner): state your policy. itch.io lets buyers request refunds under its own terms; say here whether you will also
refund on request.

**How do updates work?**
There is no auto-update inside the app. New versions are published as new downloads on this page; if you install through the
itch app it can notify you about them. Release notes are in the changelog.

**Is there a Linux build?**
Yes, an AppImage and a tar.gz. Make the AppImage executable (`chmod +x RSMPS-*.AppImage`) and run it. On Ubuntu 24.04 and
later the Chromium sandbox can be blocked by an AppArmor policy; start the app with `--no-sandbox` (less secure) or allow it
with an AppArmor profile. Linux needs Vulkan for WebGPU.

**Windows says "Windows protected your PC".**
The builds are not code-signed yet. Choose **More info**, then **Run anyway**.

**macOS says the developer cannot be verified.**
Right-click the app, choose **Open**, then **Open** again. On macOS 15 and later go to System Settings, Privacy & Security and
choose **Open Anyway**. Or run `xattr -dr com.apple.quarantine /Applications/RSMPS.app`.

**Does it upload my files?**
No. The app has no server and makes no network requests of its own. Only the URL / Stream node fetches an address you type in.

**Can I use what I make commercially?**
The tool is MIT licensed and does not claim anything you make with it. Check the licence of your own source media.

**Where do I report bugs?**
On the GitHub issue tracker (TODO: add the link) or in the comments here.

## Not affiliated (include on the page)

RSMPS is an independent project. It is not affiliated with, sponsored by or endorsed by Blackmagic Design, the Blender Foundation, Adobe, Ableton, Apple, or any other company, product or creator mentioned here. DaVinci Resolve, Fusion, Blender, Adobe Color, Ableton Live and ProRes are trademarks of their respective owners. They are named only to describe what inspired this tool or what it works with.

## Price (owner's decision)

- **Minimum:** TODO. Suggested: **$0 minimum**, because the same builds are free on GitHub, so a minimum above zero would only
  make people use the other link. Using a small minimum such as $1 is also reasonable if you want fewer drive-by downloads.
- **Suggested price (the amount pre-filled on the page):** **$8**. Reasoning: it is below the price of most single-purpose
  pixel-art tools, high enough to feel like a real contribution, and low enough to be an easy yes for hobbyists. A pay what you
  want slider that starts at $8 usually produces a higher average than one that starts at $3.
- Check the current fee structure on itch.io before deciding; the share you keep depends on the revenue share you choose.

## Tags (itch allows up to 10)

`pixel-art`, `tool`, `dithering`, `node-based`, `shader`, `game-development`, `asset-creation`, `crt`, `audio`, `open-source`

Other keywords for the search box and description: WebGPU, palette, spritesheet, VHS, MIDI, synth, procedural, batch.

## Images: what goes in which slot

All files are in `docs/store/assets/` (regenerate with `node scripts/screenshots/render-showcase.mjs`).

| itch.io slot | File | Notes |
| --- | --- | --- |
| Cover image (630x500) | `itch-cover-630x500.png` | CRT look of the test scene with the title |
| Screenshot 1 | `screenshot-hero-1280x800.png` | the pipeline with the result in the viewer |
| Screenshot 2 | `looks-1280x727.png` | the test picture and eight looks |
| Screenshot 3 | `screenshot-generators-1280x800.png` | 3D objects, cameras, curve editor |
| Screenshot 4 | `screenshot-audio-1280x800.png` | synth, timeline, sound to picture |
| Screenshot 5 | `screenshot-detect-track-1280x800.png` | detect, track, mask |
| Screenshot 6 | `screenshot-palette-studio-1280x800.png` | Palette Studio |
| Screenshot 7 | `screenshot-scan-1280x800.png` | print and scan back |
| Screenshot 8 | `screenshot-add-menu-1280x800.png` | the add-node menu |
| In the description (animation) | `docs/screenshots/anim-crt.webp` | itch accepts GIF, PNG and JPG in descriptions; convert to GIF first if WebP is refused |

Alt text for each is the sentence under the matching image in the README.
