/** Export file naming. Pure. */

export interface NameTokens {
  /** Base name of the first media-in source (or the project name). */
  name: string;
  /** Batch item, 0-based. Printed 1-based. */
  index: number;
  count: number;
  width: number;
  height: number;
  /** 0-based frame number. */
  frame?: number;
  frameCount?: number;
}

const KNOWN_EXT = /\.(png|jpe?g|webp|mp4|webm|mov|json|zip|gif)$/i;

export function sanitizeFileName(s: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  return cleaned || 'output';
}

/** "photo.final.png" -> "photo.final" */
export function baseName(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  return i > 0 ? fileName.slice(0, i) : fileName;
}

export function pad(n: number, digits: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(digits, '0');
}

function digitsOf(n: number): number {
  return String(Math.max(1, Math.floor(n))).length;
}

/**
 * Replace {name} {index} {width} {height} {frame}. {index} is the 1-based item number padded to the
 * width of the batch size (min 2); {frame} is the 0-based frame number padded to the width of the frame
 * count (min 4). Unknown tokens become empty. The result is sanitised and has no file extension.
 */
export function resolvePattern(pattern: string, t: NameTokens): string {
  const src = (pattern && pattern.trim()) || '{name}';
  const out = src.replace(/\{(\w+)\}/g, (_m, key: string) => {
    switch (key.toLowerCase()) {
      case 'name':
        return baseName(t.name);
      case 'index':
        return pad(t.index + 1, Math.max(2, digitsOf(t.count)));
      case 'width':
        return String(t.width);
      case 'height':
        return String(t.height);
      case 'frame':
        return pad(t.frame ?? 0, Math.max(4, digitsOf(t.frameCount ?? 1)));
      default:
        return '';
    }
  });
  return sanitizeFileName(out.replace(KNOWN_EXT, ''));
}

/** Pattern for a sequence: guarantees every frame gets its own file name. */
export function sequencePattern(pattern: string): string {
  const src = (pattern && pattern.trim()) || '{name}';
  return /\{frame\}/i.test(src) ? src : `${src.replace(KNOWN_EXT, '')}_{frame}`;
}

/** Make `name` unique within `used` by inserting -2, -3... before the extension. Records the result. */
export function uniqueName(used: Set<string>, name: string): string {
  let candidate = name;
  if (used.has(candidate)) {
    const i = name.lastIndexOf('.');
    const stem = i > 0 ? name.slice(0, i) : name;
    const ext = i > 0 ? name.slice(i) : '';
    let n = 2;
    while (used.has(`${stem}-${n}${ext}`)) n++;
    candidate = `${stem}-${n}${ext}`;
  }
  used.add(candidate);
  return candidate;
}

export function imageExtension(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  return 'png';
}
