/**
 * The live-performance helpers of the app in one place per `Io`: MIDI learn, the output window and the small UI state that opens their menus.
 */
import type { Io } from '../../io/api';
import type { Editor } from './editor';
import { createStore, type Store } from './createStore';
import { MidiController } from './midi';
import { OutputController } from './output';
import { REACT_FEATURES, reactPatch, reactionOf, soundSources, stopReacting, type ReactFeature, type SoundSource } from './react';

export interface LiveUi {
  /** Where the output window menu is open (viewer button), or null. */
  outputMenu: { x: number; y: number } | null;
  /** A right-clicked setting: shows the context menu. */
  paramMenu: { x: number; y: number; node: string; param: string } | null;
  /** Several sounds in the project: ask which one the music is. */
  soundChooser: { node: string; param: string; feature: ReactFeature; sources: SoundSource[] } | null;
}

export class Live {
  readonly midi: MidiController;
  readonly output: OutputController;
  readonly ui: Store<LiveUi> = createStore<LiveUi>({ outputMenu: null, paramMenu: null, soundChooser: null });

  constructor(
    readonly ed: Editor,
    readonly io: Io,
  ) {
    this.midi = new MidiController(ed, io);
    this.output = new OutputController((m, k) => ed.toast(m, k));
  }

  /** "React to sound" on a number setting: one undo step. Asks which sound when the project has several. */
  react(node: string, param: string, feature: ReactFeature, source?: SoundSource): void {
    const sources = soundSources(this.ed.state.level, this.io.registry);
    if (!sources.length) return this.ed.toast('There is no sound in this project yet. Add a Media In with sound, an Audio File or a Microphone.', 'info');
    const chosen = source ?? (sources.length === 1 ? sources[0] : undefined);
    if (!chosen) {
      this.ui.set((s) => ({ ...s, soundChooser: { node, param, feature, sources } }));
      return;
    }
    this.ui.set((s) => ({ ...s, soundChooser: null }));
    const label = REACT_FEATURES.find((f) => f.id === feature)?.label ?? feature;
    this.ed.editLevel((g) => reactPatch(g, this.io.registry, { node, param, feature, source: { node: chosen.node, port: chosen.port } }).graph);
    this.ed.toast(`Now reacting to ${label.toLowerCase()} of ${chosen.label}. Edit the Remap Range node to change how far it goes.`, 'ok');
  }

  stopReacting(node: string, param: string): void {
    this.ed.editLevel((g) => stopReacting(g, this.io.registry, node, param));
  }

  isReacting(node: string, param: string): boolean {
    return !!reactionOf(this.ed.state.level, node, param);
  }
}

const lives = new WeakMap<Io, Live>();

export function getLive(app: { ed: Editor; io: Io }): Live {
  let l = lives.get(app.io);
  if (!l) lives.set(app.io, (l = new Live(app.ed, app.io)));
  return l;
}
