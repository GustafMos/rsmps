import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { dbToLin } from '../../audio/dsp';

/**
 * Plays an audio file (or the sound track of a video) in step with the transport.
 * Position in the file = transport time + "skip". Silent while paused.
 */
export default defineNode({
  id: 'audio-file',
  title: 'Audio File',
  category: 'audio-source',
  description: 'Plays a sound file, or the sound of a video, in time with the playhead.',
  keywords: ['music', 'wav', 'mp3', 'sample', 'track', 'video sound', 'soundtrack'],
  inputs: {},
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    assets: { type: 'assets', default: [], accept: 'audio', label: 'Sound file' },
    gain: { type: 'number', default: 0, min: -60, max: 24, step: 0.1, unit: 'db', label: 'Volume' },
    loop: { type: 'bool', default: false, label: 'Repeat the file' },
    startOffset: { type: 'number', default: 0, min: 0, max: 3600, step: 0.01, unit: 's', label: 'Skip into file', hint: 'Start playing this far into the file when the playhead is at zero.' },
  },
  summary: (p) => (p.assets.length ? `${p.assets[0]}${p.loop ? ' · repeat' : ''}` : 'no file'),
  audio: defineAudio({
    create: () => ({ g: 1, expected: -1, fade: 0 }),
    process(st, io) {
      const ids = io.params.assets as string[];
      const asset = ids.length ? io.assets.get(ids[0]) : undefined;
      const n = io.frames;
      if (!asset || !io.time.playing || asset.frames === 0) {
        st.expected = -1;
        return;
      }
      const [ol, or] = io.out.audio;
      const sr = asset.sampleRate;
      const skip = Math.round(io.params.startOffset * sr);
      const len = asset.frames - skip;
      if (len <= 0) return;
      let pos = skip + io.time.sample;
      if (io.params.loop) pos = skip + (io.time.sample % len);
      if (io.time.sample !== st.expected) st.fade = 64;
      const target = dbToLin(io.params.gain);
      const g0 = st.g;
      for (let i = 0; i < n; i++) {
        let p = pos + i;
        if (io.params.loop) p = skip + ((p - skip) % len);
        if (p >= asset.frames) continue;
        const g = (g0 + ((target - g0) * (i + 1)) / n) * (st.fade > 0 ? 1 - st.fade-- / 64 : 1);
        ol[i] = asset.left[p] * g;
        or[i] = asset.right[p] * g;
      }
      st.g = target;
      st.expected = io.time.sample + n;
    },
  }),
});
