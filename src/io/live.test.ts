import { describe, expect, it } from 'vitest';
import { Registry } from '../engine/define';
import { addNode, connect, createGraph } from '../engine/graph';
import { registerBuiltins } from '../engine/nodes';
import { LiveSources, IDLE_CLOSE_MS, classifyUrl, corsMessage, hostOf, isIdle, loadFailureMessage, sourceKey, targetSize } from './live';
import { feedsFromLive, liveNodeIds, stampLive } from './live-stamp';

describe('live source helpers', () => {
  it('classifies URLs', () => {
    expect(classifyUrl('http://a/b.mp4', 'auto')).toBe('video');
    expect(classifyUrl('http://a/b.webm?x=1', undefined)).toBe('video');
    expect(classifyUrl('http://a/video', 'auto')).toBe('mjpeg');
    expect(classifyUrl('http://a/shot.jpg', 'image')).toBe('image');
    expect(classifyUrl('http://a/x', 'video')).toBe('video');
  });
  it('shares one stream per source regardless of freeze', () => {
    const a = sourceKey({ kind: 'camera', deviceId: 'd', width: 640, height: 480 });
    expect(sourceKey({ kind: 'camera', deviceId: 'd', width: 640, height: 480, freeze: true } as never)).toBe(a);
    expect(sourceKey({ kind: 'camera', deviceId: 'e', width: 640, height: 480 })).not.toBe(a);
    expect(sourceKey({ kind: 'url', url: 'u', mode: 'image', refresh: 2 } as never)).not.toBe(sourceKey({ kind: 'url', url: 'u', mode: 'image', refresh: 3 } as never));
    expect(sourceKey({ kind: 'url', url: 'u', mode: 'mjpeg', refresh: 2 } as never)).toBe(sourceKey({ kind: 'url', url: 'u', mode: 'mjpeg', refresh: 9 } as never));
  });
  it('downscales to maxSide and the device limit', () => {
    expect(targetSize(1280, 720, 0, 8192)).toEqual({ width: 1280, height: 720 });
    expect(targetSize(1280, 720, 640, 8192)).toEqual({ width: 640, height: 360 });
    expect(targetSize(1280, 720, 4000, 8192)).toEqual({ width: 1280, height: 720 });
    expect(targetSize(9000, 4500, 0, 8192)).toEqual({ width: 8192, height: 4096 });
  });
  it('closes after the idle time', () => {
    expect(isIdle(1000, 1000 + IDLE_CLOSE_MS - 1)).toBe(false);
    expect(isIdle(1000, 1000 + IDLE_CLOSE_MS)).toBe(true);
  });
  it('explains failures in plain words', () => {
    expect(hostOf('http://192.168.1.5:8080/video')).toBe('192.168.1.5:8080');
    expect(corsMessage('http://cam.local/x')).toMatch(/cam\.local does not allow other sites to read its picture \(CORS\)/);
    expect(loadFailureMessage('http://192.168.1.5/v', 'https:', 'https://app.example')).toMatch(/mixed content/);
    expect(loadFailureMessage('http://localhost:8080/v', 'https:', 'https://app.example')).toMatch(/CORS/);
    expect(loadFailureMessage('http://localhost:5173/nope.png', 'http:', 'http://localhost:5173')).toMatch(/Check the address/);
    expect(loadFailureMessage('http://', 'http:', 'http://localhost:5173')).toMatch(/not a valid address/);
  });
});

describe('live stamping', () => {
  const registry = new Registry();
  registerBuiltins(registry);
  it('finds live nodes, upstream relations and stamps only them', () => {
    let g = createGraph('t');
    const cam = addNode(g, registry, 'camera-in');
    g = cam.graph;
    const blur = addNode(g, registry, 'blur');
    g = blur.graph;
    const noise = addNode(g, registry, 'noise');
    g = noise.graph;
    g = connect(g, registry, { node: cam.node.id, port: 'image' }, { node: blur.node.id, port: 'image' });
    const live = liveNodeIds(g, registry);
    expect([...live]).toEqual([cam.node.id]);
    expect(feedsFromLive(g, blur.node.id, live)).toBe(true);
    expect(feedsFromLive(g, noise.node.id, live)).toBe(false);
    expect(feedsFromLive(g, null, live)).toBe(false);
    const s1 = stampLive(g, live, 1);
    const s2 = stampLive(g, live, 2);
    expect(s1.nodes.find((n) => n.id === cam.node.id)!.params.liveTick).toBe('1');
    expect(s2.nodes.find((n) => n.id === cam.node.id)!.params.liveTick).toBe('2');
    expect(s1.nodes.find((n) => n.id === noise.node.id)).toBe(g.nodes.find((n) => n.id === noise.node.id)); // untouched
    expect(g.nodes.find((n) => n.id === cam.node.id)!.params.liveTick).toBe(''); // original not mutated
    expect(stampLive(g, new Set(), 5)).toBe(g);
  });
});

describe('cameras while the AR view is open', () => {
  it('device cameras are blocked and answer nothing until the view is closed; other sources are untouched', async () => {
    const live = new LiveSources({} as never);
    expect(live.camerasBlocked).toBe(false);
    live.suspendCameras(true);
    expect(live.camerasBlocked).toBe(true);
    expect(await live.frame({ kind: 'camera', deviceId: '' }, 0)).toBeNull();
    expect(live.drawable({ kind: 'camera', deviceId: '' })).toBeNull();
    expect(live.active).toBe(false); // nothing was opened
    expect((await live.askCamera()).ok).toBe(false);
    live.suspendCameras(false);
    expect(live.camerasBlocked).toBe(false);
  });
});
