import { useCallback } from 'react';
import { createStore, useSelector } from '../store/createStore';
import { DEFAULT_SHELL, SHELL_KEY, loadShell, serializeShell, shellReducer, PERSISTED_SHELL, type ShellAction, type ShellState } from './shellState';

export const shellStore = createStore<ShellState>(loadShell((k) => { try { return localStorage.getItem(k); } catch { return null; } }) ?? DEFAULT_SHELL);

export function dispatchShell(a: ShellAction): void {
  const prev = shellStore.get();
  const next = shellReducer(prev, a);
  if (next === prev) return;
  shellStore.set(next);
  if (PERSISTED_SHELL.some((k) => prev[k] !== next[k])) {
    try {
      localStorage.setItem(SHELL_KEY, serializeShell(next));
    } catch {
      /* lasts for this session only */
    }
  }
}

export function useShell<T>(selector: (s: ShellState) => T, isEqual?: (a: T, b: T) => boolean): T {
  return useSelector(shellStore, selector, isEqual);
}

/** Shortcuts the shells and the top bar share. */
export const showTab = (tab: ShellState['tab']): void => dispatchShell({ type: 'tab', tab });

export function useShellDispatch(): (a: ShellAction) => void {
  return useCallback((a: ShellAction) => dispatchShell(a), []);
}
