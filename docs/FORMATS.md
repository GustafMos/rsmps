# Output formats

RSMPS writes most of its output formats itself, so they work in the web version too. Others come from your browser's own encoders, and a few need FFmpeg (the optional add-on of the desktop app, or your own FFmpeg on the command line). The Output node's lists are grouped by use; a format that needs FFmpeg is tagged "needs FFmpeg add-on" until FFmpeg is set up.

<!-- formats:guide:start -->
| Family | Written by the app itself (every version) | Written by the browser | Needs FFmpeg (desktop add-on or command line) |
| --- | --- | --- | --- |
| Video and animated pictures | HAP, HAP Alpha, HAP Q, Motion JPEG MOV, PNG MOV lossless, Uncompressed MOV, Animated GIF, Animated PNG | H.264 MP4, H.265 MP4, VP9 WebM, AV1 MP4 | DXV-compatible, ProRes-compatible Proxy, ProRes-compatible LT, ProRes-compatible 422, ProRes-compatible 422 HQ, ProRes-compatible 4444, ProRes-compatible XQ, DNxHR-compatible LB, DNxHR-compatible SQ, DNxHR-compatible HQ, DNxHR-compatible HQX, DNxHR-compatible 444, CineForm-compatible, CineForm-compat. alpha, Animation alpha MOV, FFV1 MKV lossless, UT Video AVI, Uncompressed 10-bit, Uncompressed RGBA AVI, H.264 FFmpeg quality, H.264 all-intra, H.265 FFmpeg quality, H.265 all-intra, AV1 FFmpeg quality, WebM VP9 with alpha, Animated WebP, Animated AVIF, VP8 WebM, MPEG-2 MPG, MPEG-4 AVI |
| Pictures and image sequences | QOI, TIFF, TGA, BMP, OpenEXR, Radiance HDR, TIFF 16-bit, ICO icon, PPM | PNG, WebP, JPEG, AVIF | DPX, JPEG 2000 |
| Sound files | WAV 32-bit float, WAV 24-bit, WAV 16-bit, AIFF 24-bit, AIFF 16-bit, FLAC 24-bit, FLAC 16-bit | AAC M4A, Opus WebM | MP3, Opus OGG, Vorbis OGG, ALAC M4A |

70 formats in all: 24 written by the app itself, 10 by the browser's own encoders, 36 by FFmpeg.
<!-- formats:guide:end -->

Each format has one entry. When it could be written two ways the app chooses for you: formats with an encoder of their own are always written by the app, so they never depend on an add-on and give the same file everywhere (the web version, the desktop app and the command line).

## Video

**HAP, HAP Alpha, HAP Q** (QuickTime .mov). HAP is an open video format for live visuals: every frame is stored as a GPU texture, so playback costs almost no processor time and files scrub and loop smoothly. HAP is supported by many VJ and media-server applications; check your software's documentation for the exact variants it plays. Use HAP for opaque clips, HAP Alpha for overlays, HAP Q when color fidelity matters more than size. Files are large: about 1 MB per 1080p frame for HAP and 2 MB for the Alpha and Q variants before compression. "Smaller files" (on by default) adds Snappy compression, usually a third to a half smaller and still GPU-friendly. A 1080p frame takes about a millisecond to compress on the GPU. The "Better" quality refines every block on the processor: slightly sharper, but 100 to 300 times slower. The Output's "For" preset never picks HAP by itself; choose it explicitly.

**Motion JPEG MOV** is lossy, small, edits well and plays quickly. **PNG MOV** is lossless with transparency. **Uncompressed MOV** is lossless 32-bit with transparency and no decoding work, at 4 bytes per pixel per frame (a 1080p second is about 200 MB). All four are all-intra: every frame is a key frame, good for editing and layering. HAP, HAP Q and Motion JPEG have no transparency; the picture is placed over black.

**H.264, H.265, VP9, AV1** come from the browser's own encoders and work everywhere the browser can encode them. **ProRes-compatible, DXV-compatible, DNxHR-compatible, CineForm-compatible**, lossless codecs, constant-quality and all-intra H.26x, AV1 by quality, VP9 with alpha, VP8, MPEG-2 and MPEG-4 are written by FFmpeg; the "-compatible" files follow the format but are not made by those companies' software. DXV-compatible and ProRes-compatible are the ones to try in Resolume; test your file before a show.

Big files are written as they are made: the desktop app streams to the file you chose in the Save dialog, browsers with the File System Access API (Chrome, Edge) ask where to save, and otherwise the file is kept in memory with a plain refusal above about 1.5 GB ("Use a smaller size, HAP Smaller files, the desktop app, or an image sequence").

## Animated pictures

**Animated GIF** runs everywhere. A palette of up to 256 colors per frame (or one shared palette), so pixel art with up to 255 colors per frame is stored exactly. One level of transparency, no dithering, ordered or diffusion dithering, a loop count, and smaller files from storing only the changed area of each frame. Delays are in hundredths of a second; the app carries the rounding forward so the average speed is exact (24 fps alternates 4 and 5). Browsers play delays below 2 hundredths too slowly, so avoid rates above 50 fps. There is no second "FFmpeg GIF" entry: the app's own GIF is the one to use.

**Animated PNG** is full color with smooth transparency, lossless, and supported by current browsers. Larger than GIF for flat art, much better for gradients and soft edges. **Animated WebP and AVIF** need FFmpeg.

## Pictures and image sequences

The Output's Image format list is used for stills and for each frame of an image sequence.

| Format | Good for |
| --- | --- |
| **PNG**, **WebP**, **JPEG**, **AVIF** | the web. PNG is lossless with transparency; WebP and AVIF are small with transparency; JPEG has none. Quality applies to WebP, JPEG and AVIF. AVIF is offered only in browsers that can write it |
| **QOI** | fast lossless pixel art; small files for flat colors, few programs read it yet |
| **TIFF**, **TGA**, **BMP** | print, archive and game engines. TIFF and TGA keep transparency; BMP is 24-bit over black |
| **OpenEXR**, **Radiance HDR**, **TIFF 16-bit** | high dynamic range and compositing. EXR keeps transparency in half-float precision; HDR is RGBE without transparency; 16-bit TIFF keeps the picture as shown with 65,536 levels per channel |
| **ICO icon**, **PPM** | app icons (several sizes from one picture, hard pixel scaling by default) and the simplest format scripts can read |
| **DPX**, **JPEG 2000** | film and archive; need FFmpeg |

OpenEXR and Radiance HDR are written **linear**: the engine works in display (sRGB) encoding, so the curve is removed before the file is written, as compositing programs expect. They keep values above 1.0, but only a graph that produces such values (a bright glow, an exposure boost) has any; every other picture is 8-bit data in a bigger container. Formats without transparency (JPEG, BMP, PPM, HDR) place the picture over black.

## Sound files

The Audio Output's "Sound file" setting chooses the file made when it is exported on its own (a video gets its sound inside the video file). **WAV** (16-bit, 24-bit or 32-bit float), **AIFF** (16 or 24-bit) and **FLAC** (lossless, about half the size of WAV) are written by the app. **AAC** (M4A) and **Opus** (WebM) come from the browser where it can encode them. **MP3**, **Opus** and **Vorbis** (OGG) and **ALAC** need FFmpeg. If a format cannot be written, a 32-bit float WAV is written instead and the export notes say so.

## What to expect

Measured on a plain 1080p test clip (your content will differ): HAP compresses at about 1 ms per frame on the GPU, and the decoded frames agree with the originals at more than 40 dB (PSNR) on typical pictures. GIF and APNG of flat art are tens of kilobytes per second; of photographs, megabytes.

## Playing HAP clips

HAP is also read, not only written: import a HAP `.mov` like any other clip. It works in every version of the app; it is aimed at the desktop app, where the graphics card does all the work.

**How it plays.** A HAP frame is a compressed texture, not a coded picture, so it does not go through a video decoder. The app reads the frame from the file, undoes the optional Snappy compression (2 to 4 ms for a 1080p frame) and hands it to the graphics card. Every frame stands alone: scrubbing, looping, playing backwards and time effects cost the same as playing forwards, and many clips can play at once because nothing waits for one of the few hardware video decoders.

- When the graphics card reads BC ("S3TC") textures, which desktop cards on Windows, macOS and Linux do, the frame is uploaded as it is and one small draw makes the picture (HAP Q is converted from its brightness and colour-difference form in that draw).
- When it does not (most phones and tablets), the frame is decoded on the processor instead: the same picture, but about 25 to 45 ms per 1080p frame, so use smaller clips there.

**What is read.** HAP, HAP Alpha, HAP Q and HAP Q Alpha, plain, Snappy-compressed or chunked (FFmpeg's `-chunks`), with sound in the same file. HAP Alpha-Only is shown as a grey picture. HAP R (BC7) plays only through the graphics card and has no thumbnail. HAP HDR (BC6) is not read. Tested against files written by FFmpeg and by this app, by comparing with FFmpeg's own decode.

**Making HAP copies (desktop app).** The Fast copy section of Media In offers HAP, HAP Q and HAP Alpha next to H.264 when the app's FFmpeg can write HAP. Not every FFmpeg build can (it needs the `hap` encoder, which small "essentials" builds often leave out); the app asks its FFmpeg, and when the answer is no the choice is simply not shown. Locate a fuller build under Plugins, Official add-ons to get it. Choose HAP when several clips play at once, when a clip has transparency (HAP Alpha keeps it, the H.264 fast copy cannot) or when you have a desktop graphics card; HAP Q has cleaner colours. Sound is kept as uncompressed PCM. The files are large: about 30 MB a second at 1080p and 30 frames a second for HAP, twice that for HAP Q and HAP Alpha (Snappy usually makes them smaller). The copy is stored with your media like every imported clip, so a clip that would pass about 6 GB is refused with advice to choose a smaller size or trim it first. Sizes are rounded to multiples of 4 pixels, which HAP needs. To write a HAP file to disk instead, export with a HAP codec (above).

## Licences and names

All the encoders the app writes itself are original code written from published specifications. HAP is an open specification (BSD 2-Clause, Vidvox). The patents on LZW (GIF) and S3TC (the texture compression inside HAP) have expired. Format names are trademarks of their owners and are used only to say which file is written; the "-compatible" names (ProRes, DXV, DNxHR, CineForm) mean the file follows the format and was written by FFmpeg.
