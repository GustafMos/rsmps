# Releasing the desktop app

The desktop app is the web app in an Electron shell (`desktop/`). It is built by `.github/workflows/release.yml` for
Windows, macOS and Linux. Builds are **unsigned** for now; the places where signing plugs in are listed below.

## Cut a release

1. Update `CHANGELOG.md`: add a section `## [X.Y.Z] - YYYY-MM-DD` at the top. The release notes are taken from it, and
   the workflow fails if the section is missing.
2. Bump the version: `npm version X.Y.Z --no-git-tag-version` (edits `package.json` and `package-lock.json`).
3. Check locally: `npm run check`, then `npm run desktop:build` (current OS, output in `release/`) and
   `npm run desktop:smoke` (runs the unpacked app once and prints a JSON result; exit code 0 means the UI started and
   WebGPU gave an adapter).
4. Commit, then tag and push:
   ```
   git commit -am "Release X.Y.Z"
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```
   The tag must equal `v` plus the `package.json` version, or the release job stops.
5. The **Source release** workflow runs on the tag and publishes a GitHub Release `RSMPS X.Y.Z` with the changelog notes
   and GitHub's source archives. It contains no installers: it exists so people can follow versions and build from the
   matching source.
6. To build the installers, start the **Release** workflow by hand (Actions > Release > Run workflow, pick the tag).
   The files are attached to the run as artifacts for 14 days (download them for itch.io / Gumroad). It only creates a
   **draft** release with the installers when no release for that version exists yet.

## What CI produces

| OS | Files (in `release/`) |
| --- | --- |
| Windows | `RSMPS-Setup-X.Y.Z-win-x64.exe` (installer), `RSMPS-X.Y.Z-win-x64.zip` (portable: unzip, run `RSMPS.exe`) |
| macOS | `RSMPS-X.Y.Z-mac-universal.dmg`, `RSMPS-X.Y.Z-mac-universal.zip` (Intel and Apple silicon) |
| Linux | `RSMPS-X.Y.Z-linux-x64.AppImage`, `RSMPS-X.Y.Z-linux-x64.tar.gz` |

The jobs: `build` (3 OSes: typecheck, web build, electron-builder, upload), `draft-release` (draft GitHub Release),
`itch` (optional, tags only). No GPU tests run here (the runners have no GPU); `ci.yml` runs them with software Vulkan.
Third-party licences are generated at build time into `THIRD_PARTY_LICENSES.txt` inside the app (`resources/`).
Actions are pinned to major versions (`@v4`); pin to commit SHAs if you want stricter supply-chain control.

Build a single OS locally with `npm run desktop:dist:win|mac|linux` (macOS and Linux targets must be built on that OS;
`desktop:build` builds for the current one). Unpacked, quick build for testing: `node desktop/scripts/pack.mjs --dir`.

## itch.io (optional, automatic)

1. Create the game page on itch.io yourself (type "Downloadable", set the price). Note its `user/game` slug.
2. Create an API key: itch.io, Settings, API keys, "Generate new API key".
3. In the GitHub repo: Settings, Secrets and variables, Actions: add the **secret** `BUTLER_API_KEY` and the
   **variable** `ITCH_TARGET` (for example `ripscorpy/rsmps`).
4. On the next tag, the `itch` job pushes channels `windows`, `mac` and `linux` with the version number. Without the
   secret the job does nothing. It downloads butler from `broth.itch.zone`.

The first push of a channel creates it; itch.io then needs the page set to published/restricted by you.

## Gumroad (manual)

Gumroad has no upload API. After publishing the GitHub Release, download the Windows installer, the macOS dmg and the
Linux AppImage from it (or from the workflow artifacts), and upload them as files on the product page (Content tab).
Update the product's version note. Gumroad customers get the same files as the free GitHub download, which is what
STORE.md says.

## Code signing (not set up yet)

Why unsigned builds warn:

- **Windows SmartScreen** shows "Windows protected your PC / unknown publisher" for programs without a reputation-bearing
  code signing certificate. Users click **More info**, then **Run anyway**. Antivirus may also scan the unsigned installer.
- **macOS Gatekeeper** says the app "cannot be opened because the developer cannot be verified" (or is damaged) for apps
  not signed with a Developer ID and notarized. Users right-click the app, choose **Open**, then **Open** again
  (on macOS 15 and later: System Settings, Privacy & Security, "Open Anyway"). For a downloaded zip/dmg that is
  quarantined, `xattr -dr com.apple.quarantine /Applications/RSMPS.app` also works.
- **Linux** needs none of this: `chmod +x RSMPS-*.AppImage` and run it. On Ubuntu 24.04 and later the Chromium sandbox
  may be blocked by an AppArmor user-namespace policy; start with `--no-sandbox` (less secure) or allow it with an
  AppArmor profile.

How signing plugs in (the workflow already handles it; add the secrets and the next tag is signed):

- **Windows**: buy an OV/EV code signing certificate (or use Azure Trusted Signing, which needs an extra
  electron-builder `azureSignOptions` block). Export a `.pfx`, base64 it, and add the secrets `WIN_CSC_LINK` (the base64
  text) and `WIN_CSC_KEY_PASSWORD`. EV certificates remove the SmartScreen warning immediately; OV ones build reputation
  over time.
- **macOS**: Apple Developer Program (99 USD/year). Create a "Developer ID Application" certificate, export it as `.p12`,
  base64 it, and add `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD`. For notarization also add `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD` (created at appleid.apple.com) and `APPLE_TEAM_ID`.
- With the secrets present the workflow signs automatically; for macOS it also turns on the hardened runtime
  (`-c.mac.hardenedRuntime=true`, using `desktop/entitlements.mac.plist`) and notarizes if `APPLE_ID` is set. Unsigned
  builds keep the hardened runtime off. Signing has never been run in this pipeline: expect to iterate once.

## Troubleshooting

- `npm run desktop:smoke` prints the failing reason (`uiState`, `webgpu`, `consoleErrors`).
- The smoke test uses a throwaway profile and never touches your real RSMPS data.
- Packaged app data (graphs, plugins) lives in the Electron profile folder (`%APPDATA%/RSMPS` on Windows).

## Phone link and firewall (what users see)

"Link a phone" starts an https server inside the app (desktop/phone/, the pairing logic is `vite-plugins/phone-session.ts`,
bundled in at build time). On the first start Windows Defender Firewall shows "Allow RSMPS to communicate on these networks":
tell users to tick **Private networks** and Allow. RSMPS does not add firewall rules itself. macOS may ask "accept incoming
network connections"; Linux firewalls (ufw) may need `sudo ufw allow 47831/tcp`. The port is stable (47831, else a random one saved
in the profile) so an allowed rule stays valid. Build step: `desktop/scripts/bundle-modules.mjs` (esbuild) runs inside
`desktop:build`; `ws` and `selfsigned` are dev dependencies that get bundled, not shipped as node_modules.

Test it: `node desktop/scripts/pack.mjs --dir` then `npm run desktop:smoke:phone` (32 checks incl. renderer certificate trust).

## Add-ons (FFmpeg): how to bump the pinned version

The catalogue is `desktop/addons/catalogue.json`. RSMPS never ships or hosts FFmpeg; the app downloads it on request and refuses
any file whose SHA-256 differs from the pin. To update the Windows build:

1. Pick the new version on <https://www.gyan.dev/ffmpeg/builds/> (linked from ffmpeg.org). The immutable asset is
   `https://github.com/GyanD/codexffmpeg/releases/download/<version>/ffmpeg-<version>-essentials_build.zip`.
2. Download it yourself and compute the hash: `sha256sum ffmpeg-<version>-essentials_build.zip` (compare with gyan.dev's
   published `.sha256`). Put the hash, exact byte size, version, and the `extract.binary` / `extra` paths (folder name inside
   the zip, `ffmpeg-<version>-essentials_build/bin/ffmpeg.exe`) in the catalogue, set `"verified": true`.
3. `npx vitest run desktop`, build, and run `npm run desktop:smoke:addons` (a local fake-archive test of the whole flow). Then
   do one real install from the Plugins dialog on a Windows machine.
4. The current pin (9.0.2) was taken from the hash gyan.dev publishes; it was **not** recomputed from a download in the
   environment that wrote it, so do step 2 once and set `verified: true`. A wrong pin fails safe (install refused).
5. macOS and Linux have no pinned download (rolling or non-immutable upstreams): users bring their own FFmpeg. To add one, add a
   `builds["darwin-arm64"]` entry the same way (zip needs nothing extra; `tar.xz` uses the system `tar`).

Windows installer: `desktop/installer.nsh` adds an unticked "Download FFmpeg after install" page (compiled in the build, not
click-tested). Ticking only writes `%APPDATA%\RSMPS\addon-requests.json`; the app reads and deletes it on first launch and runs
the in-app install. Test it: `npm run desktop:smoke:addons` after `node desktop/scripts/pack.mjs --dir`.

## Update notice (what a release must keep working)

The desktop app asks `https://api.github.com/repos/GustafMos/rsmps/releases/latest` once a day and compares `tag_name` (`vX.Y.Z`)
with its own version. Drafts, pre-releases and tags that are not plain `vX.Y.Z` are ignored, so publish the release (not a draft)
for people to be told. "What's new" opens the release page; "Get it" opens it too until `DOWNLOAD_URL` in
`src/io/update-links.ts` is set to the itch.io / Gumroad page (currently `null`). The request is made by the renderer: the app's
CSP already allows `https:` in `connect-src`, and the GitHub API answers with permissive CORS, so no main-process endpoint is used.
