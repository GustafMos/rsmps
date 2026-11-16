// Stands in for src/cli/ffmpeg.ts inside the desktop bundle (see desktop/scripts/bundle-modules.mjs): the encoder code in
// src/cli/encode.ts asks `requireFfmpeg()` for a binary; in the desktop app that is the add-on / located FFmpeg.
let binary = null;
export function setFfmpegBinary(path) {
  binary = path;
}
export async function requireFfmpeg() {
  if (!binary) throw new Error('FFmpeg is not set up. Install the FFmpeg add-on or locate an existing FFmpeg.');
  return binary;
}
export async function findFfmpeg() {
  return binary;
}
