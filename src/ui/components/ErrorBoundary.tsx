import { Component, type ReactNode } from 'react';
import type { AppCtx } from '../store/context';
import { reloadInSafeMode, reloadNormally } from '../safety';

interface Props {
  /** When given, "Download project file" saves the open project. */
  app?: AppCtx;
  children: ReactNode;
}

/** Last line of defence: a crash while drawing the UI shows these choices instead of a white screen. */
export class ErrorBoundary extends Component<Props, { error: Error | null; saved: string }> {
  state = { error: null as Error | null, saved: '' };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: { componentStack?: string | null }) {
    console.error('RSMPS crashed while drawing the interface:', error, info.componentStack);
  }

  private download = async () => {
    const app = this.props.app;
    if (!app) return;
    try {
      await app.io.projects.saveToFile(app.ed.state.graph);
      this.setState({ saved: 'Project file saved.' });
    } catch (err) {
      this.setState({ saved: `Could not save: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  render() {
    const { error, saved } = this.state;
    if (!error) return this.props.children;
    const app = this.props.app;
    return (
      <div className="rs-boot rs-boot--error" role="alert">
        <div className="rs-boot__word">Something went wrong</div>
        <p className="rs-boot__big">RSMPS hit an error and stopped drawing. Your project is saved automatically.</p>
        <p className="rs-boot__msg">{error.message}</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button className="rs-btn rs-btn--primary" onClick={() => reloadNormally(app)}>Reload</button>
          <button className="rs-btn" onClick={() => reloadInSafeMode(app)} title="Opens the project with rendering paused">Reload in safe mode</button>
          {app && <button className="rs-btn" onClick={() => void this.download()}>Download project file</button>}
        </div>
        {saved && <p className="rs-boot__msg">{saved}</p>}
      </div>
    );
  }
}
