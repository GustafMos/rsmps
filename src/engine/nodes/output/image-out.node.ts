import { defineNode } from '../../define';

/**
 * Sink. Output nodes do no processing: the exporter asks the engine for what arrives
 * on `image` and encodes it according to these params (see src/io).
 */
export default defineNode({
  id: 'image-out',
  title: 'Output',
  category: 'output',
  description: 'Export target: image, image sequence, video or spritesheet. Several outputs export several variants.',
  keywords: ['export', 'render', 'save', 'png', 'video', 'spritesheet'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: {},
  params: {
    name: { type: 'string', default: '{name}', label: 'File name', hint: 'Tokens: {name} {index} {width} {height} {frame}' },
    kind: {
      type: 'enum',
      default: 'auto',
      options: [
        { value: 'auto', label: 'Auto (image or video)' },
        { value: 'image', label: 'Still image' },
        { value: 'sequence', label: 'Image sequence' },
        { value: 'video', label: 'Video' },
        { value: 'spritesheet', label: 'Spritesheet' },
        { value: 'print', label: 'Print sheets (PDF, scan back later)' },
      ],
      label: 'Export as',
    },
    imageFormat: {
      type: 'enum',
      default: 'png',
      options: [
        { value: 'png', label: 'PNG' },
        { value: 'webp', label: 'WebP' },
        { value: 'jpeg', label: 'JPEG' },
      ],
      label: 'Image format',
    },
    quality: { type: 'number', default: 0.92, min: 0.1, max: 1, step: 0.01, label: 'Quality', visibleIf: (p) => p.imageFormat !== 'png' },
    codec: {
      type: 'enum',
      default: 'avc',
      options: [
        { value: 'avc', label: 'H.264 (MP4)' },
        { value: 'hevc', label: 'H.265 (MP4)' },
        { value: 'vp9', label: 'VP9 (WebM)' },
        { value: 'av1', label: 'AV1 (MP4)' },
      ],
      label: 'Video codec',
      group: 'Video',
    },
    bitrate: { type: 'number', default: 12, min: 0.5, max: 200, step: 0.5, label: 'Bitrate (Mbps)', group: 'Video' },
    scale: { type: 'number', default: 1, min: 1, max: 16, integer: true, label: 'Pixel upscale ×', hint: 'Nearest-neighbour enlargement for pixel art.' },
    columns: { type: 'number', default: 0, min: 0, max: 64, integer: true, label: 'Sheet columns (0 = auto)', group: 'Spritesheet' },
    padding: { type: 'number', default: 0, min: 0, max: 64, integer: true, label: 'Sheet padding', group: 'Spritesheet' },
    printPaper: {
      type: 'enum',
      default: 'a4',
      options: [
        { value: 'a4', label: 'A4' },
        { value: 'a3', label: 'A3' },
        { value: 'letter', label: 'Letter' },
        { value: 'a5', label: 'A5' },
        { value: 'legal', label: 'Legal' },
      ],
      label: 'Paper',
      group: 'Print',
    },
    printOrientation: {
      type: 'enum',
      default: 'portrait',
      options: [
        { value: 'portrait', label: 'Portrait' },
        { value: 'landscape', label: 'Landscape' },
      ],
      label: 'Orientation',
      group: 'Print',
    },
    printDpi: { type: 'number', default: 300, min: 72, max: 600, step: 1, integer: true, label: 'Resolution (DPI)', group: 'Print' },
    printColumns: { type: 'number', default: 3, min: 0, max: 63, integer: true, label: 'Frames across (0 = auto)', group: 'Print' },
    printRows: { type: 'number', default: 4, min: 0, max: 63, integer: true, label: 'Frames down (0 = auto)', group: 'Print' },
    printFrameWidth: {
      type: 'number',
      default: 50,
      min: 8,
      max: 400,
      label: 'Frame width (mm)',
      hint: 'Used when both across and down are 0.',
      group: 'Print',
      visibleIf: (p) => !p.printColumns && !p.printRows,
    },
    printMargin: { type: 'number', default: 10, min: 5, max: 40, step: 0.5, label: 'Margin (mm)', group: 'Print' },
    printGutter: { type: 'number', default: 5, min: 3, max: 20, step: 0.5, label: 'Gutter (mm)', hint: 'Gap between frames; the + registration marks live here.', group: 'Print' },
    printGuide: {
      type: 'enum',
      default: 'full',
      options: [
        { value: 'full', label: 'Full frames' },
        { value: 'faded', label: 'Faded (draw over)' },
        { value: 'outline', label: 'Outlines only' },
        { value: 'blank', label: 'Blank frames, marks only' },
      ],
      label: 'Frame guide',
      group: 'Print',
    },
    printGuideOpacity: { type: 'number', default: 35, min: 5, max: 100, integer: true, unit: '%', label: 'Guide strength', group: 'Print', visibleIf: (p) => p.printGuide === 'faded' },
    printOutput: {
      type: 'enum',
      default: 'pdf',
      options: [
        { value: 'pdf', label: 'PDF' },
        { value: 'png', label: 'PNG pages' },
        { value: 'both', label: 'PDF and PNG pages' },
      ],
      label: 'Output',
      group: 'Print',
    },
    step: { type: 'number', default: 1, min: 1, max: 64, integer: true, label: 'Every Nth frame', group: 'Print' },
  },
  summary: (p) => (p.kind === 'auto' ? 'auto' : p.kind),
  render() {
    return {};
  },
});
