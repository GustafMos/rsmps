// src/cli/encode.ts imports sharp for still images; the desktop bundle only uses its video encoder, so sharp is stubbed out.
export default function sharp() {
  throw new Error('sharp is not available in the desktop app');
}
