import { Icon } from '../components/Icon';
import { bindingsOf, useKeymapVersion } from '../keymap';
import { safetyStore, togglePaused } from '../safety';
import { useApp } from '../store/context';
import { useSelector } from '../store/createStore';

/** Transport button: stop evaluating the graph while you edit (edits still apply). The shortcut is `play.pauseRender` in the keymap. */
export function RenderPause() {
  const app = useApp();
  useKeymapVersion();
  const paused = useSelector(safetyStore, (s) => s.paused);
  const key = bindingsOf('play.pauseRender')[0];
  return (
    <button
      className={`rs-btn rs-tp__renderpause${paused ? ' is-on' : ''}`}
      onClick={() => togglePaused(app)}
      role="switch"
      aria-checked={paused}
      title={`${paused ? 'Rendering is paused: nothing is evaluated. Click to resume.' : 'Pause rendering: edits still apply, but nothing is evaluated until you resume.'}${key ? ` (${key})` : ''}`}
    >
      <Icon name={paused ? 'play' : 'pause'} size={14} />
      <span>{paused ? 'RENDER OFF' : 'RENDER'}</span>
    </button>
  );
}
