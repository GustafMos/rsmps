# Splat from Video

The **Splat from Video** node (category Generate, desktop app only) turns a clip or a photo set into a 3D Gaussian splat scene that you can
fly through, and gives back the camera move of the original shot as a Camera output. It is a process node: until you press
**Reconstruct** the clip passes through unchanged, so the graph keeps playing.

## What happens when you press Reconstruct

1. **Frames are chosen** (renderer, `src/engine/lib/frame-select.ts`). Up to 4 x *Frames* candidate moments of the clip (or of *Use from* /
   *Use until*) are looked at small. The camera's "distance travelled" is measured from frame to frame (exposure changes do not count),
   and the picks are spread evenly along it: a stretch where the camera stands still gives no frames, a fast stretch gives more. In each
   stretch the sharpest candidate wins (variance of the Laplacian), which drops motion-blurred frames. The picked frames are pulled through
   the graph, so anything upstream (crop, color, stabilize) applies, made at most *Max side* pixels and sent as JPEG (quality 0.92).
   A photo set (*Photos*) is used as is, in its order.
2. **COLMAP** (`feature_extractor`, then `sequential_matcher` for video or `exhaustive_matcher` for photo sets of up to 150 pictures,
   then `mapper` or `global_mapper`, then `image_undistorter`) finds where the camera was for every frame. One SIMPLE_RADIAL camera
   for a clip; the frames are undistorted to a pinhole camera before training.
3. **Brush** trains the splats on those frames and cameras (spherical harmonics degree 1, which is what the viewer draws).
4. The result is moved into this tool's frame (y up; `src/engine/lib/colmap.ts`) and stored with the project: the splats as a standard
   3DGS `.ply` (`comment up +y`, so it also opens correctly in a Gaussian Splat node) and the solved cameras as a camera path keyed by clip time.

The node then renders the splats with exactly the view and look settings of Gaussian Splat. Its **Solved camera** output is the original
camera at the current time, carried through the node's own transform: wire it into the node's Camera input to see the scene from the
original move, or into another 3D node to composite 3D objects into the footage (match-moving).

## Footage that works, footage that fails

Works best:

- a **20 to 60 second walk around** a still subject (an object on a table, a statue, a room corner), the camera always moving sideways;
- sharp frames: good light, slow movement, no digital zoom; locked exposure and focus if your phone allows it;
- plenty of texture (wood, stone, print, plants, clutter).

Fails or gives poor results, with the message you will see:

| Footage | What happens |
| --- | --- |
| The camera only turns on the spot (a pan) | COLMAP "solves" it but there is no depth. Refused: "The camera hardly moved sideways (it only turned)." Measured on a synthetic pan: parallax 0.14 (an orbit is about 1.6). |
| Plain surfaces, sky, water, heavy blur | "No two frames share recognisable detail, so no camera could be placed." |
| No good start | "COLMAP found no good starting pair of frames: the camera must MOVE sideways..." |
| Only part of the clip is placed | A warning: "Only N of M frames could be placed; the rest are left out." |
| Moving people, cars, leaves, reflections, screens | Smears and floaters in the splats (the method assumes a still scene). Crop them away or film without them. |
| Views far from where the camera went | Holes and fog. Splats only know what the camera saw: an arc of 100 degrees gives a good scene inside that arc and a poor one behind it. |
| Not enough graphics memory | "Brush ran out of graphics memory." Use Draft, fewer frames or a smaller Max side. |

## Measured on synthetic scenes (stage 0, Windows 11, RTX 3080, COLMAP 4.2.1 without CUDA on 4 CPU threads, Brush 0.3.0)

There was no real phone footage in these tests. The test scenes are ray-traced (a textured floor, boxes, spheres; 640x480 or 640x360) with
exactly known cameras, so every number below compares with the truth.

| Scene | Frames | COLMAP | Placed | Rotation error | Position error | Training | Held-out PSNR / SSIM |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Orbit, photo set | 48 | exhaustive + incremental: 4 s + 59 s + 5 s | 48 / 48, 0.42 px | 0.05 deg mean, 0.11 max | 0.07 % of the orbit radius | 10,000 steps 88 s | 24.8 dB / 0.90 |
| Same, through the node (frame selection, the real client and main-process module) | 47 | sequential + incremental | 47 / 47 | | 0.29 % RMS | Normal, 144 s for everything | 24.4 dB (23.7 to 25.1) / match-move 22.6 and 23.8 dB |
| 100 degree arc ("video") | 60 | sequential + incremental: 5 s + 26 s + 13 s | 60 / 60, 0.36 px | 0.20 deg mean | 0.04 % | 10,000 steps | 19 dB inside the arc, 12-15 dB behind it |
| Handheld-style: wandering 160 degree walk, shake, motion blur, exposure drift | 130 | sequential + incremental: 13 s + 51 s + 54 s | 130 / 130 | 0.15 deg mean, 0.27 max | 0.2 % | Normal, 103 s (222 s for everything) | 19-22 dB inside the walk, 15-16 dB behind it |

Other findings that set the defaults:

- **COLMAP's no-CUDA build hangs** (no output for 5 minutes) when asked for GPU feature extraction. The pipeline always asks it for CPU;
  only the CUDA build (a separate add-on) is asked for GPU. The CUDA build itself was not tested.
- Global and incremental solving were equally accurate here (global 0.03-0.17 deg, incremental 0.05-0.20 deg). Incremental is the default.
- Exhaustive matching in blocks of 10 took twice as long as one block (118 s against 59 s for 48 frames); blocks of 25 are used.
- Brush trained at degree 3 and drawn at degree 1 scored 0.7 dB lower than training at degree 1: the pipeline trains degree 1.
- **"Fade tiny splats" (Mip-Splatting compensation) was wrong for trained files**: with it on, held-out views scored 22.2 dB / 0.82
  instead of 24.8 dB / 0.90. It is now off by default in Gaussian Splat too.
- **Min opacity 0.02** (Gaussian Splat's default) punched holes in the trained sky (21.2 dB instead of 24.4 dB through the node), so
  Splat from Video defaults to 0.

## From a 3D Scan (experimental)

A scan taken with the phone already knows where the phone was for every photo, so COLMAP does not have to solve the cameras. The photos
and positions come from the **3D Scan** node (Android Chrome, AR view); the desktop app does the rest.

**On the phone.** Add a 3D Scan node, open its inspector and press *Start scan*. Aim at the surface beside the object and tap, fit the dome
to the object, press Start and walk slowly all the way round, then lower and higher. Coverage needed: at least about 40 photos, neighbouring
photos no more than about 15 degrees apart, at least two heights (the panel's coverage map shows what is missing; red = no photo from there).
Keep the object still, the light even, and the photos sharp. Then press **Save scan for a computer**: one zip file is downloaded.

**On the computer.** Open RSMPS (the desktop app), add a 3D Scan node and press **Load scan file** (pick the zip). The photos go into Media
and the node holds the scan. Add a **Splat from Video** node, open its inspector and, under *From a 3D Scan*, press *Use ... (N photos)*.
Then press **Reconstruct** as usual. *Refine cameras* (off by default) also corrects small errors in the saved positions; try it if the
result looks doubled or soft. A chosen scan is used instead of Photos and the Clip input.

**What happens.** The photos are sent like a photo set; the saved camera model is written as a COLMAP text model (PINHOLE, one image per
photo, world-to-camera poses in metres, object centre at the origin; conventions in `src/engine/lib/scan-export.ts`, proved by
`scan-export.test.ts`). COLMAP then runs `feature_extractor`, a matcher (exhaustive up to 150 photos, else sequential), and
`point_triangulator` with that model as input instead of `mapper`; with *Refine cameras* also `bundle_adjuster`. The usual
`image_undistorter` and Brush steps follow, unchanged. If the triangulation fails or finds hardly any points, the job says "The saved camera
positions did not fit the photos; solving them from the pictures instead." and continues with the normal solver on the same photos.

**Scan with a linked phone.** Instead of saving a zip on the phone and loading it, you can run RSMPS on the computer and scan with a phone that is
linked to it over the same network: select the 3D Scan node and press *Scan with a linked phone* (the phone's steps are in LIVE_INPUT.md, "3D scan with
a linked phone"). The photos and positions arrive in the node as they are taken, with live coverage on the computer, and the finished scan is one undo
step. If the link drops, the photos that arrived are kept and usable. The scan is the same as a local one, so *From a 3D Scan* works unchanged.

**Not verified.** COLMAP and Brush were not available when this was written: the argument lists are tested, and the steps are tested
against fake programs, but the real `point_triangulator` / `bundle_adjuster` options and output were not run. If a COLMAP version rejects an
option, the job falls back to the normal solver and shows the sentence above; the job's log (`logs/triangulate.log` in the job folder) has
the reason.

**Without the desktop app.** The zip also opens directly in other tools: it holds `images/`, a COLMAP text model in `sparse/0/`, a
`transforms.json` and a `README.txt` with copy-paste commands for COLMAP with known poses, Brush, nerfstudio and gsplat.

## What you need

- The **desktop app**. The web version cannot start programs on your computer; the node says so. The command line cannot run it either.
- The **COLMAP** add-on (Windows: 128 MB download, about 230 MB unpacked; macOS Apple silicon: 83 MB), or **COLMAP (NVIDIA)** (Windows only,
  415 MB, needs an NVIDIA card), and the **Brush** add-on (Windows 159 MB, macOS 41 MB, Linux 44 MB). COLMAP has no Linux download: install it
  with your package manager and press Locate. All are installed only when you press Install in Plugins > Official add-ons; each download is
  checked against a pinned SHA-256 and size, and the program is re-checked before it runs. The Windows programs are not code-signed: your
  antivirus may scan them the first time (COLMAP's first start took about 30 s).
- A **graphics card Brush can use** (Vulkan on Windows and Linux, Metal on macOS). Tested: NVIDIA RTX 3080 (Vulkan). Not tested: AMD,
  Intel, Apple.
- **Disk space**: the job checks for at least 2 GB plus 12 times the size of the frames before it starts.
- **Time**: Draft (3,000 steps at up to 960 px) took 27-33 s of training for 48 frames, Normal (10,000 steps, up to 1280 px) 90-150 s, High
  (30,000 steps, up to 1600 px) several times longer, plus COLMAP (1-2 minutes for 50-130 frames on the CPU). Real footage at 1280 px will
  take longer than these 640 px tests.

## Where the files live

Everything runs on your computer; nothing is uploaded.

- Add-on programs: `<app data>/addons/colmap/4.2.1/`, `<app data>/addons/brush/0.3.0/` (Plugins > Official add-ons > Remove deletes them).
- Work folders: `<app data>/splat-train/jobs/<id>/` while a job runs; deleted when its result was read (a failed job keeps its logs until the
  next start of the app or 24 hours).
- Kept camera solutions (*Keep poses*): `<app data>/splat-train/cache/`, the last 3 frame sets.
- Brush's GPU tuning cache: `<app data>/splat-train/brush-home/`.
- The trained splats and the camera path: stored with the project, like a bake.

## Licenses

COLMAP is BSD-3-Clause (its Windows archive also contains libraries under their own licenses, such as Qt under LGPL-3.0); Brush is
Apache-2.0. Neither is part of RSMPS, and both run as separate programs. Not used, for license reasons: the INRIA 3DGS reference code
(non-commercial), OpenSplat (AGPL), gsplat (needs Python and PyTorch), VGGT / MASt3R (gated or non-commercial weights). See
THIRD_PARTY_NOTICES.md.

## For developers

- Pipeline: `desktop/addons/splat-train.mjs` (argument arrays, progress parsing from recorded logs, error mapping, process-tree kill,
  timeouts, disk check, cache), endpoints `/__rsmps/splat-train` in `desktop/main.mjs`, client `src/io/splat-train.ts`, node
  `src/engine/nodes/generate/splat-train.node.ts`, coordinates `src/engine/lib/colmap.ts`, shared view code `src/engine/lib/splat-scene.ts`.
- Tests: `desktop/addons/splat-train.test.mjs`, `desktop/addons/manager.test.mjs`, `src/engine/lib/colmap.test.ts` (a recorded COLMAP solve
  against the truth), `src/engine/lib/frame-select.test.ts`, `src/engine/nodes/generate/splat-train.test.ts`. The last one has an opt-in end
  to end run with the real programs: set `RSMPS_SPLAT_E2E` (a folder with `scene/orbit`, `scene/heldout`, `scene/cameras.json`),
  `RSMPS_COLMAP` and `RSMPS_BRUSH`. The synthetic scene generator used for stage 0 is not part of the repository.
