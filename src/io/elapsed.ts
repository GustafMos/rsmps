/** "0:12", "12:05": the running time on the Stop button. In a file of its own so the phone page does not load the recorder for it. */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
