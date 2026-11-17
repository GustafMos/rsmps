import { useEffect, useSyncExternalStore } from 'react';
import { MODEL_CATALOGUE, type ModelEntry } from '../../io/model-catalogue';
import { modelStore, type ModelStatus } from '../../io/models';
import './addons.css';

const MB = 1024 * 1024;

export function modelStatusText(s: ModelStatus, e: Pick<ModelEntry, 'sizeLabel'>): string {
  switch (s.state) {
    case 'ready':
      return `On this computer · ${(s.bytes / MB).toFixed(0)} MB`;
    case 'downloading':
      return s.phase === 'verifying' ? 'Checking the checksum…' : `Downloading… ${(s.received / MB).toFixed(0)} of ${(s.total / MB).toFixed(0)} MB (${Math.min(100, Math.round((s.received / Math.max(1, s.total)) * 100))}%)`;
    case 'failed':
      return 'Not downloaded';
    default:
      return `Not downloaded · ${e.sizeLabel}`;
  }
}

function ModelCard({ m }: { m: ModelEntry }) {
  const store = modelStore();
  useSyncExternalStore((fn) => store.subscribe(fn), () => store.version);
  useEffect(() => {
    void store.refresh(m.id);
  }, [store, m.id]);
  const s = store.status(m.id);
  const busy = s.state === 'downloading';
  return (
    <div className={`rs-addon${s.state === 'failed' ? ' has-error' : ''}`}>
      <div className="rs-addon__head">
        <span className="rs-addon__title">{m.title}</span>
        <span className={`rs-addon__state${s.state === 'ready' ? ' is-ok' : ''}`}>{s.state === 'ready' ? 'Downloaded' : busy ? 'Downloading' : 'Optional'}</span>
      </div>
      <p className="rs-addon__meta">{m.summary}</p>
      <p className="rs-addon__meta">
        {modelStatusText(s, m)} · License: {m.license.name}
      </p>
      <div className="rs-addon__links">
        <a href={m.homepage} target="_blank" rel="noopener noreferrer">Model page</a>
        <a href={m.sourceUrl} target="_blank" rel="noopener noreferrer">Download source</a>
        <a href={m.license.url} target="_blank" rel="noopener noreferrer">License</a>
      </div>
      <p className="rs-addon__meta">{m.attribution}</p>
      <p className="rs-addon__meta">It runs on your own GPU (or your processor, slowly, without WebGPU). Nothing is uploaded. The file is fetched from {m.host} only when you press Download, and checked against a known checksum before it is used.</p>
      {busy && (
        <div className="rs-dlg__progress" role="status">
          <div className="rs-dlg__bar"><div style={{ width: `${s.state === 'downloading' ? Math.min(100, (s.received / Math.max(1, s.total)) * 100) : 0}%` }} /></div>
        </div>
      )}
      {s.state === 'failed' && <p className="rs-addon__err" role="alert">{s.error}</p>}
      <div className="rs-addon__btns">
        {busy ? (
          <button className="rs-btn" onClick={() => store.cancel(m.id)}>Cancel</button>
        ) : s.state === 'ready' ? (
          <button className="rs-btn rs-btn--danger" onClick={() => void store.remove(m.id)}>Remove</button>
        ) : (
          <button className="rs-btn rs-btn--primary" onClick={() => void store.download(m.id)}>{s.state === 'failed' ? 'Try again' : `Download (${m.sizeLabel})`}</button>
        )}
      </div>
    </div>
  );
}

/** "AI models" block of the Plugins dialog (browser and desktop): optional models, downloaded only on request. */
export function AiModelsSection() {
  return (
    <div className="rs-dlg__sec rs-addons rs-ai-models">
      <span className="rs-caps">AI models</span>
      <p className="rs-dlg__note">Optional. Models are never included with RSMPS and never downloaded by themselves.</p>
      {MODEL_CATALOGUE.map((m) => (
        <ModelCard key={m.id} m={m} />
      ))}
    </div>
  );
}
