/**
 * Machine-readable page format: fixed page furniture dimensions and the data-strip header
 * (see docs/PRINT_AND_SCAN.md). Pure.
 */

export type PaperId = 'a4' | 'a3' | 'letter' | 'a5' | 'legal';
/** Index in this list is the 3-bit paper code stored in the strip. */
export const PAPER_CODES: PaperId[] = ['a4', 'a3', 'letter', 'a5', 'legal'];
/** Portrait size in millimetres [width, height]. */
export const PAPER_MM: Record<PaperId, [number, number]> = {
  a4: [210, 297],
  a3: [297, 420],
  letter: [215.9, 279.4],
  a5: [148, 210],
  legal: [215.9, 355.6],
};

export type GuideMode = 'full' | 'faded' | 'outline' | 'blank';
export const GUIDE_CODES: GuideMode[] = ['full', 'faded', 'outline', 'blank'];

/* ---- page furniture (all in mm, measured from the page edges) ---- */
/** One finder-pattern module. The finder is 7x7 modules. */
export const FID_MODULE_MM = 1.4;
export const FID_MODULES = 7;
export const FID_SIZE_MM = FID_MODULE_MM * FID_MODULES;
/** Distance from the page edge to the finder's outer edge (clear of most printers' unprintable border). */
export const FID_INSET_MM = 7;
/** Finder centres sit at this distance from both adjacent page edges. */
export const FID_CENTER_MM = FID_INSET_MM + FID_SIZE_MM / 2;
/** Top and bottom bands reserved for finders, data strip and caption. */
export const BAND_MM = 20;
export const STRIP_MODULE_MM = 0.9;
/** Data-strip grid size including the timing row and column. */
export const STRIP_COLS = 41;
export const STRIP_ROWS = 9;
/** Data modules available (40 x 8). */
export const STRIP_BITS = (STRIP_COLS - 1) * (STRIP_ROWS - 1);

export const FORMAT_VERSION = 1;
/**
 * Version 2 is version 1 plus an extension block (layer, layer count, round, blue guide tone). It is written ONLY when
 * one of those is non-default, so every ordinary sheet is still a byte-identical version 1 sheet (readable by older
 * builds). Version 1 sheets keep decoding unchanged. The CRC sits after the payload of the version it announces.
 */
export const FORMAT_VERSION_LAYERS = 2;

/**
 * Everything the strip carries. Lengths are integers in units of 0.1 mm so encoder and decoder agree
 * exactly on the geometry.
 */
export interface SheetHeader {
  version: number;
  paper: PaperId;
  landscape: boolean;
  pageIndex: number;
  pageCount: number;
  columns: number;
  rows: number;
  cellW: number;
  cellH: number;
  pitchX: number;
  pitchY: number;
  gridX0: number;
  gridY0: number;
  firstFrame: number;
  totalFrames: number;
  fpsX100: number;
  frameW: number;
  frameH: number;
  guide: GuideMode;
  /** 0..100: percent of ink the printed guide keeps (faded mode). */
  guideOpacity: number;
  projectId: number;
  /** Version 2 only (absent = 0 / 1 / 0 / false): paper layer number, layers in the set, onion-skin round, blue guide tone. */
  layer?: number;
  layerCount?: number;
  round?: number;
  blueGuide?: boolean;
}

/** Version 2 extension fields [field, bits], transmitted after the version 1 fields. */
const EXT_FIELDS: [keyof SheetHeader, number][] = [
  ['layer', 6],
  ['layerCount', 6],
  ['round', 6],
  ['blueGuide', 1],
];

/** [field, bits] in transmission order. */
const FIELDS: [keyof SheetHeader, number][] = [
  ['version', 4],
  ['paper', 3],
  ['landscape', 1],
  ['pageIndex', 12],
  ['pageCount', 12],
  ['columns', 6],
  ['rows', 6],
  ['cellW', 14],
  ['cellH', 14],
  ['pitchX', 14],
  ['pitchY', 14],
  ['gridX0', 14],
  ['gridY0', 14],
  ['firstFrame', 16],
  ['totalFrames', 16],
  ['fpsX100', 14],
  ['frameW', 14],
  ['frameH', 14],
  ['guide', 2],
  ['guideOpacity', 7],
  ['projectId', 32],
];

export const HEADER_PAYLOAD_BYTES = Math.ceil(FIELDS.reduce((s, f) => s + f[1], 0) / 8);
export const HEADER_PAYLOAD_BYTES_V2 = Math.ceil((FIELDS.reduce((s, f) => s + f[1], 0) + EXT_FIELDS.reduce((s, f) => s + f[1], 0)) / 8);
/** Bytes in the strip: payload, CRC-16, zero padding up to capacity. */
export const STRIP_BYTES = STRIP_BITS / 8;

export function crc16(bytes: ArrayLike<number>, length = bytes.length): number {
  let crc = 0xffff;
  for (let i = 0; i < length; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function numeric(h: SheetHeader, key: keyof SheetHeader): number {
  const v = h[key];
  if (key === 'paper') return Math.max(0, PAPER_CODES.indexOf(v as PaperId));
  if (key === 'guide') return Math.max(0, GUIDE_CODES.indexOf(v as GuideMode));
  if (key === 'landscape' || key === 'blueGuide') return v ? 1 : 0;
  if (key === 'layerCount') return (v as number | undefined) ?? 1;
  return (v as number | undefined) ?? 0;
}

/** True when the header needs the version 2 extension block. */
export function needsExtension(h: SheetHeader): boolean {
  return (h.layer ?? 0) > 0 || (h.layerCount ?? 1) > 1 || (h.round ?? 0) > 0 || !!h.blueGuide;
}

/** Serialise a header into STRIP_BYTES bytes (payload + CRC-16 + padding). Throws on out-of-range fields. */
export function encodeHeader(h: SheetHeader): Uint8Array {
  const out = new Uint8Array(STRIP_BYTES);
  const ext = needsExtension(h);
  const fields = ext ? [...FIELDS, ...EXT_FIELDS] : FIELDS;
  const payload = ext ? HEADER_PAYLOAD_BYTES_V2 : HEADER_PAYLOAD_BYTES;
  let bit = 0;
  for (const [key, bits] of fields) {
    const value = key === 'version' ? (ext ? FORMAT_VERSION_LAYERS : FORMAT_VERSION) : Math.round(numeric(h, key));
    if (!(value >= 0) || value >= 2 ** bits) throw new Error(`Print header field "${key}" is out of range (${value}, ${bits} bits).`);
    for (let b = bits - 1; b >= 0; b--) {
      const v = Math.floor(value / 2 ** b) % 2;
      if (v) out[bit >> 3] |= 0x80 >> (bit & 7);
      bit++;
    }
  }
  const crc = crc16(out, payload);
  out[payload] = crc >> 8;
  out[payload + 1] = crc & 0xff;
  return out;
}

/** Parse strip bytes (version 1 or 2). Returns null when the CRC or any field is invalid. */
export function decodeHeader(bytes: ArrayLike<number>): SheetHeader | null {
  if (bytes.length < HEADER_PAYLOAD_BYTES + 2) return null;
  const version = (bytes[0] >> 4) & 15;
  const ext = version === FORMAT_VERSION_LAYERS;
  if (version !== FORMAT_VERSION && !ext) return null;
  const payload = ext ? HEADER_PAYLOAD_BYTES_V2 : HEADER_PAYLOAD_BYTES;
  if (bytes.length < payload + 2) return null;
  const crc = (bytes[payload] << 8) | bytes[payload + 1];
  if (crc16(bytes, payload) !== crc) return null;
  const vals: Record<string, number> = {};
  let bit = 0;
  for (const [key, bits] of ext ? [...FIELDS, ...EXT_FIELDS] : FIELDS) {
    let v = 0;
    for (let b = 0; b < bits; b++) {
      v = v * 2 + ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
      bit++;
    }
    vals[key] = v;
  }
  if (vals.paper >= PAPER_CODES.length) return null;
  if (vals.columns < 1 || vals.rows < 1 || vals.cellW < 1 || vals.cellH < 1 || vals.pageCount < 1 || vals.pageIndex >= vals.pageCount) return null;
  if (ext && (vals.layerCount < 1 || vals.layer >= vals.layerCount)) return null;
  const h: SheetHeader = {
    version: vals.version,
    paper: PAPER_CODES[vals.paper],
    landscape: vals.landscape === 1,
    pageIndex: vals.pageIndex,
    pageCount: vals.pageCount,
    columns: vals.columns,
    rows: vals.rows,
    cellW: vals.cellW,
    cellH: vals.cellH,
    pitchX: vals.pitchX,
    pitchY: vals.pitchY,
    gridX0: vals.gridX0,
    gridY0: vals.gridY0,
    firstFrame: vals.firstFrame,
    totalFrames: vals.totalFrames,
    fpsX100: vals.fpsX100,
    frameW: vals.frameW,
    frameH: vals.frameH,
    guide: GUIDE_CODES[vals.guide],
    guideOpacity: vals.guideOpacity,
    projectId: vals.projectId,
  };
  if (ext) {
    h.layer = vals.layer;
    h.layerCount = vals.layerCount;
    h.round = vals.round;
    h.blueGuide = vals.blueGuide === 1;
  }
  return h;
}

/**
 * The strip as a module matrix (1 = black), row-major STRIP_ROWS x STRIP_COLS. Row 0 and column 0 are the
 * timing pattern (black on even indices, starting black at the corner); data bits fill the rest row by row,
 * most significant bit first.
 */
export function stripModules(bytes: Uint8Array): Uint8Array {
  const grid = new Uint8Array(STRIP_COLS * STRIP_ROWS);
  for (let c = 0; c < STRIP_COLS; c++) grid[c] = c % 2 === 0 ? 1 : 0;
  for (let r = 0; r < STRIP_ROWS; r++) grid[r * STRIP_COLS] = r % 2 === 0 ? 1 : 0;
  let bit = 0;
  for (let r = 1; r < STRIP_ROWS; r++) {
    for (let c = 1; c < STRIP_COLS; c++) {
      grid[r * STRIP_COLS + c] = (bytes[bit >> 3] >> (7 - (bit & 7))) & 1;
      bit++;
    }
  }
  return grid;
}

/** Inverse of `stripModules` for already-thresholded modules. */
export function stripBytes(grid: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(STRIP_BYTES);
  let bit = 0;
  for (let r = 1; r < STRIP_ROWS; r++) {
    for (let c = 1; c < STRIP_COLS; c++) {
      if (grid[r * STRIP_COLS + c]) out[bit >> 3] |= 0x80 >> (bit & 7);
      bit++;
    }
  }
  return out;
}

/** Page size in mm for a paper id and orientation. */
export function pageSizeMm(paper: PaperId, landscape: boolean): { width: number; height: number } {
  const [w, h] = PAPER_MM[paper];
  return landscape ? { width: h, height: w } : { width: w, height: h };
}

/** Finder centres in page mm, in page order tl, tr, br, bl. */
export function finderCentersMm(width: number, height: number): { x: number; y: number }[] {
  const c = FID_CENTER_MM;
  return [
    { x: c, y: c },
    { x: width - c, y: c },
    { x: width - c, y: height - c },
    { x: c, y: height - c },
  ];
}

/** Top-left corner of the strip in page mm. The strip is centred between the two top finders. */
export function stripOriginMm(width: number): { x: number; y: number } {
  return { x: width / 2 - (STRIP_COLS * STRIP_MODULE_MM) / 2, y: FID_CENTER_MM - (STRIP_ROWS * STRIP_MODULE_MM) / 2 };
}

/** Project ids are shown as 8 upper-case hex digits. */
export function formatProjectId(id: number): string {
  return (id >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

/** Stable 32-bit id from a string (FNV-1a). */
export function projectIdFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
