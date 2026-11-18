import { batchCount, enabledOutputs, outputNodes } from '../../engine/graph';
import { CheckField } from '../components/fields';
import { useApp, useEd } from '../store/context';
import { frameSize, hasFrameParams } from '../viewer/FrameControl';
import { KIND_SHORT, describeOutput, hasKind, kindOptions } from '../lib/outputInfo';
import { describeExportSound } from '../lib/exportSound';
import { needsFfmpeg } from '../../io/export-codecs';
import { ffmpegInstalled, useAddons } from './AddonsSection';
import { Dialog } from './Dialog';

/** Export dialog. The per-output checkboxes ARE the outputs' `enabled` param, so the choice lives in the project. */
export function ExportDialog() {
  const { io, ed } = useApp();
  const graph = useEd((s) => s.graph);
  const item = useEd((s) => s.item);
  const projectId = useEd((s) => s.activeProject);
  const outputs = outputNodes(graph, io.registry);
  const enabled = enabledOutputs(graph, io.registry);
  const count = batchCount(graph, io.registry);
  const prefs = ed.exportPrefs(projectId);
  const items = count > 1 ? prefs.items : 'current';
  const addons = useAddons(io);
  const usesFfmpeg = (o: (typeof outputs)[number]) => ['auto', 'video'].includes(String(o.params.kind ?? 'auto')) && needsFfmpeg(String(o.params.codec ?? ''));
  const missingFfmpeg = enabled.filter(usesFfmpeg);
  const canInstall = io.addons.supported;
  const sound = describeExportSound(graph, io.registry, (id) => io.library.assetInfo(id), item);
  // Sound goes into video files only: say what it will be when a video is among the enabled outputs.
  const pictureOuts = enabled.filter((o) => Object.values(io.registry.get(o.type)?.inputs ?? {}).some((i) => (i as { type: string }).type === 'image'));
  const exportsVideo = pictureOuts.some((o) => o.params.kind === 'video') || (pictureOuts.some((o) => String(o.params.kind ?? 'auto') === 'auto') && (sound.kind !== 'none' || sound.unheard));

  const start = () => {
    ed.openDialog(null);
    void ed.runExport([], items, prefs.zip);
  };

  return (
    <Dialog
      title="Export"
      onClose={() => ed.openDialog(null)}
      footer={
        <>
          <button className="rs-btn" onClick={() => ed.openDialog(null)}>Close</button>
          <button className="rs-btn rs-btn--primary" onClick={start} disabled={enabled.length === 0}>
            Export {enabled.length} output{enabled.length === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      {outputs.length === 0 ? (
        <p className="rs-dlg__note">There is no Output node in this graph. Add one (Shift+A → Output) and connect your result to it.</p>
      ) : (
        <>
          <div className="rs-dlg__sec">
            <div className="rs-dlg__row">
              <span className="rs-caps">Outputs to export</span>
              <span className="rs-dlg__spacer" />
              <button className="rs-btn rs-btn--ghost" onClick={() => outputs.forEach((o) => ed.setParam(o.id, 'enabled', true))}>All on</button>
              <button className="rs-btn rs-btn--ghost" onClick={() => outputs.forEach((o) => ed.setParam(o.id, 'enabled', false))}>All off</button>
            </div>
            <div className="rs-dlg__list">
              {outputs.map((o) => {
                const def = io.registry.get(o.type);
                const fs = hasFrameParams(def) ? frameSize(graph.project, o) : null;
                const px = Number(o.params.pixelSize ?? 1);
                return (
                  <div key={o.id} className="rs-exp__row">
                    <CheckField value={o.params.enabled !== false} onChange={(v) => ed.setParam(o.id, 'enabled', v)} label={o.label || def?.title || o.type} />
                    {def && hasKind(def) && <select className="rs-select rs-side__kind" value={String(o.params.kind ?? 'auto')} aria-label="Export type" onChange={(e) => ed.setParam(o.id, 'kind', e.target.value)}>{kindOptions(def).map((k) => <option key={k.value} value={k.value}>{KIND_SHORT[k.value] ?? k.label}</option>)}</select>}
                    <span className="rs-exp__info rs-num">
                      {def ? describeOutput(def, o, graph.project) : ''}
                      {usesFfmpeg(o) && <span className="rs-ffmpeg-tag">needs FFmpeg</span>}
                      {fs ? '' : ''}
                      {px > 1 ? ` · pixel ${px}×` : ''}
                      {o.bypass ? ' · bypassed' : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          {missingFfmpeg.length > 0 && !ffmpegInstalled(addons) && (
            <div className="rs-exp__ffmpeg" role="alert">
              {canInstall ? (
                <>
                  <span>{missingFfmpeg.map((o) => o.label || io.registry.get(o.type)?.title || o.type).join(', ')} uses a video format that needs FFmpeg, which is not set up yet.</span>
                  <button className="rs-btn" onClick={() => ed.openDialog('plugins')}>Install FFmpeg…</button>
                </>
              ) : (
                <span>{missingFfmpeg.map((o) => o.label || io.registry.get(o.type)?.title || o.type).join(', ')} uses a video format that needs the desktop app, or the free command-line tool (docs/CLI.md). Pick another video codec to export here.</span>
              )}
            </div>
          )}
          {exportsVideo && (
            <div className="rs-dlg__sec">
              <span className="rs-caps">Sound in the video</span>
              <p className="rs-dlg__note">{sound.text}</p>
              {sound.unheard && (
                <div className="rs-dlg__row">
                  <button className="rs-btn" onClick={() => { if (ed.ensureAudioOutput()) void io.player.enableAudio().catch(() => undefined); }}>
                    Add an Audio Output for it
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="rs-dlg__sec">
            <span className="rs-caps">What to render</span>
            <div className="rs-dlg__seg">
              <button className={`rs-btn${items === 'current' ? ' is-on' : ''}`} onClick={() => ed.setExportPrefs(projectId, { items: 'current' })}>Current item{count > 1 ? ` (${item + 1})` : ''}</button>
              <button className={`rs-btn${items === 'all' ? ' is-on' : ''}`} disabled={count < 2} onClick={() => ed.setExportPrefs(projectId, { items: 'all' })}>Whole batch{count > 1 ? ` (${count})` : ''}</button>
            </div>
            <CheckField value={prefs.zip} onChange={(v) => ed.setExportPrefs(projectId, { zip: v })} label="Pack into a ZIP when there is more than one file" />
            <p className="rs-dlg__note">These choices are remembered for this project.</p>
          </div>
        </>
      )}
    </Dialog>
  );
}
