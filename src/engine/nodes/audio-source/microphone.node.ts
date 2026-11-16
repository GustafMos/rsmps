import { defineNode } from '../../define';
import { liveInputKernel } from '../../audio/live-input';

/**
 * Live microphone. Silent in exports (live sources render as silence).
 * Two outputs: "Audio" is what you hear when "Hear myself" is on; "Tap" is always live, so you can
 * drive effects or the audio-to-MIDI converter without the mic being audible (avoids feedback).
 */
export default defineNode({
  id: 'microphone',
  title: 'Microphone',
  category: 'audio-source',
  description: 'Live input from your microphone. Feed it to effects, or convert it to MIDI to play a synth.',
  keywords: ['mic', 'input', 'voice', 'record', 'live', 'sing'],
  inputs: {},
  outputs: {
    audio: { type: 'audio', label: 'Audio' },
    tap: { type: 'audio', label: 'Silent tap (always live)' },
  },
  params: {
    device: { type: 'device', device: 'audio-input', default: '', label: 'Microphone', hint: 'Leave on "System default" or pick one of your microphones. Each microphone node can use a different one.' },
    gain: { type: 'number', default: 0, min: -40, max: 40, step: 0.1, unit: 'db', label: 'Input gain' },
    monitor: { type: 'bool', default: false, label: 'Hear myself', hint: 'Off by default: with speakers, hearing yourself causes feedback. Use headphones.' },
    echoCancellation: { type: 'bool', default: false, label: 'Echo cancellation', group: 'Browser processing', hint: 'Off by default: browser processing damages singing and pitch tracking.' },
    noiseSuppression: { type: 'bool', default: false, label: 'Noise suppression', group: 'Browser processing' },
    autoGainControl: { type: 'bool', default: false, label: 'Automatic volume', group: 'Browser processing' },
    gate: { type: 'bool', default: false, label: 'Noise gate' },
    gateThreshold: { type: 'number', default: -50, min: -90, max: -10, step: 0.5, unit: 'db', label: 'Gate level', visibleIf: (p) => !!p.gate },
  },
  summary: (p) => `${p.gain >= 0 ? '+' : ''}${p.gain.toFixed(0)} dB${p.gate ? ' · gate' : ''}${p.monitor ? ' · monitor' : ''}`,
  audio: liveInputKernel,
});
