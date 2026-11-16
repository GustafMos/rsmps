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

`src/io/print/`: `format.ts` (constants, header, strip), `layout.ts` (sheet planning), `render.ts` (pages, guide
styles, font drawing), `pdf.ts`, `png.ts`, `export.ts` (the Output node's *print* kind), `scan/` (`finder`, `strip`,
`rectify`, `refine`, `clean`, `page`, `pipeline`). Browser glue is `src/io/scan.ts`; the UI contract is in
`src/io/api.ts` (`Io.scan`, `ScanResult`, `ScanReport`).

## From the command line

`rsmps graph.json out/ --kind print` (or an Output node whose kind is `print`) writes the same print sheets as the app (PDF and/or one PNG per page, as the node's Print options say), using the exporter's own sheet code. See CLI.md.
