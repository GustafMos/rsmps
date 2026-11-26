/**
 * What the World AR view draws with: WebGL, because that is the only thing a WebXR session on a phone shows (the app's own renderer
 * is WebGPU, and the WebXR-WebGPU binding is not shipped: it is behind a flag in Chromium in November 2026). The browser puts the
 * camera picture behind this framebuffer by itself; wherever the framebuffer stays transparent, the room shows.
 *
 * Everything drawn is a rectangle given by its four corners in the room: the object's picture, and the ring that marks a surface.
 * The picture comes from the node graph and gets here in one of two ways (engine-source.ts picks by testing): the browser copies the
 * WebGPU canvas into a WebGL texture (fast where the two share memory), or the pixels are read back and uploaded (works everywhere).
 *
 * Colours are premultiplied by alpha everywhere: the engine's pictures are, a WebXR layer expects it, and so the blend is
 * ONE, ONE_MINUS_SRC_ALPHA.
 *
 * UNTESTED ON A REAL AR DEVICE. Checked against a plain WebGL canvas in desktop Chromium only.
 */
import type { Corners } from '../../engine/lib/xr-math';
import type { ArPainter } from './loop';
import type { XrViewLike, XrViewportLike } from './xr-api';

type GL = WebGLRenderingContext | WebGL2RenderingContext;

const VERT = `
attribute vec3 aPos;
attribute vec2 aUv;
uniform mat4 uViewProjection;
varying vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = uViewProjection * vec4(aPos, 1.0);
}`;

const FRAG = `
precision mediump float;
uniform sampler2D uTex;
uniform float uOpacity;
uniform int uMode;
varying vec2 vUv;
void main() {
  if (uMode == 1) {
    // the ring: a white band with a dark rim so it shows on light and dark floors, and a dot in the middle
    float r = length(vUv - 0.5) * 2.0;
    float band = smoothstep(0.70, 0.76, r) * (1.0 - smoothstep(0.92, 0.98, r));
    float rim = smoothstep(0.62, 0.70, r) * (1.0 - smoothstep(0.98, 1.0, r));
    float dot = 1.0 - smoothstep(0.07, 0.11, r);
    float white = max(band, dot);
    float a = max(white, rim * 0.55);
    gl_FragColor = vec4(vec3(white), a) * uOpacity;
  } else {
    gl_FragColor = texture2D(uTex, vUv) * uOpacity;
  }
}`;

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
/** Longest side of the camera picture kept for the clip. */
export const CAMERA_MAX_SIDE = 1280;

function compile(gl: GL, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('WebGL could not create a shader.');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(`WebGL shader: ${gl.getShaderInfoLog(sh) ?? 'failed'}`);
  return sh;
}

/** Raw Camera Access: `new XRWebGLBinding(session, gl)`. */
export interface CameraBinding {
  getCameraImage(camera: unknown): WebGLTexture | null;
}

export class GlPainter implements ArPainter {
  private program: WebGLProgram;
  private buffer: WebGLBuffer;
  private tex: WebGLTexture;
  private loc: { pos: number; uv: number; vp: WebGLUniformLocation | null; tex: WebGLUniformLocation | null; opacity: WebGLUniformLocation | null; mode: WebGLUniformLocation | null };
  private data = new Float32Array(20);
  private hasPicture = false;
  private cameraSize: { width: number; height: number; maxSide: number } | null = null;
  /** Set once camera access is known to work in this session. */
  binding: CameraBinding | null = null;

  constructor(readonly gl: GL) {
    const program = gl.createProgram();
    const buffer = gl.createBuffer();
    const tex = gl.createTexture();
    if (!program || !buffer || !tex) throw new Error('WebGL could not be set up for the AR view.');
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`WebGL program: ${gl.getProgramInfoLog(program) ?? 'failed'}`);
    this.program = program;
    this.buffer = buffer;
    this.tex = tex;
    this.loc = {
      pos: gl.getAttribLocation(program, 'aPos'),
      uv: gl.getAttribLocation(program, 'aUv'),
      vp: gl.getUniformLocation(program, 'uViewProjection'),
      tex: gl.getUniformLocation(program, 'uTex'),
      opacity: gl.getUniformLocation(program, 'uOpacity'),
      mode: gl.getUniformLocation(program, 'uMode'),
    };
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // the picture is any size (not a power of two) and shown about 1:1: no mipmaps, no repeat
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  begin(framebuffer: unknown, viewport: XrViewportLike): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, (framebuffer as WebGLFramebuffer | null) ?? null);
    gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE); // a card is seen from behind too
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /**
   * One rectangle. Corners: bottom-left, bottom-right, top-left, top-right. `topV` is the texture row that is the TOP of the picture:
   * 0 for pictures uploaded here (their first row is the top), 1 for textures in OpenGL's own orientation.
   */
  private quad(corners: Corners, viewProjection: Float32Array, mode: number, opacity: number, texture: WebGLTexture | null, topV: number): void {
    const gl = this.gl;
    const d = this.data;
    const uv = [0, 1 - topV, 1, 1 - topV, 0, topV, 1, topV];
    for (let i = 0; i < 4; i++) {
      d[i * 5] = corners[i][0];
      d[i * 5 + 1] = corners[i][1];
      d[i * 5 + 2] = corners[i][2];
      d[i * 5 + 3] = uv[i * 2];
      d[i * 5 + 4] = uv[i * 2 + 1];
    }
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, d, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.loc.pos);
    gl.vertexAttribPointer(this.loc.pos, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(this.loc.uv);
    gl.vertexAttribPointer(this.loc.uv, 2, gl.FLOAT, false, 20, 12);
    gl.uniformMatrix4fv(this.loc.vp, false, viewProjection);
    gl.uniform1f(this.loc.opacity, opacity);
    gl.uniform1i(this.loc.mode, mode);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture ?? this.tex);
    gl.uniform1i(this.loc.tex, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  picture(corners: Corners, viewProjection: Float32Array, opacity: number): void {
    if (this.hasPicture) this.quad(corners, viewProjection, 0, opacity, this.tex, 0);
  }

  ring(corners: Corners, viewProjection: Float32Array): void {
    this.quad(corners, viewProjection, 1, 1, null, 0);
  }

  /** The object's picture as premultiplied RGBA bytes, first row = top. */
  uploadPixels(bytes: Uint8Array | Uint8ClampedArray, width: number, height: number): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); // the bytes are premultiplied already
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    this.hasPicture = true;
  }

  /** The object's picture straight from the WebGPU canvas it was drawn into (premultiplied alpha). */
  uploadCanvas(canvas: TexImageSource): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // ask for premultiplied data: with this off the browser would divide the canvas's colours by alpha on the way in
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.hasPicture = true;
  }

  /**
   * Read back a few pixels of the picture texture (x, y from the top-left of the picture, premultiplied RGBA). Only used once per
   * session, to find out whether copying from the WebGPU canvas really delivers the picture on this device.
   */
  readPicture(points: [number, number][], height: number): number[][] {
    const gl = this.gl;
    const fb = gl.createFramebuffer();
    const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    const px = new Uint8Array(4);
    const out: number[][] = [];
    void height;
    for (const [x, y] of points) {
      // row 0 of the texture is the top of the picture (nothing was flipped on upload), and readPixels counts rows from row 0
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      out.push([...px]);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
    gl.deleteFramebuffer(fb);
    return out;
  }

  /**
   * The camera picture of this frame, drawn into the WebGL context's own canvas so the clip recorder can read it. Only with camera
   * access. ASSUMPTION (could not be checked without a device): the camera texture is in OpenGL's orientation, its row 0 at the
   * bottom of the picture. If recorded clips come out upside down, `CAMERA_TOP_V` below is the one thing to change.
   */
  camera(view: XrViewLike, maxSide: number = CAMERA_MAX_SIDE): unknown | null {
    const gl = this.gl;
    const cam = view.camera;
    if (!this.binding || !cam || !cam.width || !cam.height) return null;
    const texture = this.binding.getCameraImage(cam);
    if (!texture) return null;
    const canvas = gl.canvas as HTMLCanvasElement | OffscreenCanvas;
    if (!this.cameraSize || this.cameraSize.width !== cam.width || this.cameraSize.height !== cam.height || this.cameraSize.maxSide !== maxSide) {
      this.cameraSize = { width: cam.width, height: cam.height, maxSide };
      const k = Math.min(1, maxSide / Math.max(cam.width, cam.height));
      canvas.width = Math.max(2, Math.floor((cam.width * k) / 2) * 2);
      canvas.height = Math.max(2, Math.floor((cam.height * k) / 2) * 2);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.BLEND);
    this.quad([[-1, -1, 0], [1, -1, 0], [-1, 1, 0], [1, 1, 0]], IDENTITY, 0, 1, texture, CAMERA_TOP_V);
    gl.enable(gl.BLEND);
    return canvas;
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.tex);
    gl.deleteBuffer(this.buffer);
    gl.deleteProgram(this.program);
  }
}

/** Which texture row of the browser's camera picture is the top of the picture. See `GlPainter.camera`. */
export const CAMERA_TOP_V = 1;

/** A WebGL context an AR session can draw with, on a canvas of its own that is never shown. */
export function createXrGl(canvas: HTMLCanvasElement): GL | null {
  const attrs = { xrCompatible: true, alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false };
  return (canvas.getContext('webgl2', attrs) as WebGL2RenderingContext | null) ?? (canvas.getContext('webgl', attrs) as WebGLRenderingContext | null);
}
