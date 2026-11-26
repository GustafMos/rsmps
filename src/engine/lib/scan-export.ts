/**
 * Turns a 3D scan (`ScanData`, see scan-data.ts) into the files that standard tools open: a COLMAP text model with the KNOWN camera
 * poses, a nerfstudio / instant-ngp `transforms.json`, a few points from the depth maps, and a README. Pure: no browser, no files.
 *
 * WORLD FRAME. The XR world of the scan, metres, +Y up, MOVED so the scan target's centre is the origin (a translation only: no
 * rotation, no scaling). `scan.json` in the package stays raw (the original XR world); every other file is in this recentred world.
 *
 * CONVENTIONS (all checked by tests that project known points through the written files):
 *  - ScanData / WebXR / OpenGL camera: +X right, +Y up, looks down -Z. `quat` is camera-to-world.  R_gl = matrix of `quat`.
 *  - COLMAP camera: +X right, +Y DOWN, +Z forward (pixel origin top-left, y down).
 *      camera-to-world  R_c2w = R_gl * diag(1, -1, -1)        world-to-camera  R = R_c2wT,   t = -R * C   (C = camera centre in world)
 *      images.txt stores R as the unit quaternion (QW, QX, QY, QZ) and t.   Pixel: u = fx * X / Z + cx, v = fy * Y / Z + cy.
 *  - transforms.json: `transform_matrix` is the 4x4 camera-to-world in the OpenGL camera convention (exactly R_gl and C), row-major.
 */
import { matFromQuat, type Vec3 } from './motion-math';
import { decodeDepth, normalizeScan, type DepthMap, type ScanData, type ScanShot } from './scan-data';

type M3 = [number, number, number, number, number, number, number, number, number];
type Q4 = [number, number, number, number];

/* ------------------------------------------------------------------ poses */

/** World-to-camera rotation (row-major, COLMAP camera axes) of a shot's camera-to-world XR rotation. */
export function colmapRotation(quat: ShotQuat): M3 {
  const g = matFromQuat(quat); // camera-to-world, OpenGL camera axes, row-major
  // R_c2w = g * diag(1,-1,-1): the second and third COLUMN change sign; the world-to-camera rotation is its transpose
  const c: M3 = [g[0], -g[1], -g[2], g[3], -g[4], -g[5], g[6], -g[7], -g[8]];
  return [c[0], c[3], c[6], c[1], c[4], c[7], c[2], c[5], c[8]];
}
type ShotQuat = [number, number, number, number];

/** Unit quaternion (w, x, y, z), w >= 0, of a row-major rotation matrix. */
export function quatWxyz(m: ArrayLike<number>): Q4 {
  const tr = m[0] + m[4] + m[8];
  let w: number, x: number, y: number, z: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4; x = (m[7] - m[5]) / s; y = (m[2] - m[6]) / s; z = (m[3] - m[1]) / s;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    w = (m[7] - m[5]) / s; x = s / 4; y = (m[1] + m[3]) / s; z = (m[2] + m[6]) / s;
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    w = (m[2] - m[6]) / s; x = (m[1] + m[3]) / s; y = s / 4; z = (m[5] + m[7]) / s;
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    w = (m[3] - m[1]) / s; x = (m[2] + m[6]) / s; y = (m[5] + m[7]) / s; z = s / 4;
  }
  const l = Math.hypot(w, x, y, z) || 1;
  return w < 0 ? [-w / l, -x / l, -y / l, -z / l] : [w / l, x / l, y / l, z / l];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** A shot's camera centre in the recentred export world. */
export const exportPos = (scan: Pick<ScanData, 'target'>, shot: Pick<ScanShot, 'pos'>): Vec3 => sub(shot.pos, scan.target.center);

/** Same scan with every shot moved so the target centre is the origin (rotations unchanged). The frame of all files but scan.json. */
export function recentred(scan: ScanData): ScanData {
  return { ...scan, target: { ...scan.target, center: [0, 0, 0] }, shots: scan.shots.map((s) => ({ ...s, pos: exportPos(scan, s) })) };
}

/* ------------------------------------------------------------------ COLMAP */

export interface ExportCamera {
  id: number;
  w: number;
  h: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}
export interface ExportImage {
  id: number;
  name: string;
  /** World-to-camera, COLMAP convention. */
  q: Q4;
  t: Vec3;
  cameraId: number;
}
export interface ExportPoint {
  id: number;
  xyz: Vec3;
  rgb: [number, number, number];
}
export interface ColmapExport {
  cameras: ExportCamera[];
  images: ExportImage[];
  points: ExportPoint[];
}

const f = (v: number): string => String(Object.is(v, -0) ? 0 : v);

/** `0001.jpg`, `0002.jpg`, ... (1-based, in shot order) for a given extension. */
export const imageFileName = (index: number, ext = 'jpg'): string => `${String(index + 1).padStart(4, '0')}.${ext}`;

/**
 * The COLMAP model of a scan: one PINHOLE camera per distinct intrinsics, one image per shot (in shot order, ids from 1, named by
 * `names[i]` or 0001.jpg ...), world = recentred export world. `points` are filled by the caller (see `depthPoints`).
 */
export function colmapExport(scan: ScanData, names?: string[], points: ExportPoint[] = []): ColmapExport {
  const cameras: ExportCamera[] = [];
  const byKey = new Map<string, number>();
  const images: ExportImage[] = scan.shots.map((s, i) => {
    const key = [s.w, s.h, s.fx, s.fy, s.cx, s.cy].map((v) => v.toFixed(4)).join('|');
    let id = byKey.get(key);
    if (!id) {
      id = cameras.length + 1;
      byKey.set(key, id);
      cameras.push({ id, w: s.w, h: s.h, fx: s.fx, fy: s.fy, cx: s.cx, cy: s.cy });
    }
    const R = colmapRotation(s.quat);
    const C = exportPos(scan, s);
    const t: Vec3 = [-(R[0] * C[0] + R[1] * C[1] + R[2] * C[2]), -(R[3] * C[0] + R[4] * C[1] + R[5] * C[2]), -(R[6] * C[0] + R[7] * C[1] + R[8] * C[2])];
    return { id: i + 1, name: names?.[i] ?? imageFileName(i), q: quatWxyz(R), t, cameraId: id };
  });
  return { cameras, images, points };
}

export function camerasTxt(m: ColmapExport): string {
  return [
    '# Camera list with one line of data per camera:',
    '#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]',
    `# Number of cameras: ${m.cameras.length}`,
    ...m.cameras.map((c) => `${c.id} PINHOLE ${c.w} ${c.h} ${f(c.fx)} ${f(c.fy)} ${f(c.cx)} ${f(c.cy)}`),
    '',
  ].join('\n');
}

/** Two lines per image: the pose, then the (empty) list of 2D points. */
export function imagesTxt(m: ColmapExport): string {
  return [
    '# Image list with two lines of data per image:',
    '#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME',
    '#   POINTS2D[] as (X, Y, POINT3D_ID)',
    `# Number of images: ${m.images.length}, mean observations per image: 0`,
    ...m.images.flatMap((im) => [`${im.id} ${im.q.map(f).join(' ')} ${im.t.map(f).join(' ')} ${im.cameraId} ${im.name}`, '']),
  ].join('\n');
}

export function points3dTxt(m: ColmapExport): string {
  return [
    '# 3D point list with one line of data per point:',
    '#   POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[] as (IMAGE_ID, POINT2D_IDX)',
    `# Number of points: ${m.points.length}, mean track length: 0`,
    ...m.points.map((p) => `${p.id} ${p.xyz.map(f).join(' ')} ${p.rgb.join(' ')} 0`),
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ transforms.json */

/** A 4x4 camera-to-world matrix, row-major nested arrays, OpenGL camera axes (the ones nerfstudio and instant-ngp expect). */
export function transformMatrix(scan: ScanData, shot: ScanShot): number[][] {
  const g = matFromQuat(shot.quat);
  const C = exportPos(scan, shot);
  return [
    [g[0], g[1], g[2], C[0]],
    [g[3], g[4], g[5], C[1]],
    [g[6], g[7], g[8], C[2]],
    [0, 0, 0, 1],
  ];
}

/**
 * nerfstudio / instant-ngp transforms. Intrinsics are written at the top when every photo shares them, per frame otherwise.
 * No distortion terms: the phone's pictures are taken as the pinhole the AR view reports.
 */
export function transformsJson(scan: ScanData, names?: string[]): Record<string, unknown> {
  const k = (s: ScanShot) => ({ fl_x: s.fx, fl_y: s.fy, cx: s.cx, cy: s.cy, w: s.w, h: s.h });
  const first = scan.shots[0];
  const same = !!first && scan.shots.every((s) => (['w', 'h', 'fx', 'fy', 'cx', 'cy'] as const).every((key) => Math.abs(s[key] - first[key]) < 1e-4));
  return {
    ...(same ? k(first) : {}),
    frames: scan.shots.map((s, i) => ({ file_path: `images/${names?.[i] ?? imageFileName(i)}`, ...(same ? {} : k(s)), transform_matrix: transformMatrix(scan, s) })),
  };
}

/* ------------------------------------------------------------------ depth -> points */

/**
 * World-space points of a shot's depth map, in the SAME world as the shot (not recentred), following the WebXR depth spec:
 * `normDepthBufferFromNormView` (column-major 4x4) maps normalised view coordinates (origin top-left, y down) to normalised depth-buffer
 * coordinates; the value at a depth-buffer cell times `rawValueToMeters` is the distance along the camera's viewing axis (not along the ray).
 * The picture fills the view (see scan-data.ts), so the view's normalised coordinates are the picture's pixel / (w, h).
 * Every `stride`-th cell is used; cells with value 0 (no measurement) are skipped.
 */
export function backProjectDepth(shot: ScanShot, depth: DepthMap, stride = 1): Vec3[] {
  const m = depth.normDepthBufferFromNormView;
  // 2D part of the matrix (column-major): [x'; y'] = [m0 m4; m1 m5] [x; y] + [m12; m13]. Invert it: depth cell -> view coordinates.
  const det = m[0] * m[5] - m[4] * m[1];
  if (Math.abs(det) < 1e-12) return [];
  const g = matFromQuat(shot.quat);
  const out: Vec3[] = [];
  const st = Math.max(1, Math.round(stride));
  for (let row = 0; row < depth.height; row += st) {
    for (let col = 0; col < depth.width; col += st) {
      const raw = depth.data[row * depth.width + col];
      if (!raw) continue;
      const z = raw * depth.rawValueToMeters; // distance along the viewing axis
      if (!(z > 0.05 && z < 20)) continue;
      const dx = (col + 0.5) / depth.width - m[12];
      const dy = (row + 0.5) / depth.height - m[13];
      const vx = (m[5] * dx - m[4] * dy) / det;
      const vy = (-m[1] * dx + m[0] * dy) / det;
      if (vx < 0 || vx > 1 || vy < 0 || vy > 1) continue;
      const u = vx * shot.w;
      const v = vy * shot.h;
      // camera point with the XR axes (y up, looking down -Z): X = (u-cx)/fx * z, Y = -(v-cy)/fy * z, Z = -z
      const p: Vec3 = [((u - shot.cx) / shot.fx) * z, (-(v - shot.cy) / shot.fy) * z, -z];
      out.push([shot.pos[0] + g[0] * p[0] + g[1] * p[1] + g[2] * p[2], shot.pos[1] + g[3] * p[0] + g[4] * p[1] + g[5] * p[2], shot.pos[2] + g[6] * p[0] + g[7] * p[1] + g[8] * p[2]]);
    }
  }
  return out;
}

export const DEPTH_POINT_SHOTS = 12;
export const DEPTH_POINT_MAX = 20000;

/**
 * A sparse cloud for points3D.txt, from the depth maps of a few shots spread over the scan, in the recentred export world, keeping only
 * points within 1.5 x the target radius of the target centre (the object, not the room). Grey: the pictures are not decoded at export.
 * Empty when no shot carries a usable depth map.
 */
export function depthPoints(scan: ScanData, maxShots = DEPTH_POINT_SHOTS, maxPoints = DEPTH_POINT_MAX): ExportPoint[] {
  const withDepth = scan.shots.flatMap((s) => {
    const d = s.depth ? decodeDepth(s.depth) : null;
    return d ? [{ s, d }] : [];
  });
  if (!withDepth.length) return [];
  const n = Math.min(maxShots, withDepth.length);
  const pick = Array.from({ length: n }, (_, i) => withDepth[Math.floor(((i + 0.5) * withDepth.length) / n)]);
  const limit = scan.target.radius * 1.5;
  const pts: Vec3[] = [];
  const perShot = Math.max(1, Math.floor(maxPoints / n));
  for (const { s, d } of pick) {
    const all = backProjectDepth(s, d, 1).filter((p) => Math.hypot(p[0] - scan.target.center[0], p[1] - scan.target.center[1], p[2] - scan.target.center[2]) <= limit);
    const step = Math.max(1, Math.ceil(all.length / perShot));
    for (let i = 0; i < all.length; i += step) pts.push(all[i]);
  }
  return pts.slice(0, maxPoints).map((p, i) => ({ id: i + 1, xyz: sub(p, scan.target.center), rgb: [128, 128, 128] }));
}

/* ------------------------------------------------------------------ the package */

export interface ScanFiles {
  /** Folder name inside the zip. */
  folder: string;
  /** Text files by path inside the folder (images are added by the caller). */
  text: Record<string, string>;
  /** Image names (inside images/) in shot order. */
  names: string[];
  points: number;
}

/** File name part safe on every system. */
export function safeFolderName(name: string, fallback = '3d-scan'): string {
  const s = name.normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
  return s || fallback;
}

/**
 * Every text file of the dataset. `scan` is the (already normalised) scan to write; `exts[i]` the image extension of shot i.
 * scan.json is the raw scan; everything else is in the recentred world.
 */
export function scanTextFiles(raw: ScanData, opts: { folder?: string; exts?: string[]; withDepth?: boolean } = {}): ScanFiles {
  const scan = normalizeScan(raw);
  const folder = safeFolderName(opts.folder ?? '3d-scan');
  const names = scan.shots.map((_, i) => imageFileName(i, opts.exts?.[i] ?? 'jpg'));
  const pts = opts.withDepth === false ? [] : depthPoints(scan);
  const model = colmapExport(scan, names, pts);
  const text: Record<string, string> = {
    'sparse/0/cameras.txt': camerasTxt(model),
    'sparse/0/images.txt': imagesTxt(model),
    'sparse/0/points3D.txt': points3dTxt(model),
    'transforms.json': JSON.stringify(transformsJson(scan, names), null, 2) + '\n',
    'scan.json': JSON.stringify(scan) + '\n',
    'README.txt': readmeText(scan, model, folder),
  };
  return { folder, text, names, points: pts.length };
}

export function readmeText(scan: ScanData, model: ColmapExport, folder: string): string {
  const cam = model.cameras[0];
  const one = model.cameras.length === 1;
  const params = one ? ` --ImageReader.camera_params "${f(cam.fx)},${f(cam.fy)},${f(cam.cx)},${f(cam.cy)}"` : '';
  const hasPts = model.points.length > 0;
  return `3D SCAN: ${folder}
=====================
EXPERIMENTAL. Made by RSMPS from a scan taken with a phone's AR view: ${model.images.length} photos and, for each one, where the phone
was and which way it looked. Standard tools can use this folder directly.

WHAT IS IN HERE
  images/               the photos, numbered in the order they were taken (original JPEG files, not re-saved)
  sparse/0/             a COLMAP model in TEXT form: cameras.txt (${model.cameras.length} camera${one ? '' : 's'}, PINHOLE), images.txt (the position and direction of every photo),
                        points3D.txt (${hasPts ? `${model.points.length} grey points back-projected from the phone's depth maps (the photo colours are not sampled)` : 'empty: this scan has no depth maps'})
  transforms.json       the same cameras for nerfstudio / instant-ngp style tools (camera-to-world, OpenGL camera axes)
  scan.json             the raw scan as RSMPS stores it. "Load scan file" in RSMPS's 3D Scan panel reads this folder (or its zip) back.

COORDINATES
  Metres. The phone's own world (+Y is up), moved so the middle of the scanned object (the dome you set in the AR view) is at 0, 0, 0.
  Only scan.json keeps the phone's original world. The size is real (metres) up to the phone's tracking accuracy, which is good but
  not perfect: drift of a centimetre or two over a walk round an object is normal.
  COLMAP camera axes: +X right, +Y down, +Z forward; images.txt holds world-to-camera (QW QX QY QZ, TX TY TZ).
  transforms.json camera axes: +X right, +Y up, looking down -Z; transform_matrix is camera-to-world.
  The photos are undistorted-by-assumption: no lens distortion is stored (the phone's AR view gives none).

OPTION A: COLMAP WITH THE KNOWN POSITIONS (recommended)
  The phone's positions are used as they are; COLMAP only finds matching points between photos and triangulates them.
  Run these in this folder (COLMAP 3.x command line; "colmap" must be on your path):

    colmap feature_extractor --database_path database.db --image_path images --ImageReader.camera_model PINHOLE --ImageReader.single_camera ${one ? 1 : 0}${params}
    colmap exhaustive_matcher --database_path database.db
    mkdir sparse\\triangulated        (on Linux and Mac: mkdir -p sparse/triangulated)
    colmap point_triangulator --database_path database.db --image_path images --input_path sparse/0 --output_path sparse/triangulated

  Optional, to correct small errors in the phone's positions (slower):

    colmap bundle_adjuster --input_path sparse/triangulated --output_path sparse/refined

  The result in sparse/triangulated (or sparse/refined) has real points seen by several photos. For a trainer, either point it at that
  model or copy its cameras.bin, images.bin and points3D.bin into sparse/0 (replace the text files there).
  The spatial matcher is not used: it needs GPS positions stored in the database, which phone AR scans do not have.
  If point_triangulator ends with very few points, the saved positions did not fit the photos (a bad scan or tracking that drifted):
  solve the photos from scratch instead with  colmap automatic_reconstructor --workspace_path work --image_path images

OPTION B: A SPLAT TRAINER
  Brush (https://github.com/ArthurBrussee/brush): point it at this folder; it reads a COLMAP dataset (images/ and sparse/) or a transforms.json:
    brush .
  nerfstudio (splatfacto): the folder has a transforms.json, so
    ns-train splatfacto --data .
  gsplat's example trainer (examples/simple_trainer.py) reads a COLMAP dataset (images/ and sparse/0):
    python simple_trainer.py default --data_dir . --result_dir results
  Options and file expectations change between versions: if a tool complains, check its own help (the layout here is the common one:
  images/ + sparse/0 for COLMAP style, images/ + transforms.json for nerfstudio style).
  Trainers work best with a model from Option A step 3 (real points); with only the depth points here they still run, but start rougher.

IN RSMPS (desktop app)
  Splat from Video can take the 3D Scan directly and does the steps of Option A for you, then trains. See docs/SPLATS.md, "From a 3D Scan".

Scan: ${model.images.length} photos, target radius ${scan.target.radius.toFixed(2)} m, ${scan.shots.filter((s) => s.depth).length} with depth.
`;
}

/* ------------------------------------------------------------------ for the desktop pipeline */

/**
 * The COLMAP text model (cameras.txt and images.txt) of a scan for photos that were sent at other pixel sizes than the stored stills
 * (`sizes[i]` = the real size of photo i): every shot's intrinsics and size are scaled to it. Image names are `names[i]`.
 * World = the recentred export world, like the zip. Used by Splat from Video to triangulate with the saved camera positions.
 */
export function colmapTextForSizes(raw: ScanData, sizes: { width: number; height: number }[], names: string[]): { cameras: string; images: string } {
  const scan = normalizeScan(raw);
  const shots = scan.shots.map((s, i) => {
    const z = sizes[i] ?? { width: s.w, height: s.h };
    const sx = z.width / s.w;
    const sy = z.height / s.h;
    return { ...s, w: z.width, h: z.height, fx: s.fx * sx, fy: s.fy * sy, cx: s.cx * sx, cy: s.cy * sy };
  });
  const m = colmapExport({ ...scan, shots }, names);
  return { cameras: camerasTxt(m), images: imagesTxt(m) };
}
