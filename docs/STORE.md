# Store pages (itch.io, Gumroad): what is sold and how to say it

## What is being sold

RSMPS is MIT licensed open-source software. The store builds are **convenience builds** of exactly that source: the
same feature set as the web app, packaged as a desktop program with an installer, offline, with updates delivered as
new downloads. Buyers pay for the packaging, convenience and to support development. The source code, the web app and
the GitHub release builds stay free. Nothing is withheld from the free version, and nothing in the paid build is
proprietary. Do not describe it otherwise.

## Suggested wording

> **RSMPS: RipScorpy Media Processing Suite** (desktop builds)
>
> A GPU node graph for batch image, video and audio processing: pixel art, palettes, dithering, masks, parallax,
> tracking, synths and effects. Runs offline on your computer.
>
> **This is open-source software (MIT).** The source code is free on GitHub, and you can build it yourself or use the
> free web version. This page sells the ready-made desktop builds (installer for Windows, dmg for macOS, AppImage for
> Linux), which saves you the setup and supports further development. The builds are not code-signed yet, so Windows
> and macOS will show a one-time warning on first run; instructions are on this page.

Also state: price is for the build and support, no licence key, no DRM, refunds per the store's policy.

## System requirements

- A GPU and driver with **WebGPU**: Windows 10 or later (Direct3D 12), macOS 12 or later (Metal), Linux with Vulkan
  (Mesa 22 or newer, or the vendor driver).
- 64-bit. Windows x64, macOS universal (Intel and Apple silicon), Linux x64.
- About 400 MB of disk after install, 8 GB RAM recommended for video work.
- Camera, microphone and MIDI devices are optional; the app asks the system for permission.

## Known limitations

- **Unsigned builds** (SmartScreen / Gatekeeper warnings, see `docs/RELEASING.md`). Linux: AppArmor may need `--no-sandbox`
  on Ubuntu 24.04+.
- **No ProRes / ffmpeg in the app.** ffmpeg is not bundled (its LGPL/GPL terms would add obligations to the package).
  ProRes 4444 with alpha, and other ffmpeg-only formats, stay a feature of the command-line renderer (`docs/CLI.md`),
  which needs the user's own ffmpeg (on PATH or `$FFMPEG_PATH`). Everything the browser can encode works in the app.
- **No phone link.** The phone-as-camera feature needs a local https server and is off in the desktop app
  (`Io.phone.available` is false). It is planned as a later feature. The web app's dev server LAN mode still has it.
- **No auto-update** yet: download the new version.
- Linux and macOS builds are produced by CI and have had less testing than Windows.
- The app needs a working WebGPU adapter; on machines without one it shows the "Cannot start" screen.

## Security and privacy notes (for the store page, if wanted)

The app has no server and makes no network requests of its own; media never leaves the machine. Live-input nodes can
fetch IP-camera URLs the user types in. The window runs sandboxed with context isolation, no Node.js access, and only
https links are opened (in the system browser). Camera, microphone and MIDI are the only permissions granted.

## Third-party notices

Every build contains `resources/THIRD_PARTY_LICENSES.txt` (generated at build time by `desktop/scripts/stage.mjs` from the
production dependencies that end up in the web bundle: React, Mediabunny (MPL-2.0), fflate and their dependencies, plus
`THIRD_PARTY_NOTICES.md`), `resources/LICENSE.rsmps.txt` (MIT), and Electron's `LICENSE.electron.txt` and
`LICENSES.chromium.html`. Electron ships Chromium's own `ffmpeg.dll`/`libffmpeg` for browser media codecs (LGPL);
that is part of Chromium, covered by `LICENSES.chromium.html`, and unrelated to the CLI's ffmpeg. Help > About in the
app menu shows the version and MIT licence. Keep these files in any repackaged build.

## What the desktop shell sets (for reviewers)

- `app://rsmps/` custom protocol serves the bundled web build; path traversal is blocked; a Content-Security-Policy is
  added (scripts from self and blob: for plugins, wasm allowed).
- Linux only: `--enable-unsafe-webgpu` and `--enable-features=Vulkan`, because Chromium keeps WebGPU-on-Vulkan behind
  flags on Linux. Windows and macOS need no flags.
- Single instance lock, window size/position saved in the user profile, menu (File, Edit, View, Window, Help, About).
- File association for `.rsmps.json` is not set up yet (optional).

## Page copy, images and prices

The ready-to-paste text lives in `docs/store/`:

- `docs/store/itch-page.md` and `docs/store/gumroad-page.md`: title, tagline, short description, full description, what the
  buyer is paying for, system requirements, what is not included, FAQ, tags, price suggestion and which image goes in which
  slot.
- `docs/store/social-posts.md`: five short post drafts (launch, before and after, print and scan, sing to animate, CRT).
- `docs/store/assets/`: the images, cropped to the sizes the stores ask for (itch cover 630x500, Gumroad thumbnail 600x600,
  Gumroad cover 1280x720, screenshots 1280x800, the "looks" sheet). They come from `docs/screenshots/` and are regenerated with
  `node scripts/screenshots/render-showcase.mjs`; the UI screenshots themselves are regenerated with
  `npx electron scripts/screenshots/capture.mjs` (dev server running). All of them are made from `test-assets/` and generated
  content only.

Open decisions for the owner (marked TODO in those files): the store URLs, the refund policy wording, the bug-report link, the
minimum price and the suggested price. The suggestion is a $0 to $1 minimum with a suggested $8 on both stores, because the same
builds are free on GitHub; it is only a suggestion.

When the pages exist, replace the two TODO links in the README's "Desktop app" section.
