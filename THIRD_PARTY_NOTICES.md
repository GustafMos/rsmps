# Third-party notices

PixelArtify Studio's own source is MIT licensed (see `LICENSE`). The project depends on the following packages and external programs. Their licenses apply to their respective code and binaries.

## Runtime dependencies

| Package | Version | License | Project |
| --- | --- | --- | --- |
| mediabunny | ^1.65.2 | MPL-2.0 | <https://github.com/Vanilagy/mediabunny> |
| react | ^19.1.0 | MIT | <https://github.com/facebook/react> |
| react-dom | ^19.1.0 | MIT | <https://github.com/facebook/react> |
| fflate | ^0.8.2 | MIT | <https://github.com/101arrowz/fflate> |
| sharp | ^0.35.5 | Apache-2.0 | <https://github.com/lovell/sharp> |
| onnxruntime-web | 1.31.1 | MIT | <https://github.com/microsoft/onnxruntime> |
| @dimforge/rapier3d-deterministic-compat | ^0.21.0 | Apache-2.0 | <https://github.com/dimforge/rapier.js> |

`sharp` bundles libvips, which is LGPL-2.1-or-later. See the sharp and libvips distributions for their notices and source links.

### Mediabunny (MPL-2.0)

Mediabunny is used unmodified as a dependency. Its source is available at the link above. MPL-2.0 is file-level copyleft: it does not relicense PixelArtify Studio's own files. If you modify Mediabunny files and distribute them, you must make those modified files available under MPL-2.0.

### ONNX Runtime Web (MIT)

ONNX Runtime Web runs the optional AI Depth model. Its JavaScript and WebAssembly files are copied unmodified into the build under `ort/` and are loaded only when AI Depth is used.

```
MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Optional AI models (not included, downloaded only on request)

| Model | License | Source |
| --- | --- | --- |
| Depth Anything V2 Small (ONNX export by onnx-community, pinned revision `4472b7362082ad9968fee890ca0f1e5aca36b93d`) | Apache-2.0 | <https://huggingface.co/onnx-community/depth-anything-v2-small> |
| AdaIN style transfer, encoder and decoder (`adain-vgg.onnx`, `adain-decoder.onnx`; weights of naoto0804/pytorch-AdaIN, ONNX export by axinc-ai/ailia-models, pinned revision `ca79d77e034b14bb99a4b2a6e3670c70cbcfb679`) | MIT | <https://huggingface.co/Bildaro/lintabsort-aidan> |

Depth Anything V2 Small © the Depth Anything authors, Apache-2.0 (<https://huggingface.co/depth-anything/Depth-Anything-V2-Small>). The model file is not part of RSMPS, is never bundled and is never downloaded unless you press Download in Plugins > AI models. It runs on your own computer and nothing is uploaded. The larger Depth Anything V2 models (Base, Large, Giant) are licensed CC-BY-NC and are deliberately not offered.

AdaIN style transfer (Xun Huang and Serge Belongie, "Arbitrary Style Transfer in Real-time with Adaptive Instance Normalization", 2017): weights © 2018 Naoto Inoue, MIT (<https://github.com/naoto0804/pytorch-AdaIN>). The encoder is the first layers of VGG-19 © Visual Geometry Group, University of Oxford, whose original weights were published under CC BY 4.0. Used by the AI Style Transfer node; the two files are not part of RSMPS, are never bundled and are never downloaded unless you press Download (in the node's panel or in Plugins > AI models).

## Optional add-on programs for Splat from Video (desktop app)

| Program | Version | License | Project |
| --- | --- | --- | --- |
| COLMAP (Windows no-CUDA, Windows CUDA, macOS arm64 builds) | 4.2.1 | BSD-3-Clause; the release archives also contain third-party libraries under their own licences (Qt LGPL-3.0, Boost, Ceres, OpenImageIO, ONNX Runtime; NVIDIA CUDA runtime in the CUDA build) | <https://colmap.github.io/license.html> |
| Brush | 0.3.0 | Apache-2.0 | <https://github.com/ArthurBrussee/brush> |

Neither program is part of RSMPS or bundled with it. They are downloaded from their GitHub releases only when the user presses Install in Plugins > Official add-ons (pinned URL, size and SHA-256; the licence is shown first), or the user locates a copy they already have. They run as **separate executables** started with argument arrays (`child_process.spawn`, no shell); nothing is linked into RSMPS's MIT code. Not used, for licence reasons: the INRIA 3DGS reference code (non-commercial), OpenSplat (AGPL), gsplat (needs Python / PyTorch), VGGT / MASt3R (gated or non-commercial weights).

## Optional dependency (CLI video)

| Package | Version | License | Project |
| --- | --- | --- | --- |
| @ffmpeg-installer/ffmpeg | ^1.1.0 | LGPL-2.1 (wrapper) | <https://github.com/kribblo/node-ffmpeg-installer> |
| @ffmpeg-installer/win32-x64 | platform binary | GPLv3 | <https://ffmpeg.org/> |
| @ffmpeg-installer/darwin-x64 / linux-x64 etc. | platform binary | see package | <https://ffmpeg.org/> |

The optional ffmpeg binary is a **separate executable** invoked via `child_process.spawn`; it is not linked into or combined with PixelArtify Studio's MIT code. Some platform builds (including the Windows build) are GPLv3. If you redistribute a package that includes these binaries, comply with the GPL: include the license text and provide the corresponding source, or remove the optional dependency and use a system ffmpeg (`FFMPEG_PATH`).

The browser studio does **not** require ffmpeg; it uses WebCodecs through Mediabunny.

## Development dependencies

| Package | License |
| --- | --- |
| @types/node | MIT |
| @types/react | MIT |
| @types/react-dom | MIT |
| @vitejs/plugin-react | MIT |
| tsx | MIT |
| typescript | Apache-2.0 |
| vite | MIT |
| vitest | MIT |
| esbuild | MIT |

## Runtime environment

- Node.js is licensed under the MIT license and additional notices.
- Chromium/Firefox/Safari provide the WebCodecs, Canvas and Web Audio APIs used by the studio.

## Attribution in the app

The About dialog in PixelArtify Studio and `CREDITS.md` link to the principal inspirations: pixel-mosaic, Ditherista/libdither, Mediabunny, OKLab and the dithering/colour-science literature.

If you believe something is missing or incorrectly attributed, please open an issue.
