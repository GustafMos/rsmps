/**
 * Which encoders an installed FFmpeg has. FFmpeg builds differ (HAP needs libsnappy, DXV needs FFmpeg 7 or newer), so the app asks
 * `ffmpeg -hide_banner -encoders` instead of assuming. Pure parsing here; the probe itself lives in src/cli/encode.ts.
 */

/** Encoder names from the text `ffmpeg -encoders` prints (the legend above the `------` line is skipped). */
export function parseEncoderList(text: string): Set<string> {
  const out = new Set<string>();
  let body = !/^\s*-{3,}\s*$/m.test(text); // no separator: take every line that looks like an entry
  for (const line of text.split(/\r?\n/)) {
    if (!body) {
      if (/^\s*-{3,}\s*$/.test(line)) body = true;
      continue;
    }
    const m = /^\s*([VAS][.A-Z]{5})\s+(\S+)\s/.exec(line + ' ');
    if (m && m[2] !== '=') out.add(m[2]);
  }
  return out;
}

/** The wanted encoders (every encoder the codec table needs) that are present, as a sorted list: what the desktop app sends to the renderer. */
export function wantedPresent(all: ReadonlySet<string>, wanted: readonly string[]): string[] {
  return wanted.filter((e) => all.has(e)).sort();
}

/** Plain message for a codec whose encoder this FFmpeg lacks. */
export function missingEncoderMessage(label: string, encoder: string): string {
  return `${label} needs the "${encoder}" encoder, which this FFmpeg does not have. Pick another video codec, or install the FFmpeg add-on from Plugins, Official add-ons.`;
}
