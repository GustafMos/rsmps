/**
 * Imperative handle on the node-graph view. Pan/zoom, drags and wire previews live here (refs and
 * CSS transforms), so pointer events never go through React or the store.
 */
export class GraphController {
  view = { x: 60, y: 60, zoom: 1 };
  root: HTMLElement | null = null;
  layer: HTMLElement | null = null;
  pending: SVGPathElement | null = null;
  hint: HTMLElement | null = null;
  box: HTMLElement | null = null;
  cut: SVGLineElement | null = null;
  readonly nodeEls = new Map<string, HTMLElement>();
  readonly frameEls = new Map<string, HTMLElement>();
  readonly edgeEls = new Map<string, SVGPathElement[]>();
  pointer = { x: 0, y: 0 };
  /** An output clicked (not dragged): the next click on another output merges the two. */
  pendingOut: { node: string; port: string } | null = null;
  hovering = false;
  /** True until the graph has been framed with a real panel size. */
  needsFit = true;
  spaceDown = false;
  spaceUsed = false;
  /** Binding that started the current hold-to-pan (so its release can be matched). */
  spaceKey: string | null = null;
  /** `code` of the key that started hold-to-pan, to re-validate against keys really held. */
  spaceCode: string | null = null;
  /** Keys currently held (by `code`); cleared on blur so a lost keyup cannot leave Space stuck. */
  readonly keysDown = new Set<string>();
  private listeners = new Set<() => void>();
  /** Called whenever pan/zoom changes (the selection toolbar follows it). */
  readonly viewListeners = new Set<() => void>();
  private zoomPct = 100;

  subscribeZoom = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getZoomPct = () => this.zoomPct;

  applyView(): void {
    const { x, y, zoom } = this.view;
    this.viewListeners.forEach((l) => l());
    if (this.layer) this.layer.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    if (this.root) {
      const g = 24 * zoom;
      this.root.style.setProperty('--grid', `${g}px`);
      this.root.style.setProperty('--gx', `${x}px`);
      this.root.style.setProperty('--gy', `${y}px`);
      this.root.style.setProperty('--zoom', String(zoom));
    }
    const pct = Math.round(zoom * 100);
    if (pct !== this.zoomPct) {
      this.zoomPct = pct;
      this.listeners.forEach((l) => l());
    }
  }

  rect(): DOMRect {
    return this.root?.getBoundingClientRect() ?? new DOMRect(0, 0, 800, 600);
  }

  toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.rect();
    return { x: (clientX - r.left - this.view.x) / this.view.zoom, y: (clientY - r.top - this.view.y) / this.view.zoom };
  }

  zoomAt(clientX: number, clientY: number, factor: number): void {
    this.needsFit = false;
    const r = this.rect();
    const mx = clientX - r.left;
    const my = clientY - r.top;
    const z = Math.min(2.5, Math.max(0.15, this.view.zoom * factor));
    const k = z / this.view.zoom;
    this.view.x = mx - (mx - this.view.x) * k;
    this.view.y = my - (my - this.view.y) * k;
    this.view.zoom = z;
    this.applyView();
  }

  /** Fit a world rectangle into the view. */
  fit(bounds: { x: number; y: number; w: number; h: number }, maxZoom = 1.2): void {
    const r = this.rect();
    const pad = 56;
    const z = Math.min(maxZoom, Math.max(0.15, Math.min((r.width - pad * 2) / Math.max(1, bounds.w), (r.height - pad * 2) / Math.max(1, bounds.h))));
    this.view.zoom = z;
    this.view.x = (r.width - bounds.w * z) / 2 - bounds.x * z;
    this.view.y = (r.height - bounds.h * z) / 2 - bounds.y * z;
    this.applyView();
  }

  centerOn(world: { x: number; y: number }): void {
    const r = this.rect();
    this.view.x = r.width / 2 - world.x * this.view.zoom;
    this.view.y = r.height / 2 - world.y * this.view.zoom;
    this.applyView();
  }
}
