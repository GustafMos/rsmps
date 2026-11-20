/**
 * The optional AI models RSMPS can use. DATA ONLY: nothing here is fetched, and nothing is ever downloaded unless the user presses
 * Download (src/io/models.ts). Models are never bundled with the app.
 *
 * Every entry pins ONE exact file: the URL contains a commit hash of the upstream repository (so the bytes cannot change under us),
 * and `bytes` + `sha256` are checked over the whole file after the download. A file that does not match is refused and nothing is stored.
 *
 * Only models whose licence allows use in a free tool belong here. Depth Anything V2 Small is Apache-2.0. The larger Depth Anything V2
 * models (Base, Large, Giant) are CC-BY-NC (non-commercial) and are deliberately not offered.
 *
 * AdaIN style transfer is two files (an encoder and a decoder) and therefore two entries; the AI Style Transfer node needs both.
 * The weights are the MIT-licensed ones of naoto0804/pytorch-AdaIN, exported to ONNX by axinc-ai/ailia-models and re-hosted on
 * Hugging Face (the repository's README states source and licence per file). The encoder is the first layers of VGG-19, whose original
 * weights the Visual Geometry Group published under CC BY 4.0, hence the extra credit in its attribution line.
 */

import { DEPTH_AI_MODEL } from '../engine/lib/depth-ai-bridge';
import { STYLE_AI_MODEL } from '../engine/lib/style-ai-bridge';

export interface ModelEntry {
  /** Stable id, also the storage key. */
  id: string;
  title: string;
  /** One sentence for the add-ons list. */
  summary: string;
  /** The exact file to download (pinned revision). */
  url: string;
  /** Upstream repository revision the URL points at. */
  revision: string;
  /** File name inside the repository. */
  file: string;
  /** Exact size in bytes. */
  bytes: number;
  /** SHA-256 of the whole file, lower-case hex. */
  sha256: string;
  /** Shown to the user before the download. */
  sizeLabel: string;
  host: string;
  license: { name: string; url: string };
  /** Credit line shown next to the model and in the third-party notices. */
  attribution: string;
  /** Where the model comes from (the page a user can read). */
  sourceUrl: string;
  /** The upstream authors' page. */
  homepage: string;
  /** Model input: a multiple of this, any size (the export has dynamic axes). */
  inputMultiple: number;
  /** ImageNet statistics the picture is normalised with (from the export's preprocessor_config.json). */
  mean: [number, number, number];
  std: [number, number, number];
}

export const DEPTH_ANYTHING_V2_SMALL_ID = DEPTH_AI_MODEL.id;

export const MODEL_CATALOGUE: readonly ModelEntry[] = [
  {
    id: DEPTH_ANYTHING_V2_SMALL_ID,
    title: 'Depth Anything V2 Small',
    summary: 'Estimates a depth map from a single picture. Used by the AI Depth node.',
    revision: DEPTH_AI_MODEL.revision,
    file: 'onnx/model_fp16.onnx',
    url: `https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/${DEPTH_AI_MODEL.revision}/onnx/model_fp16.onnx`,
    bytes: 49642442,
    sha256: '2df6223f206b5164e21f664ace61dabeb9bb6a49b8b5a3e00510b4807d0f5b04',
    sizeLabel: '50 MB',
    host: 'huggingface.co',
    license: { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
    attribution: 'Depth Anything V2 Small © the Depth Anything authors, Apache-2.0',
    sourceUrl: 'https://huggingface.co/onnx-community/depth-anything-v2-small',
    homepage: 'https://huggingface.co/depth-anything/Depth-Anything-V2-Small',
    inputMultiple: 14,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
  },
  {
    id: STYLE_AI_MODEL.encoder,
    title: 'AdaIN style transfer, encoder',
    summary: 'Reads a picture into the features its style is measured on. Used by the AI Style Transfer node, together with the decoder.',
    revision: STYLE_AI_MODEL.revision,
    file: 'adain-vgg.onnx',
    url: `https://huggingface.co/Bildaro/lintabsort-aidan/resolve/${STYLE_AI_MODEL.revision}/adain-vgg.onnx`,
    bytes: 14025860,
    sha256: 'ac62bbef78a38bd952364c6db91048ab9703ebc7ee45ebb06e6438e5f5da4de4',
    sizeLabel: '14 MB',
    host: 'huggingface.co',
    license: { name: 'MIT', url: 'https://github.com/naoto0804/pytorch-AdaIN/blob/master/LICENSE' },
    attribution: 'AdaIN style transfer (Huang and Belongie 2017), weights © Naoto Inoue, MIT; encoder from VGG-19 © Visual Geometry Group, University of Oxford, CC BY 4.0',
    sourceUrl: 'https://huggingface.co/Bildaro/lintabsort-aidan',
    homepage: 'https://github.com/naoto0804/pytorch-AdaIN',
    // The picture is given as it is (0..1): the export has VGG's own colour correction built in. One feature cell is 8 pixels.
    inputMultiple: STYLE_AI_MODEL.stride,
    mean: [0, 0, 0],
    std: [1, 1, 1],
  },
  {
    id: STYLE_AI_MODEL.decoder,
    title: 'AdaIN style transfer, decoder',
    summary: 'Paints a picture from restyled features. Used by the AI Style Transfer node, together with the encoder.',
    revision: STYLE_AI_MODEL.revision,
    file: 'adain-decoder.onnx',
    url: `https://huggingface.co/Bildaro/lintabsort-aidan/resolve/${STYLE_AI_MODEL.revision}/adain-decoder.onnx`,
    bytes: 14026124,
    sha256: 'a549863dfcf18f747d615794cb58a663d2fc829fa36c3fef18355c1e7f4843db',
    sizeLabel: '14 MB',
    host: 'huggingface.co',
    license: { name: 'MIT', url: 'https://github.com/naoto0804/pytorch-AdaIN/blob/master/LICENSE' },
    attribution: 'AdaIN style transfer (Huang and Belongie 2017), weights © Naoto Inoue, MIT',
    sourceUrl: 'https://huggingface.co/Bildaro/lintabsort-aidan',
    homepage: 'https://github.com/naoto0804/pytorch-AdaIN',
    inputMultiple: STYLE_AI_MODEL.stride,
    mean: [0, 0, 0],
    std: [1, 1, 1],
  },
];

/** Both files of the style transfer model, in download order. */
export const STYLE_AI_MODEL_IDS: readonly string[] = [STYLE_AI_MODEL.encoder, STYLE_AI_MODEL.decoder];

export function modelEntry(id: string): ModelEntry | null {
  return MODEL_CATALOGUE.find((m) => m.id === id) ?? null;
}
