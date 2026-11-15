import { defineNode } from '../../define';
import type { LiveSource } from '../../types';

/**
 * A picture from a web address: a still that is re-fetched every few seconds (also an IP-camera "snapshot"
 * URL), an MJPEG stream, or a video file. See docs/LIVE_INPUT.md for what browsers allow.
 * `liveTick` is stamped by the player so a live picture is never served from the evaluation cache; leave it alone.
 */
export default defineNode({
  id: 'url-in',
  title: 'URL / Stream',
  category: 'input',
  description:
    'Picture from a web address: a snapshot URL refreshed every few seconds, an MJPEG stream (e.g. a phone "IP webcam" app) or a video file. The server must allow other sites to read it (CORS headers), and on an https page the address must be https. Live preview only.',
  keywords: ['url', 'stream', 'mjpeg', 'ip camera', 'phone', 'network', 'http', 'webcam'],
  inputs: {},
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    url: { type: 'string', default: '', label: 'Address (URL)', hint: 'http(s)://…  Needs CORS headers (Access-Control-Allow-Origin).' },
    kind: {
      type: 'enum',
      default: 'auto',
      label: 'Type',
      options: [
        { value: 'auto', label: 'Auto (by address)' },
        { value: 'image', label: 'Picture, refreshed' },
        { value: 'mjpeg', label: 'MJPEG stream' },
        { value: 'video', label: 'Video file (loops)' },
      ],
    },
    refresh: {
      type: 'number',
      default: 2,
      min: 0.1,
      max: 3600,
      softMax: 60,
      step: 0.1,
      unit: 's',
      label: 'Refresh every',
      visibleIf: (p) => p.kind === 'image',
    },
    liveTick: { type: 'string', default: '', label: 'Live tick', visibleIf: () => false },
  },
  summary: (p) => (p.url ? String(p.url).replace(/^https?:\/\//, '').slice(0, 28) : 'no address'),
  async render(ctx) {
    void ctx.time.seconds; // live: re-render every frame
    const host = ctx.host;
    const url = ctx.params.url.trim();
    if (!url) throw new Error('Enter an address (URL).');
    if (!host.liveFrame) throw new Error('Network pictures are not available here (exports and headless runs). Record it first.');
    const source: LiveSource = { kind: 'url', url, mode: ctx.params.kind, refresh: ctx.params.refresh };
    const maxSide = ctx.proxy < 1 ? Math.ceil(Math.max(ctx.canvas.width, ctx.canvas.height)) : 0;
    const frame = await host.liveFrame(source, maxSide);
    if (!frame) throw new Error('Waiting for the first picture…');
    return { image: { kind: 'image', texture: frame.texture, width: frame.width, height: frame.height, unit: ctx.unitFor(frame.width, frame.height) } };
  },
});
