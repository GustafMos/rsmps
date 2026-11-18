import { defineNode } from '../../define';

/**
 * Records what flows through it, live, into a clip in Media: the picture wired into it, with the sound that is playing.
 *
 * The node itself only passes its picture on, so it can sit anywhere in a chain (record the raw camera AND the finished look with
 * two of them). The recording is made by the app (src/ui/store/recorder.ts): the Record button in the inspector shows this node
 * in the viewer, starts playback and records what the viewer shows together with the sound mix. Exports are not affected.
 *
 * `time` decides what the clock does while recording:
 *  - loop: the project plays as usual, repeating at its length;
 *  - run: time runs on past the project length until Stop (the player's "run on" mode, Loop off): motion that follows the clock
 *    keeps going and stepped randomness keeps finding new values instead of repeating every loop.
 */
export default defineNode({
  id: 'recorder',
  title: 'Recorder',
  category: 'time',
  description: 'Records the picture wired into it, live, with the sound that is playing, into a clip in Media. Passes the picture on unchanged, so it can sit anywhere in a chain. Press Record in its settings.',
  keywords: ['record', 'capture', 'live', 'take', 'performance', 'jam', 'screen record', 'save clip', 'recorder output', 'endless', 'run on'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    time: {
      type: 'enum',
      default: 'run',
      label: 'While recording',
      options: [
        { value: 'run', label: 'Time runs on' },
        { value: 'loop', label: 'Loop the project' },
      ],
      hint: 'Time runs on: the clock keeps going until you stop, so effects keep changing instead of repeating every loop (the project plays with Loop off; movements that are a cycle by nature, like a spin, still come round). Loop the project: plays as usual, repeating at the project length.',
    },
    sound: { type: 'bool', default: true, label: 'Record sound', hint: 'Include the sound that is playing (what the Audio Output plays). Needs audio to be on: Enable audio.' },
    size: {
      type: 'enum',
      default: '1920',
      label: 'Clip size',
      options: [
        { value: '1280', label: 'Up to 1280 px' },
        { value: '1920', label: 'Up to 1920 px' },
        { value: '3840', label: 'Up to 3840 px' },
      ],
      hint: 'Longest side of the clip. The recording is what the viewer shows, so a low preview scale gives a soft clip: raise it for a sharp one.',
    },
  },
  summary: (p) => `${p.time === 'run' ? 'time runs on' : 'loops'}${p.sound ? ' · with sound' : ''}`,
  render(ctx) {
    return { image: ctx.in.image };
  },
});
