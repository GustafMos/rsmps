/**
 * The part of the WebXR Device API the World AR view uses, as plain structural types.
 *
 * Why local types and not a typings package: TypeScript's DOM library has no WebXR, the app takes no new dependencies, and the tests
 * run the whole view against a FAKE session written to these same shapes (fake-xr.ts). Names and members follow the specifications
 * (WebXR Device API, AR module, Hit Test, Anchors, DOM Overlays, Raw Camera Access; editor's drafts read in November 2026); only what
 * is used is declared.
 */
export interface XrPoint {
  x: number;
  y: number;
  z: number;
  w: number;
}
export interface XrRigidTransform {
  position: XrPoint;
  orientation: XrPoint;
}
export interface XrViewLike {
  transform: XrRigidTransform;
  /** 16 numbers, column-major. */
  projectionMatrix: ArrayLike<number>;
  /** Raw Camera Access: present when the `camera-access` feature was granted and the device has a picture for this view. */
  camera?: { width: number; height: number } | null;
}
export interface XrViewerPoseLike {
  transform: XrRigidTransform;
  views: ArrayLike<XrViewLike>;
  /** True when the position is a guess (the device lost track of the room and only knows how it is turned). */
  emulatedPosition?: boolean;
}
export interface XrPoseLike {
  transform: XrRigidTransform;
  emulatedPosition?: boolean;
}
export interface XrAnchorLike {
  anchorSpace: unknown;
  delete(): void;
}
export interface XrHitTestResultLike {
  getPose(baseSpace: unknown): XrPoseLike | null;
  /** Anchors module: absent when the `anchors` feature was not granted. */
  createAnchor?: () => Promise<XrAnchorLike>;
}
export interface XrFrameLike {
  getViewerPose(referenceSpace: unknown): XrViewerPoseLike | null;
  getPose(space: unknown, baseSpace: unknown): XrPoseLike | null;
  getHitTestResults?: (source: unknown) => ArrayLike<XrHitTestResultLike>;
  /** Anchors module: the anchors the device still tracks in this frame. */
  trackedAnchors?: { has(anchor: XrAnchorLike): boolean };
  createAnchor?: (pose: unknown, space: unknown) => Promise<XrAnchorLike>;
}
export interface XrViewportLike {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface XrLayerLike {
  framebuffer: unknown;
  framebufferWidth: number;
  framebufferHeight: number;
  getViewport(view: XrViewLike): XrViewportLike | null;
}
export interface XrInputSourceLike {
  targetRayMode?: string;
  targetRaySpace?: unknown;
}
export type XrFrameCallback = (time: number, frame: XrFrameLike) => void;
export interface XrSessionLike {
  requestReferenceSpace(type: string): Promise<unknown>;
  requestAnimationFrame(cb: XrFrameCallback): number;
  cancelAnimationFrame(handle: number): void;
  updateRenderState(state: { baseLayer?: unknown }): void | Promise<void>;
  end(): Promise<void>;
  addEventListener(type: string, cb: (ev: unknown) => void): void;
  removeEventListener(type: string, cb: (ev: unknown) => void): void;
  /** Hit Test module. */
  requestHitTestSource?: (options: { space: unknown }) => Promise<{ cancel(): void }> | undefined;
  /** The features the browser actually granted (Chrome 114+). Absent on older browsers: then each feature is probed by use. */
  enabledFeatures?: ArrayLike<string>;
  /** DOM Overlays module: set when the overlay is shown. */
  domOverlayState?: { type: string } | null;
  visibilityState?: string;
}
export interface XrSystemLike {
  isSessionSupported(mode: string): Promise<boolean>;
  requestSession(mode: string, init?: { requiredFeatures?: string[]; optionalFeatures?: string[]; domOverlay?: { root: unknown } }): Promise<XrSessionLike>;
}

/** The features asked for. All optional: the session must still start on a device that has none of them (see `featuresOf`). */
export const OPTIONAL_FEATURES = ['hit-test', 'anchors', 'dom-overlay', 'camera-access'] as const;

export interface GrantedFeatures {
  hitTest: boolean;
  anchors: boolean;
  domOverlay: boolean;
  cameraAccess: boolean;
}

/**
 * What a started session can do. `enabledFeatures` is the browser's own answer where it exists; where it does not, a feature counts
 * as granted when its entry point is there, and the code that uses it copes with it failing.
 */
export function featuresOf(session: XrSessionLike, askedFor: readonly string[] = OPTIONAL_FEATURES): GrantedFeatures {
  const list = session.enabledFeatures ? Array.from(session.enabledFeatures) : null;
  const asked = (f: string) => askedFor.includes(f);
  const has = (f: string, probe: boolean) => asked(f) && (list ? list.includes(f) : probe);
  return {
    hitTest: has('hit-test', typeof session.requestHitTestSource === 'function'),
    anchors: has('anchors', true),
    domOverlay: asked('dom-overlay') && (list ? list.includes('dom-overlay') : true) && !!session.domOverlayState,
    cameraAccess: has('camera-access', true),
  };
}
