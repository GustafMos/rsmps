import type { TextSpec } from '../engine/types';

/** Break `text` into lines: honours \n and wraps at spaces (or inside a word that is too long) to `maxWidth` (0 = no wrap). */
export function wrapLines(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    if (maxWidth <= 0) {
      out.push(paragraph);
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/(\s+)/)) {
      if (word === '') continue;
      const candidate = line + word;
      if (measure(candidate) <= maxWidth || line === '') {
        line = candidate;
        // A single word wider than the box: split by characters.
        while (measure(line) > maxWidth && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && measure(line.slice(0, cut)) > maxWidth) cut--;
          out.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      } else {
        out.push(line.trimEnd());
        line = word.trimStart();
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

export function cssFont(spec: Pick<TextSpec, 'font' | 'sizePx' | 'weight' | 'italic'>): string {
  return `${spec.italic ? 'italic ' : ''}${Math.round(spec.weight) || 400} ${Math.max(1, spec.sizePx)}px ${spec.font || 'sans-serif'}`;
}
