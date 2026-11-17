import { useCallback, useEffect, useRef, useState } from 'react';
import { LIMITATIONS_URL, README_URL, detectBrowser, failureFromMessage, guidance, probeWebGpu, type WebGpuFailure } from './webgpuGuidance';
import './nogpu.css';

type Nav = Navigator & { gpu?: Parameters<typeof probeWebGpu>[0]['gpu'] };

/**
 * The screen for "this browser cannot give RSMPS a WebGPU device": what is missing and why (the API absent, or present but no adapter
 * or device), notes per browser that put the visitor's own first, a Check again button, and an honest list of what still works. It
 * reads at 360 px: one column, big buttons. There is no WebGL fallback and none is offered.
 */
export function NoWebGpu({ message }: { message: string }) {
  const nav = navigator as Nav;
  const env = detectBrowser(navigator.userAgent, navigator.maxTouchPoints, navigator.platform);
  const [failure, setFailure] = useState<WebGpuFailure>(() => (nav.gpu ? failureFromMessage(message) : window.isSecureContext === false ? 'insecure-context' : 'api-missing'));
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const [still, setStill] = useState(false);
  const live = useRef<HTMLParagraphElement>(null);

  const check = useCallback(async (user: boolean) => {
    setChecking(true);
    const r = await probeWebGpu({ gpu: nav.gpu, isSecureContext: window.isSecureContext });
    setChecking(false);
    if (r.ok) {
      // WebGPU answers now: boot again. Only on the user's own click: the automatic check on arrival must never reload in a loop
      // (the app can fail for a reason this probe does not see; then the message above is what is true).
      if (user) location.reload();
      return;
    }
    setFailure(r.failure ?? 'unknown');
    setDetail(r.detail);
    if (user) setStill(true);
  }, [nav.gpu]);

  useEffect(() => {
    void check(false);
  }, [check]);

  const g = guidance(failure, env, detail);
  return (
    <main className="rs-nogpu" role="alert">
      <div className="rs-nogpu__in">
        <header className="rs-nogpu__head">
          <img src={`${import.meta.env.BASE_URL}ripscorpy-logo.png`} alt="" width={64} height={64} />
          <div>
            <div className="rs-boot__word">RSMPS</div>
            <h1 className="rs-nogpu__h1">RSMPS needs WebGPU</h1>
          </div>
        </header>

        {g.verdict && <p className="rs-nogpu__verdict">{g.verdict}</p>}

        <section className="rs-nogpu__card">
          <h2>{g.headline}</h2>
          <p>{g.what}</p>
          <p className="rs-nogpu__dim">{g.why}</p>
        </section>

        <div className="rs-nogpu__actions">
          <button className="rs-btn rs-btn--primary" onClick={() => void check(true)} disabled={checking}>{checking ? 'Checking…' : 'Check again'}</button>
          <a className="rs-btn" href={README_URL} target="_blank" rel="noopener noreferrer">README: requirements</a>
        </div>
        <p ref={live} className="rs-nogpu__live" aria-live="polite">{still ? 'Still not available in this browser.' : ''}</p>

        <section className="rs-nogpu__card">
          <h2>What to try</h2>
          <ol>{g.steps.map((s) => <li key={s}>{s}</li>)}</ol>
        </section>

        <section className="rs-nogpu__card">
          <h2>Browsers</h2>
          <ul className="rs-nogpu__notes">
            {g.notes.map((n, i) => (
              <li key={n.id} className={`${i === 0 ? 'is-own' : ''}${n.blocked ? ' is-blocked' : ''}`}>
                <strong>{n.name}{i === 0 ? ' (you are probably here)' : ''}</strong>
                <span>{n.text}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rs-nogpu__card">
          <h2>What still works without WebGPU</h2>
          <ul>{g.without.map((s) => <li key={s}>{s}</li>)}</ul>
          <p className="rs-nogpu__dim"><a href={LIMITATIONS_URL} target="_blank" rel="noopener noreferrer">README: known limitations</a></p>
        </section>

        <details className="rs-nogpu__tech">
          <summary>Technical details</summary>
          <dl>
            <dt>Reported by the app</dt><dd>{message}</dd>
            <dt>WebGPU interface</dt><dd>{nav.gpu ? 'present' : 'missing'}</dd>
            <dt>Secure page (https or localhost)</dt><dd>{window.isSecureContext ? 'yes' : 'no'}</dd>
            <dt>Check result</dt><dd>{failure}{detail ? `: ${detail}` : ''}</dd>
            <dt>Browser</dt><dd>{navigator.userAgent}</dd>
          </dl>
        </details>
      </div>
    </main>
  );
}
