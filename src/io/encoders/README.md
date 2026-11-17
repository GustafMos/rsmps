# Standalone encoders

Formats the app can write by itself: no FFmpeg, no native code, no new dependency (only `fflate`, already used). They run in the browser, in workers and in Node. All are plain functions over typed arrays; nothing here touches the Output node, the exporter or the CLI. `index.ts` exports a descriptor table (`ENCODERS`, `getEncoder(id)`) so wiring is mechanical.

## Common session API

```ts
const enc = getEncoder('gif')!;                 // { id, label, extension, mime, kind, alpha, lossless, input, begin }
const s = enc.begin({ width, height, fps: 25 }); // fps: number | { num, den }; 29.97 snaps to 30000/1001
await s.addFrame(rgba);                          // straight-alpha RGBA8, width*height*4; the array may be reused afterwards
const parts = await s.finish();                  // Uint8Array[] blob parts: new Blob(parts, { type: enc.mime })
```

`kind: 'image'` accepts exactly one frame. `input: 'float'` (HDR, EXR) takes `Float32Array` or raw half floats in a `Uint16Array` (premultiplied RGBA); an 8-bit array is converted as value/255. Audio descriptors take `addAudio(Float32Array[])` (one array per channel) and options `{ sampleRate, bits }`. Video sessions started with `audio: { sampleRate, channels, bits: 16 | 24 }` accept `addAudio` too (MOV `sowt` / `in24` PCM track).

Memory: sessions keep only their own output chunks (one buffer per frame). MOV `finish()` returns `[head, ...samples, moov]` without copying samples, so pass each frame its own buffer. For big files pass a `sink` (`ByteSink`, sink.ts) to the MOV encoders (`beginHap`, `beginPngMov`, `beginRawMov`, `beginMjpegMov`): ftyp and a 64-bit mdat header go out first, every sample is written as it is added (await `addFrame` / `addTexture` / `addAudio`), the `moov` index is appended at the end and the mdat size is patched with one seek-write (`finish()` then resolves with no parts). A sink that cannot seek needs the total size up front: HAP without Snappy and raw MOV have fixed frame sizes (pass `frames` / `declaredPayload`). Sinks live in src/io/sinks.ts (desktop file, File System Access, memory) and src/cli/file-sink.ts. GIF `palette: 'global'`, APNG `mode: 'palette' | 'auto'` keep a copy of every frame until `finish()` (documented in the options).

| id | label | file | alpha | lossless | notes |
|---|---|---|---|---|---|
| `hap` | HAP | .mov | no | no | Hap1, DXT1 |
| `hap-alpha` | HAP with alpha | .mov | yes | no | Hap5, DXT5 |
| `hap-q` | HAP Q | .mov | no | no | HapY, scaled YCoCg DXT5 |
| `mov-mjpeg` | Motion JPEG MOV | .mov | no | no | needs a JPEG callback (canvas by default) |
| `mov-png` | PNG MOV | .mov | yes | yes | `png ` sample entry |
| `mov-raw` | Uncompressed MOV | .mov | yes | yes | `raw ` 32-bit ARGB |
| `gif` | Animated GIF | .gif | 1 bit | no | exact for 255 colours or fewer per frame |
| `apng` | Animated PNG | .png | yes | yes | |
| `bmp` `tga` `tiff` `qoi` `pam` `ppm` `ico` | | | | | stills |
| `hdr` `exr` | Radiance HDR, OpenEXR half float | | | | float stills |
| `aiff` `flac` | | | | yes | audio |

## HAP (`hap.ts`, `dxt.ts`, `hap-gpu.ts`, `snappy.ts`, `mov.ts`)

* `beginHap({ width, height, fps, format: 'Hap1' | 'Hap5' | 'HapY', snappy?, refine?, audio? })` returns a `HapSession`: `addFrame(rgba)` compresses on the CPU, `addTexture(blocks)` appends blocks made elsewhere (GPU), `addAudio`, `finish()`.
* Frame container per the public HAP spec: 4-byte section header (24-bit LE size, type byte) or the 8-byte form for 16 MiB and more. Type byte = compressor (`0xA0` none, `0xB0` snappy) or texture format (`0x0B` DXT1, `0x0E` DXT5, `0x0F` scaled YCoCg DXT5). Snappy is applied only when it makes a frame smaller. Chunked ("complex") frames, HapA, HapM, BC6/BC7 variants are not produced.
* Sizes: width/height need not be multiples of 4; the texture is padded by edge replication and the MOV track records the real size.
* Compressors (`compressDxt`): integer range-fit (bounding box inset 1/16, diagonal from covariance sign, RGB565 endpoints, nearest-index) + optional CPU least-squares refinement (`refine`, default 2). Alpha blocks use the 8-value mode. `HapY` computes Y/Co/Cg with a per-block scale of 1, 2 or 4 stored in blue.
* GPU: `createHapGpuCompressor(gpu, w, h, format)` (WGSL compute, one thread per block, via `gpu.computePipeline` and `gpu.scratch`; no engine edits). Output is **bit-identical** to `compressDxt(..., { refine: 0 })` (asserted per format and picture type). Input is an engine `rgba8unorm` image. Only HAP Alpha (Hap5) un-premultiplies (like `Gpu.read(img, true)`); HAP (Hap1) and HAP Q (HapY) drop alpha, so they keep the premultiplied colour, which is the picture composited over black, like every other opaque format (asserted with a half transparent picture in src/io/exporter-formats.test.ts). `compress()` resolves with a reused buffer: copy it (`addTexture` does).
* Orientation: blocks are stored top row first, as the FFmpeg HAP encoder does.
* `mov.ts`: generic all-intra QuickTime muxer (`createMovMuxer`): `ftyp qt`, `mdat` (64-bit header only above 4 GiB), `moov` with `mvhd`, `trak` (`tkhd mdia mdhd hdlr minf vmhd dinf stbl: stsd stts stsc stsz stco|co64`), no edit list, every sample a sync sample. Timescale fps*1000 (sample delta 1000) for integer rates, numerator/denominator for rational ones (30000/1001). Optional PCM audio track with chunked `stsc` runs.
* Measured here (1920x1080, one frame, this machine, headless GPU): CPU refine 0 / 2: Hap1 90 / 215 ms, Hap5 113 / 231 ms, HapY 181 / 314 ms; GPU incl. readback about 1 ms. Bytes per frame: texture 1,036,800 (Hap1) and 2,073,600 (Hap5, HapY); with Snappy on a smooth synthetic picture 611 KB, 699 KB, 1,436 KB (content dependent). Snappy costs 20 to 50 ms per frame.
* Verified: block round trips with PSNR thresholds (gradient, edges, pixel art, alpha ramp, noise); GPU = CPU byte equality; Snappy against hand-built vectors from the format description plus round trips; MOV sample tables parsed back; **FFmpeg's HAP decoder** (local binary from `node_modules`, read-only use) opens all three variants and its decoded pictures agree with ours at more than 38 dB PSNR. Not verifiable here: playback in VJ / media-server software. Residual risk: players that are stricter than FFmpeg about the sample description (`Hap1` / `Hap5` / `HapY` entries are 86-byte QuickTime video entries with depth 24 / 32 and no extension atoms), and texture orientation conventions.
* Licence position: HAP is an open specification published by Vidvox under the BSD 2-Clause licence (repository `Vidvox/hap`). S3TC / DXT texture compression patents have expired. This implementation is original code written from the spec and public format descriptions; no HAP or Snappy library code is used. "HAP" is the name of Vidvox's format and is used descriptively.

## Other MOV codecs (`mov-codecs.ts`)

* `beginMjpegMov({ ..., quality, jpeg })`: sample entry `jpeg`. `jpeg` is a callback `(rgba, w, h, quality) => Promise<Uint8Array>`; the default `canvasJpeg` uses OffscreenCanvas `convertToBlob('image/jpeg')` (browser / worker only).
* `beginPngMov`: sample entry `png `, depth 32, one complete PNG file per sample.
* `beginRawMov`: sample entry `raw `, depth 32, 8-bit ARGB (QuickTime's uncompressed layout, widely read; FFmpeg decodes it as `argb`).

## GIF (`gif.ts`)

`beginGif({ width, height, fps, colors, dither: 'none' | 'ordered' | 'floyd', palette: 'local' | 'global', alphaThreshold, diff, loop })`.
Median-cut quantiser (own), exact mapping when a frame has at most 255 colours (256 when it has no transparency and no slot is needed), Bayer 8x8 and Floyd-Steinberg dithering (own kernels, not the app's), LZW with deferred table reset, Netscape loop (`0` forever, `-1` no extension), 1-bit transparency, frame differencing with disposal 1/2 and transparent "keep" pixels, identical frames merged into a longer delay. Delays in centiseconds come from cumulative rounding (`gifDelays`): 25 fps = 4 cs; 24 fps = 4,4,5,4,4,4 ...; the total is exact. Players clamp delays under 2 cs to 10 cs, so rates above 50 fps do not play at speed in browsers. Licence: the LZW patents expired in 2003-2004. "GIF" is a format name.

## APNG (`apng.ts`)

`beginApng({ ..., mode: 'rgba' | 'palette' | 'auto', diff, level, loop })`. `acTL` / `fcTL` / `fdAT` with shared sequence numbers, frame 0 in `IDAT`, delays as exact fractions (den/num seconds, reduced), adaptive row filters, changed-rectangle frames with dispose NONE and the smaller of blend SOURCE / OVER, palette mode with `tRNS` when at most 256 RGBA values exist. `filterRows` is exported.

## Stills

| function | file | notes |
|---|---|---|
| `encodeQoi(rgba, w, h, { alpha?, linear? })` | `qoi.ts` | spec ops RGB, RGBA, INDEX, DIFF, LUMA, RUN; MIT-licensed public spec |
| `encodeTga(rgba, w, h, { rle? })` | `stills.ts` | 32-bit BGRA, top-left origin, TGA 2.0 footer, RLE packets never cross rows |
| `encodeBmp(rgba, w, h, { alpha?, background? })` | `stills.ts` | 32-bit V5 header with masks and sRGB, or 24-bit over `background` |
| `encodePnm(rgba, w, h, { alpha?, background? })` | `stills.ts` | PPM (P6) or PAM (P7 RGB_ALPHA) |
| `encodeIco(rgba, w, h, { sizes?, scale? })` | `stills.ts` | PNG-compressed entries, sizes 1 to 256, picture centred in the square, `nearest` (default, pixel art) or `box` |
| `encodeTiff(data, w, h, opts)` / `encodeTiffPages` | `tiff.ts` | RGBA8 or RGBA16 (`Uint16Array`), none or deflate with predictor, unassociated alpha, strips, optional DPI, multi-page |
| `encodeHdr(px, w, h)` | `float.ts` | Radiance RGBE, new RLE scanlines (8 to 32767 wide), no alpha |
| `encodeExr(px, w, h, { compression })` | `float.ts` | single-part scanline OpenEXR, half RGBA, `none` or `zip` (16 lines per block) |
| `encodeAiff(pcm, bits)` | `aiff.ts` | 16/24-bit big-endian PCM, 80-bit extended rate |
| `FlacEncoder` / `encodeFlac(channels, { sampleRate, bits })` | `flac.ts` | fixed predictors + partitioned Rice, 4096-sample blocks, CRC-8/16, MD5 left zero (allowed), 1 to 8 channels |

Float inputs are premultiplied (the engine's convention and OpenEXR's). **Engine seam needed**: `Gpu.read` / `readRaw` return 8-bit RGBA only. To write HDR / EXR / 16-bit TIFF from the engine, a readback of an `rgba16float` texture as `Uint16Array` (copyTextureToBuffer without the 8-bit conversion pass, rows padded to 256 bytes) is required; the encoders already accept that array directly. `hap-gpu.ts` needs no engine change: it uses only `device`, `scratch`, `releaseScratch`, `computePipeline` and (optionally) `view`.

## Verification summary

`npx vitest run src/io/encoders` runs everything. Each encoder has its own decoder in the tests (round trip), structural checks (CRCs, chunk order, box tables), and `external.test.ts` cross-checks against the FFmpeg binary found in `node_modules` (HAP x3, PNG/raw MOV, GIF, APNG, BMP, TGA, TIFF, PAM, PPM, EXR, AIFF, FLAC); it skips itself when the binary is missing. FFmpeg (a 2018 build) has no QOI or Radiance HDR decoder: those two are verified by their own test decoders only. `index.test.ts` writes sample files to the OS temp folder (`rsmps-previews/encoders/`).

## Trademarks

HAP, GIF, PNG, TIFF, TGA, BMP, QOI, OpenEXR, FLAC, AIFF, QuickTime and MOV are names of formats or products owned by their respective parties. They are used here only to name file formats; no logos are used and no endorsement is implied.
