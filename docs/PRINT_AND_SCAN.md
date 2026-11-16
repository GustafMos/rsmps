# Print and scan back

Print an animation as sheets of frames, draw on the paper, photograph the sheets, and get the frames back as an
animation you can use in the graph.

## Workflow

1. **Print.** Add an Output node, set *Export as* to **Print sheets**, choose paper, orientation, frames across/down
   (or set both to 0 and give a frame width in mm), margin, gutter and the frame guide:
   *Full frames*, *Faded* (strength %), *Outlines only* or *Blank frames, marks only*. *Every Nth frame* prints a
   subset. Output is a PDF (one page per sheet at exact paper size), PNG pages, or both.
2. **Print at 100% / "Actual size".** Never "fit to page" or "shrink to printable area": the registration marks
   and corner markers are placed for the exact paper size and the printer must not rescale. Colour or grey both work.
3. **Draw.** Draw inside the frames in any colour. Do not cover the black **+** marks between frames, the four
   square corner markers or the small data strip at the top.
4. **Photograph or scan.** Flat sheet, even light (no hard shadows from your hand/phone), all four corner markers
   in the picture, camera roughly above the page. Any rotation is fine (the top-left marker is recognisable), and
   perspective from a hand-held phone is corrected. Several pages can be sent in any order. Do not photograph a
   mirror image (back of a translucent sheet).
5. **Scan tab.** Add the photos. Each page shows status, detected corners and warnings. If the corner markers or
   the data strip cannot be read, supply the corners (click them) and/or the layout (paper, columns, rows) and
   re-analyse that page. Commit creates an image-sequence asset (optionally *drawing only*: ink on transparent, or
   with the printed guide divided out when the originals are supplied) that works in a Media In node like a video.

## What the scanner does

1. Greyscale, adaptive (local-mean) threshold, run-length 1:1:3:1:1 finder detection with vertical and horizontal
   cross-checks; the four candidates forming the largest convex quadrilateral are the page corners.
2. The top-left finder has a notch (a black module in its white ring); the best-scoring rotation is tried first.
   If a rotation does not decode, the others are tried (the data strip is the final judge).
3. The data strip is sampled through the homography of the four finders for each paper size and orientation until the
   CRC-16 validates; the decoded header gives the exact page geometry.
4. The four finder positions are refined by normalised cross-correlation on a rectified page, the homography is
   re-solved (8 DOF), then every **+** mark is located by template matching (sub-pixel, parabolic peak). Marks that
   cannot be found follow their neighbours' displacement and are reported.
5. Each frame is cut with the bilinear map of its four refined marks, directly from the photo (one resampling,
   area-averaged when downscaling), so paper curl and lens distortion are absorbed and neighbouring frames register.
6. Paper white is estimated per channel from blank margins and gutters (two passes, rejecting pen strokes) and
   divided out; frames come out flat on white.

Pages are placed by their decoded page index. Duplicate photos of a page keep the better one; photos of a different
printed set are ignored; missing pages and frames are listed in the report.

## Blank sheets (paper-only animation)

**File > Print blank sheets…** (also on the Scan tab's start screen and bar) needs no graph. It prints frame boxes, the normal corner
markers and data strip, "+" marks and frame numbers, and no picture, for animation drawn entirely on paper. The dialog:

* **Frames**: a count, or seconds x frame rate. **Frame aspect**: same as the project, a preset (16:9, 4:3, 1:1, 3:4, 9:16, 4:5, 2:3, 21:9) or custom width : height.
* **Frames per sheet**: the grid (columns x rows) that makes the frames largest on the chosen **paper and orientation** (exact columns and rows from the CLI). **Margins** and **gutter**.
* **Guides inside every frame** (light grey, so pencil dominates): centre cross, thirds, safe area, light grid, perspective horizon line (with a vanishing-point mark), registration / peg marks.
* **Frame numbers** in the gutter above each frame, **frame boxes** just outside the cut area (they never land in a recovered frame), optional **faint onion-skin placeholder numbers** inside.
* **Timing**: shoot on ones / twos / threes (time code and `X2` hold printed beside each frame number), **beat marks** (dots) from an audio asset (a simple energy-onset detector, `io/print/beats.ts`) or a blank column to fill in, and an optional **exposure sheet** page (one row per timeline frame: frame, time code, drawing, hold, beat, action / sound).
* **Download PDF** (or PNG pages, or both). Print at 100 %.

Scanning those sheets uses the Scan tab unchanged: they are ordinary version 1 sheets with the guide set to *blank*. The size the scan cuts the
frames to is recorded as 8 pixels per printed millimetre (about 200 dpi); upscale in the clean-up graph if you need more. A column of timing beside the
frames is done as the time code / hold / beat dot to the right of each frame number (there is no room for a separate column in the page margin).

### Next round (onion-skin rounds)

After a scan project exists, **Print next round…** (below the recovered frames) prints blank boxes that continue the animation. In *Continue*
mode the new frames are numbered after the last scanned drawing and the first box carries that drawing faint (or in non-photo blue); in *Redo*
mode the boxes cover the same frames again, each with its own drawing faint, to ink over pencil. Round sheets carry the same project id and a
**round** number in the strip; **Add photos…** adds the new photos to the same scan project, frames are placed by their printed numbers and later
rounds replace earlier ones. Remove the printed picture again with the same *Keep only what I drew* step.

## Rotoscope sheets

The Output node's Print group has **Picture style**: *Full* (the Frame guide setting, as before), *faint* (picture printed at a chosen strength),
*outline* (edges only, light grey or non-photo blue) and *non-photo blue* (the picture's darkness becomes light blue). On the scan side the
clean-up graph of a scan project gets a **Remove Printed Guide** node ("Keep only what I drew", `color/remove-guide`, GPU):

* blue guide: by colour. The blue is bright in green and blue, graphite and dark ink are not, so darkness is read from the blue channel (do not draw in blue);
* faint / outline guide: when the **Original frame** input is wired, the guide is rebuilt exactly as printed and divided out (scan = guide x drawing); otherwise a threshold just above the guide's printed strength is used.

The strip records the style, so the node's settings are filled in automatically. **The original is not looked up automatically**: the scan project does
not contain the printing project's frames, so for the exact method wire a render of them (for example a Media In with the original frames) into *Original frame*; without it the threshold fallback is used.

## Paper layers

The Output's **Paper layers** (1 to 8) prints each layer as its own sheet set with the same frame boxes (picture on layer 1 only, or on every layer);
files are `name_layer1.pdf`, `name_layer2.pdf`. The strip records the layer, so photos of all layers can be added together. The Scan tab groups
recovered frames per layer and the scan project gets one **Scanned frames N** source per layer, each through *Keep only what I drew* (if a guide was printed)
and Paper Clean set to *ink on transparent*, wired through a **Stack** (layer 1 at the bottom), so they come back as separate layers with alpha.
*Not done:* an Output with several image inputs (it still has one `image` input), so layers come from the layer count, not from separate wires.

**Marker payload versions.** The existing id format had no room for a layer without changing the meaning of printed fields, so the strip is *versioned*:
version 1 is exactly what older builds print and read. Version 2 is version 1 followed by an extension (layer 6 bits, layer count 6, round 6, blue-guide flag 1;
payload 33 bytes, CRC after it). It is written only when a sheet has more than one layer, a round above 0 or a blue guide, so every ordinary sheet is still
a version 1 sheet with the same field layout as before. The reader accepts both. Sheets printed by the previous version go through the same decoder path as always;
an older build cannot read version 2 sheets.

## Flipbook and zine

Output *Layout*: *Flipbook* prints small frames in reading order, a **binding margin** on the left / right / top of every frame, dashed **cut lines**,
frame numbers (`n/N`), an optional **thumb index** (a tab whose position steps along the edge) and **duplex**: frame N + half goes on the back at the mirrored cell
(long-edge flip; short-edge for top binding), so the stack reads both ways. *Zine* prints the 8-page single-sheet fold on landscape paper: top row (turned half a
turn) 5 4 3 2, bottom row 6 7 8 1; fold lines are dashed, the middle slit is a solid CUT line. Every 8 frames make a sheet. These pages carry **no scan markers** (not scannable).

## Plates and plotter output

Output *Print as*: *Plates* writes one file set per ink (a PDF per ink with a page per frame, or PNGs). The palette is the exact colours of a picture that already has few enough colours
(quantized, dithered), else k-means with the chosen number of inks; near-white is paper and gets no plate. Each plate is black coverage on white with registration marks
outside the frame and the ink name (nearest stock risograph colour) and hex printed below. *Pen plotter SVG* traces every ink into closed paths (marching squares,
Ramer-Douglas-Peucker simplification), optional hatch fill, nearest-neighbour path ordering, SVG in millimetres with one Inkscape / AxiDraw layer per ink. Tracing gives the outline of
filled shapes (a thin line becomes a narrow outline loop, not a centre line). Code: `separations.ts`, `plot.ts`.

## Scanned textures

Scan tab > **Texture…** (no markers): choose a photo of paper, tape, scribbles; drag the four corners to crop and deskew; optionally make it seamless (cross-fade of four half-offset copies);
**Save to Textures shelf** (an ordinary persisted image asset tagged `shelf: 'textures'`; nothing is bundled and the shelf starts empty). The **Paper / Texture Overlay** node (Stylize)
takes a wired texture or one picked in its *Library texture* field, with multiply / screen / overlay, scale and a boil that jumps between a few poses and repeats in whole
cycles of the project length. The media panel lists shelf textures with all other media; a dedicated shelf filter there is not built.

## Holds (shoot on ones / twos / threes)

Under the recovered frames: a global *shoot on* rate and a hold number under each drawing (`io/print/holds.ts`). The hold list is baked into the hidden working sequence
(a drawing is repeated for its hold), so the **Scanned frames** source plays with the right timing; the project length follows it.

## Scan with phone

**Scan tab > Scan with phone…** (start screen and next to *Add photos…*) photographs the sheets with your phone and sends them to the open scan project over the phone link,
with no uploading and downloading. It needs the same phone link as the Phone Camera node (desktop app, or `npm run dev:lan`; see LIVE_INPUT.md for addresses, the
certificate warning and the firewall).

1. Press **Scan with phone…**. If a phone is already linked (for example for a Phone Camera node) that session is reused and the phone switches to scan mode: no second QR code.
   Otherwise a QR code appears; the link carries `&mode=scan` after the unchanged pairing token, so the phone opens straight in scan mode.
2. **Phone:** a live viewfinder from the rear camera with a guide frame. Four corner ticks turn from grey to white as the corner squares of a sheet come into view, with a hint
   ("Point at a printed sheet", "Move back: 2 of 4 corner squares in view", "Move closer", "Hold steady", "All four corners found"). The check runs about 4 times a second on a downscaled
   preview (720 px long side) with the scanner's own finder search (`finder.ts`, which imports nothing else, so the phone bundle stays small). It does not read the data strip, so it cannot tell
   *which* sheet it is, only that a sheet is there; "Sheet 3 of 6" appears under the thumbnail once the computer has read the photo.
3. **Shutter**, or **Auto-capture** (all four corners found and holding still for 0.7 s; it fires once per sheet and re-arms when the sheet leaves the view). Each shot is a full-resolution still, not a
   video frame (see "Capture paths"). JPEG quality is 0.95 where the page encodes the picture itself.
4. Each photo is uploaded (bar on its thumbnail) and goes straight into the same parallel pool as *Add photos…* (only the new photos are scanned; earlier pages keep their results: `ScanApi.append`).
   The thumbnail then shows **Scanning…**, **Sheet N of M, frames a–b**, or **Failed: corner marker not found** with a **Retake** button.
5. **Done** on the phone shows the **preview**: the assembled animation as a loop at the project frame rate with play / pause, a scrubber and a frame counter, plus a list of what is missing
   ("Sheet 4 not scanned yet", or the missing frame numbers) so you can reshoot immediately. The computer sends the preview by itself 1.5 s after the last scan finishes, when the phone presses Done,
   and on demand with **Send preview to phone** (next to the "Phone connected · 3 photos received" line in the Scan tab).

### Capture paths

| Where | Path | Notes |
| --- | --- | --- |
| Chrome / Android (ImageCapture) | `ImageCapture.takePhoto()` at the largest photo size the track reports | a real photo, usually the full sensor; the default photo size is used if an explicit size is refused |
| A browser with a stream of 2500 px or more but no ImageCapture | the track is asked for its largest size (`applyConstraints`), the video frame is drawn on a canvas (kept under 16 MP) and encoded as JPEG 0.95 | the preview size is restored afterwards |
| iPhone / Safari, and anywhere else | a hidden `<input type="file" accept="image/*" capture="environment">`: the phone's own camera app | always works, full resolution, one tap per sheet, so auto-capture is off; the viewfinder is released while the camera app is open |

The page picks per device and says which path it uses under the viewfinder. If a path fails at run time the next one is tried.
A picture that is not JPEG / PNG / WebP (for example HEIC from a camera app) is re-encoded as JPEG 0.92 on the phone first; one over 40 MB is shrunk step by step.

### How the photos travel (protocol)

Everything uses the existing pairing WebSocket. The relay (`PhoneSessions`, shared by the dev server and the desktop app) passes text and binary frames untouched and never looks inside; both
servers accept messages up to 4 MiB, so nothing server-side changed. Chunks are 256 KiB binary frames, not base64 (a JSON `scan-chunk` with base64 `data` is accepted as a fallback). A binary frame
that starts with the magic `RSCN` is scan data; the camera's fallback frames start with `FF D8` and are never confused with it.

| Message | Direction | Fields / meaning |
| --- | --- | --- |
| `hello` | phone > computer | `mode` (camera, scan, controller), `media` (video, none, refused). Sent at every connect and mode change; the computer shows the phone as linked from it |
| `mode` | computer > phone | switch a linked phone to `scan` / `camera` / `controller` |
| `scan-ready` | computer > phone | limits (40 MB per photo, 600 MB and 200 photos per session, chunk size, window) and the project fps |
| `scan-begin` | phone > computer | `id` (u32), `name`, `size`, `mime` (the message's own `type` is the discriminator), `w`, `h`, `chunks`, `chunk` |
| binary chunk | phone > computer | 13 byte header (magic, kind 1 = photo, id, seq) + payload |
| `scan-ack` | computer > phone | `next`: every chunk below it arrived. The first ack to a begin carries the resume point (0, or where a dropped upload stopped) |
| `scan-nak` | computer > phone | `seq`: this chunk is missing, send again from there |
| `scan-end` | phone > computer | `len` and `crc` (CRC-32, 8 hex digits) of the whole file |
| `scan-ok` / `scan-reject` | computer > phone | accepted / refused with `code` (too-big, bad-type, too-many, session-full, id-in-use, busy, unknown-id, bad-chunk, mismatch) and a plain `reason` |
| `scan-status` | computer > phone | per photo: `received`, `scanning`, `done` (`sheet`, `sheets`, `frames` [a, b], optional `note`), `failed` (`note`, `retake`) |
| `scan-summary` | computer > phone | sheets in the set, missing sheets, missing frames, recovered / total, fps, busy |
| `scan-done` | phone > computer | "Done": send the preview |
| `preview-begin`, chunks (kind 2), `preview-end`, `-ack`, `-nak`, `-ok`, `-reject` | computer > phone (acks back) | the same transfer in the other direction |

Back-pressure: the sender never has more than 6 chunks unacknowledged and never queues more than 1 MiB on the socket (it waits on `bufferedAmount`). Silence for 4 s sends the unacknowledged chunks again,
5 silences in a row fail the photo ("The computer did not answer"); a gap makes the receiver ask for the missing chunk; a checksum or length mismatch discards the copy and the sender restarts that photo
(twice at most); after a dropped connection the page sends `scan-begin` again and the computer answers where to resume. A failed upload shows **Send again** (the photo is still on the phone).

**Received files are untrusted.** The computer checks size, type and count at `scan-begin`, every chunk's number and length, the total length and CRC, and the real file type from its first bytes
(JPEG / PNG / WebP only; a script or HTML file called `.jpg` is refused). Uploads that go quiet for 60 s are dropped. The bytes are only ever decoded by the scan pipeline's own safe decode path (the same as
dropped files), never executed, and the only place they are stored is the scan project's normal session storage (with the photos you added by hand).

### Preview packaging

One sprite-sheet JPEG plus a description: at most 96 frames (every Nth frame when there are more, and the playback rate is divided by N so the loop lasts as long as the animation), each cell at most
480 px on its long side, the sheet at most 4096 px on a side and 8 MP (so 96 frames come out at about 400 px). Missing frames show the previous drawing and are listed; transparent pixels are put on white.
Code: `src/io/phone-scan-preview.ts`.

### Code

Phone: `src/phone/scan-mode.ts` (page), `scan-check.ts` (corner check, steadiness, auto-capture gate, hints), `scan-capture.ts`, `scan-transfer.ts` (chunk sender and receiver, shared with the computer),
`scan-protocol.ts` (messages, limits, validation), `scan-photos.ts` (thumbnail statuses), `scan-preview.ts`, `link-modes.ts`. Computer: `src/io/phone-scan.ts` (receiver, controller, status mapping),
`src/ui/scan/PhoneScanPanel.tsx`. The scan itself is unchanged; `ScanImpl.append` only keeps the pages already scanned. **Not done:** the phone cannot read the data strip live (it says "sheet found", not which
sheet); one phone per scan project at a time.

## Speed

Scanning runs in a pool of Web Workers (`scan/scan.worker.ts`, scheduling in `scan/pool.ts`), so photos never freeze the UI and several are scanned at once. Where workers do not exist or cannot be created, the same job code
(`scan/job.ts`) runs one photo at a time on the main thread with a yield between photos.

* **How many at once:** N = clamp(cores - 1, 1, 4), and never more jobs than fit the memory budget (the memory governor's RAM budget, 1.5 GB by default): a job is estimated at 14 bytes per decoded photo pixel + 48 MB
  (a 12 MP photo about 216 MB, a 25 MP photo about 400 MB), so large photos run fewer at a time and a photo bigger than the whole budget runs alone. Jobs start in list order.
* **Decode in the worker:** the encoded file goes to the worker (a Blob is shared, not copied), is decoded there (createImageBitmap + OffscreenCanvas; if the worker lacks them the main thread decodes and the pixels are transferred),
  and the cut frames, the rectified page and a 1024 px preview come back as transferables. The main thread never holds a full photo; a manual re-analysis sends the file again.
* **Order:** results are stored by list position, never by completion order; `assembleScan` sorts pages by round, layer and decoded page index, so the same photos give the same frames however the workers finish.
* **Progress and cancel:** `io.scan.analyze(files, options, { onProgress, signal })` reports queued / scanning / done / failed per photo with completed / total; a failing photo gets its own error page and the others go on;
  aborting drops queued photos, terminates running ones and frees their slots. Workers are reused and terminated after 30 s idle.
* **Single photo:** the four finder searches rectify only their search windows (not the whole page) and match coarse-to-fine (every second position on a half-resolution template, the best three scored exactly with integral-image window sums).

Measured with synthetic photos on the dev machine (Node, other work running): 3000 x 4000 photo about 2.0 s before and about 1.0 s after (cut frames byte-identical); 10 photos 13 to 16 s sequential and about 5.3 to 5.6 s with 4 workers.
A 20-sheet blank-sheet PDF at 300 dpi takes about 3 s (about 155 ms per sheet, never more than about 190 ms between yields).

## Sheet format (version 1)

All coordinates are mm from the top-left of the page; the frame area keeps 20 mm bands at top and bottom.

* **Finder patterns**, 7 x 7 modules of 1.4 mm (9.8 mm), outer edge 7 mm from the two adjacent page edges, centres
  at 11.9 mm. Black 7x7, white 5x5, black 3x3 core. The **top-left** finder additionally has the module at (1,1) black
  (the top-left corner of the white ring), which makes it distinguishable without disturbing the 1:1:3:1:1 centre lines.
* **"+" registration marks** at every cell corner, shared by neighbours, in the gutter centres:
  `x = gridX0 + col * pitchX - gutter/2`, `y = gridY0 + row * pitchY - gutter/2`, `col = 0..columns`, `row = 0..rows`.
  Arm half-length `min(2.0, gutter/2 - 0.3)` mm (at least 0.8), thickness 0.4 mm. A cell's content is the rectangle
  `gutter/2` inside its four marks.
* **Data strip**, a 41 x 9 module grid of 0.9 mm modules (36.9 x 8.1 mm), centred horizontally between the top
  finders and vertically on their centres. Row 0 and column 0 are the timing pattern (black on even indices, black
  at the corner); the thresholds are calibrated from them. The remaining 40 x 8 modules carry 40 bytes row by row,
  most significant bit first.
* **Header**, all integers big-endian bit fields; lengths in 0.1 mm:

  | field | bits | | field | bits |
  |---|---|---|---|---|
  | version (1) | 4 | gridX0, gridY0 | 14 each |
  | paper (a4,a3,letter,a5,legal) | 3 | firstFrame | 16 |
  | landscape | 1 | totalFrames | 16 |
  | pageIndex (0-based) | 12 | fps x 100 | 14 |
  | pageCount | 12 | frameW, frameH (px) | 14 each |
  | columns, rows | 6 each | guide (full,faded,outline,blank) | 2 |
  | cellW, cellH | 14 each | guideOpacity (%) | 7 |
  | pitchX, pitchY | 14 each | projectId | 32 |

  243 bits, then CRC-16/CCITT (init 0xFFFF, poly 0x1021) over the 31 payload bytes, then zero padding.
* **Caption** at the foot: project name, page n/m, frame range, fps and the first six hex digits of the project id,
  in a built-in 5x7 bitmap font.

## Code map

`src/io/print/`: `format.ts` (constants, header, strip, version 2 extension), `layout.ts` (sheet planning), `render.ts` (pages, guide
styles, font drawing), `guides.ts` (frame boxes, numbers, drawing guides), `blank.ts` (blank sheets, next round), `exposure.ts`, `holds.ts`, `beats.ts`,
`imposition.ts` (flipbook, zine), `separations.ts`, `plot.ts`, `texture.ts`, `sheetfiles.ts` (PDF / PNG writer shared by all), `pdf.ts`, `png.ts`,
`export.ts` (the Output node's *print* kind), `scan/` (`finder`, `strip`, `rectify`, `refine`, `clean`, `page`, `pipeline`, `decode`, `job`, `pool`, `batch`, `scan.worker`). Nodes: `color/remove-guide`, `stylize/paper-texture`. Browser glue is `src/io/scan.ts`; the UI contract is in
`src/io/api.ts` (`Io.scan`, `ScanResult`, `ScanReport`).

## From the command line

`rsmps graph.json out/ --kind print` (or an Output node whose kind is `print`) writes the same print sheets as the app (PDF and/or one PNG per page, as the node's Print options say), using the exporter's own sheet code. See CLI.md.

`rsmps print-blank --out sheets/ --frames 48 --per-sheet 6 --aspect 16:9 --guides thirds,cross --exposure-sheet` prints blank sheets without any graph.
