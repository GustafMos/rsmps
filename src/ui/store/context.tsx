import { createContext, useCallback, useContext, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { AnyNodeDef } from '../../engine/types';
import type { Io } from '../../io/api';
import { Editor, type EditorState } from './editor';
import { useSelector, type Store } from './createStore';
import type { PlayerSlice } from './playerStore';
import type { GraphController } from '../graph/controller';

export interface AppCtx {
  io: Io;
  ed: Editor;
  playerStore: Store<PlayerSlice>;
  graphCtl: GraphController;
}

const Ctx = createContext<AppCtx | null>(null);

export function AppProvider({ value, children }: { value: AppCtx; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('AppProvider missing');
  return v;
}
export const useEditor = (): Editor => useApp().ed;
export const useIo = (): Io => useApp().io;
export const useGraphCtl = (): GraphController => useApp().graphCtl;

/** Subscribe to a slice of the editor state. */
export function useEd<T>(selector: (s: EditorState) => T, isEqual?: (a: T, b: T) => boolean): T {
  return useSelector(useApp().ed.store, selector, isEqual);
}
export function usePlayer<T>(selector: (s: PlayerSlice) => T, isEqual?: (a: T, b: T) => boolean): T {
  return useSelector(useApp().playerStore, selector, isEqual);
}

/** The live definition for a node type; re-renders if a plugin replaces it. */
export function useDef(type: string): AnyNodeDef | undefined {
  const { io } = useApp();
  const get = useCallback(() => io.registry.get(type), [io, type]);
  return useSyncExternalStore(io.registry.subscribe.bind(io.registry), get, get);
}

function useVersion(sub: (fn: () => void) => () => void): number {
  const v = useRef(0);
  const subscribe = useCallback(
    (fn: () => void) =>
      sub(() => {
        v.current++;
        fn();
      }),
    [sub],
  );
  return useSyncExternalStore(subscribe, () => v.current);
}

/** All definitions (changes when plugins are installed). */
export function useDefs(): AnyNodeDef[] {
  const { io } = useApp();
  const sub = useCallback((fn: () => void) => io.registry.subscribe(fn), [io]);
  const ver = useVersion(sub);
  return useMemo(() => io.registry.list(), [io, ver]);
}

/** Library asset list. */
export function useAssets() {
  const { io } = useApp();
  const sub = useCallback((fn: () => void) => io.library.subscribe(fn), [io]);
  const ver = useVersion(sub);
  return useMemo(() => io.library.list(), [io, ver]);
}
