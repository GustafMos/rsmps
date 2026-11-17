/**
 * The optional AI models RSMPS can use. DATA ONLY: nothing here is fetched, and nothing is ever downloaded unless the user presses
 * Download (src/io/models.ts). Models are never bundled with the app.
 *
 * Every entry pins ONE exact file: the URL contains a commit hash of the upstream repository (so the bytes cannot change under us),
 * and `bytes` + `sha256` are checked over the whole file after the download. A file that does not match is refused and nothing is stored.
 *
 * Only models whose licence allows use in a free tool belong here. Depth Anything V2 Small is Apache-2.0. The larger Depth Anything V2
 * models (Base, Large, Giant) are CC-BY-NC (non-commercial) and are deliberately not offered.
 */

import { DEPTH_AI_MODEL } from '../engine/lib/depth-ai-bridge';

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
];

export function modelEntry(id: string): ModelEntry | null {
  return MODEL_CATALOGUE.find((m) => m.id === id) ?? null;
}
