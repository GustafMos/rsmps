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
- **FFmpeg is not included.** Its licence terms (GPL builds) would add obligations to the package, so RSMPS never bundles or
  hosts it. ProRes-compatible export and the other FFmpeg codecs are an **optional add-on** (see "Official add-ons" below):
  downloaded only when you ask, or use an FFmpeg you already have. The command-line renderer (`docs/CLI.md`) uses your own
  ffmpeg as before. Everything the browser can encode works without the add-on.
- **Phone link on demand.** "Link a phone" starts a local https server inside the app only while it is in use (Windows asks
  once for firewall permission; allow Private networks). The phone shows a certificate warning once (self-signed); an
  optional Tailscale certificate removes it. See `docs/LIVE_INPUT.md`. Untested on a real phone against the packaged build.
- **No auto-update** yet: download the new version.
- Linux and macOS builds are produced by CI and have had less testing than Windows.
- The app needs a working WebGPU adapter; on machines without one it shows the "Cannot start" screen.

## Security and privacy notes (for the store page, if wanted)

The app has no server until you ask for a phone link (then a local https server on your network, closed automatically) and
makes no network requests of its own except the add-on download you start; media never leaves the machine. Live-input nodes can
fetch IP-camera URLs the user types in. The window runs sandboxed with context isolation, no Node.js access, and only
https links are opened (in the system browser). Camera, microphone and MIDI are the only permissions granted.

## Third-party notices

FFmpeg is not part of any build (see above). Every build contains `resources/THIRD_PARTY_LICENSES.txt` (generated at build time by `desktop/scripts/stage.mjs` from the
production dependencies that end up in the web bundle: React, Mediabunny (MPL-2.0), fflate and their dependencies, plus
`THIRD_PARTY_NOTICES.md`), `resources/LICENSE.rsmps.txt` (MIT), and Electron's `LICENSE.electron.txt` and
`LICENSES.chromium.html`. Electron ships Chromium's own `ffmpeg.dll`/`libffmpeg` for browser media codecs (LGPL);
that is part of Chromium, covered by `LICENSES.chromium.html`, and unrelated to the CLI's ffmpeg. Help > About in the
app menu shows the version and MIT licence. Keep these files in any repackaged build.

## Official add-ons (FFmpeg)

An add-on is optional software RSMPS can fetch for you. **FFmpeg is NOT distributed with RSMPS**: not in the installer, not in
the zip, not on the store pages. Rules the app follows (`desktop/addons/`, catalogue in `desktop/addons/catalogue.json`):

- Only on request: the "Official add-ons" section of the Plugins dialog (Install / Remove / Locate), or the unticked
  "Download FFmpeg after install" box in the Windows installer (the installer downloads nothing: it leaves a request that the app
  turns into the same in-app flow on first launch).
- A dialog shows name, version, licence, source host and size before anything is downloaded. The file comes from the upstream
  distributor (Windows x64: Gyan Doshi's builds, GitHub release asset, GPL-3.0-or-later build; linked from ffmpeg.org).
- The download is verified against a pinned SHA-256 before it is unpacked or run; a mismatch deletes it. The unpacked program is
  re-checked before use. Remove deletes the folder. No automatic updates.
- "Use an FFmpeg already on this computer" (found on PATH, or chosen with a file dialog and checked by running `-version`)
  needs no download at all. macOS and Linux have no pinned download yet: install FFmpeg with Homebrew / your package manager.
- Wording on store pages: "ProRes-compatible export (via FFmpeg)". Never use Apple's trademarks as a product name or logo.
- If you redistribute FFmpeg yourself (do not), the GPL applies to that file and its source must be offered.

## What the desktop shell sets (for reviewers)

- `app://rsmps/` custom protocol serves the bundled web build; path traversal is blocked; a Content-Security-Policy is
  added (scripts from self and blob: for plugins, wasm allowed).
- Linux only: `--enable-unsafe-webgpu` and `--enable-features=Vulkan`, because Chromium keeps WebGPU-on-Vulkan behind
  flags on Linux. Windows and macOS need no flags.
- Single instance lock, window size/position saved in the user profile, menu (File, Edit, View, Window, Help, About).
- Internal endpoints on `app://rsmps/__rsmps/` (phone link, add-ons, export) are only reachable from the app's own pages; the
  renderer has no Node access and no preload script. A `certificate-error` handler trusts only the phone server's own
  certificate (by fingerprint, our host names and port) for the app window; certificate checking stays on everywhere else.
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
