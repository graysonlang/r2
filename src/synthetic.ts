// Procedurally generated test sources — generated at runtime into an ImageData,
// so large (>4K) images can exercise the tiling/memory path without checking in
// a big asset.
//
// High-frequency, deterministic content makes tiling bugs (wrong apron, bad
// region mapping, seam errors) glaringly visible: any discontinuity at a tile
// boundary stands out against the smooth structure. Generating at runtime also
// lets the working-set / memory argument for tiling be exercised at >4K sizes.

const COMPONENTS = 4;

export interface ZonePlateOptions {
  /**
   * Frequency multiplier; higher packs more rings. 1.0 reaches ~Nyquist at the
   * per-tile reference radius. Default 1.0.
   */
  gain?: number;
  /**
   * Number of chirp centers per axis. >1 tiles the zone plate into a grid so
   * dense high-frequency rings cover the whole frame — including every tile
   * boundary, where a resampling seam would otherwise be easy to miss. For the
   * pattern to *actually* tile, the cell period must be an integer number of
   * pixels, so prefer a `tiles` that divides `size` (e.g. powers of two like 4
   * on a 4096 image). Non-dividing counts still render but leave a partial
   * trailing cell rather than a sub-pixel-misaligned (non-tiling) field.
   * Default 4.
   */
  tiles?: number;
}

/**
 * Opaque grayscale tiled zone plate, `size`x`size`. Lays out a grid of radial
 * chirp centers spaced an integer `cellSize` apart; brightness =
 * 0.5 + 0.5*cos(k*r^2) where r is the distance to the nearest chirp center, so
 * frequency rises toward each cell's edges. The repeating centers keep dense
 * high-frequency content everywhere (a stronger tiling / aliasing stress than a
 * single center). The value is continuous across cell boundaries (dx^2 symmetry);
 * the diamond creases there are an expected derivative flip, not a seam.
 */
// Precomputed chirp parameters for a given image size + options, so a per-pixel
// sampler can be evaluated cheaply (and shared between the standalone generator
// and the alpha field).
function zonePlateParams(size: number, opts: ZonePlateOptions = {}) {
  const { gain = 1.0, tiles = 1 } = opts;
  // Integer cell period so the chirp lands on the pixel grid (a non-integer
  // period would not tile). A non-dividing `tiles` leaves a partial last cell.
  const cellSize = Math.max(1, Math.round(size / tiles));
  // Reference radius = half a cell; scale so the chirp hits Nyquist there.
  const km = (gain * Math.PI) / (cellSize / 2);
  return { cellSize, km };
}

// Zone-plate value in [0,1] at pixel (x, y), given precomputed params.
function zonePlateSample(x: number, y: number, cellSize: number, km: number): number {
  const cx = (Math.floor(x / cellSize) + 0.5) * cellSize;
  const cy = (Math.floor(y / cellSize) + 0.5) * cellSize;
  const dx = x - cx;
  const dy = y - cy;
  return 0.5 + 0.5 * Math.cos(km * (dx * dx + dy * dy));
}

export function zonePlate(size: number, opts: ZonePlateOptions = {}): ImageData {
  const data = new Uint8ClampedArray(size * size * COMPONENTS);
  const { cellSize, km } = zonePlateParams(size, opts);

  let p = 0;
  for (let y = 0; y < size; ++y) {
    for (let x = 0; x < size; ++x) {
      const v = Math.round(zonePlateSample(x, y, cellSize, km) * 255);
      data[p++] = v;
      data[p++] = v;
      data[p++] = v;
      data[p++] = 255;
    }
  }
  return new ImageData(data, size, size);
}

// --- Multi-feature target -------------------------------------------------

// A 4x4 grid of distinct features, each filling one cell, so a single image
// exercises a wide variety of frequencies, orientations, hard vs. soft edges,
// color, and alpha simultaneously. This is the better general tiling stress
// test than any single pattern; the cells are seam-prone in different ways.
//
// Each generator returns straight-alpha RGBA in [0,255] for normalized cell
// coordinates u,v in [0,1) plus the pixel pitch (1/cellSize) for frequency
// scaling. `t` is a fixed phase so features aren't all aligned.

type Cell = (u: number, v: number, pitch: number) => [number, number, number, number];

const TAU = Math.PI * 2;

const CELLS: Cell[] = [
  // Horizontal sine sweep: frequency rises left->right.
  (u, _v) => {
    const f = 2 + u * u * 120;
    const g = 0.5 + 0.5 * Math.sin(TAU * f * u);
    const c = Math.round(g * 255);
    return [c, c, c, 255];
  },
  // Vertical sine sweep.
  (_u, v) => {
    const f = 2 + v * v * 120;
    const g = 0.5 + 0.5 * Math.sin(TAU * f * v);
    const c = Math.round(g * 255);
    return [c, c, c, 255];
  },
  // Diagonal sweep (45°) — catches axis-specific bugs the H/V cells miss.
  (u, v) => {
    const d = (u + v) * 0.5;
    const f = 2 + d * d * 120;
    const g = 0.5 + 0.5 * Math.sin(TAU * f * d);
    const c = Math.round(g * 255);
    return [c, c, c, 255];
  },
  // Concentric rings (radial frequency from the cell center).
  (u, v) => {
    const dx = u - 0.5;
    const dy = v - 0.5;
    const g = 0.5 + 0.5 * Math.cos(TAU * 60 * (dx * dx + dy * dy));
    const c = Math.round(g * 255);
    return [c, c, c, 255];
  },
  // Checkerboard, fine pitch — hard edges in both axes.
  (u, v) => {
    const n = 24;
    const on = ((Math.floor(u * n) + Math.floor(v * n)) & 1) === 0;
    const c = on ? 235 : 20;
    return [c, c, c, 255];
  },
  // Vertical hard-edged bars at increasing pitch (square wave, not sine).
  (u, _v) => {
    const period = 0.01 + u * 0.06;
    const on = (u % period) < period * 0.5;
    const c = on ? 245 : 10;
    return [c, c, c, 255];
  },
  // RGB frequency split: each channel a different spatial frequency.
  (u, _v) => {
    const r = 0.5 + 0.5 * Math.sin(TAU * 8 * u);
    const g = 0.5 + 0.5 * Math.sin(TAU * 16 * u);
    const b = 0.5 + 0.5 * Math.sin(TAU * 32 * u);
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), 255];
  },
  // Smooth color gradient (low frequency) — banding / precision check.
  (u, v) => [Math.round(u * 255), Math.round(v * 255), Math.round((1 - u) * 255), 255],
  // Hue wheel — rotating color edges around the cell center.
  (u, v) => {
    const ang = (Math.atan2(v - 0.5, u - 0.5) / TAU + 0.5);
    const [r, g, b] = hsv(ang, 0.9, 0.95);
    return [r, g, b, 255];
  },
  // Diagonal hatch (thin lines) at 30°-ish.
  (u, v) => {
    const s = (u * 3 + v) % 0.08;
    const on = s < 0.02;
    const c = on ? 255 : 40;
    return [c, c, c, 255];
  },
  // Hard alpha cutout: opaque white disc on transparent black (coverage edges).
  (u, v) => {
    const dx = u - 0.5;
    const dy = v - 0.5;
    const inside = dx * dx + dy * dy < 0.18;
    return inside ? [255, 255, 255, 255] : [0, 0, 0, 0];
  },
  // Alpha frequency sweep: opaque color whose alpha ramps with a fine grating.
  (u, _v) => {
    const a = (Math.floor(u * 40) & 1) === 0 ? 255 : 60;
    return [40, 200, 255, a];
  },
  // Dot grid (point features) — small isolated high-frequency spots.
  (u, v) => {
    const n = 16;
    const fx = u * n - Math.floor(u * n) - 0.5;
    const fy = v * n - Math.floor(v * n) - 0.5;
    const on = fx * fx + fy * fy < 0.04;
    const c = on ? 255 : 25;
    return [c, c, c, 255];
  },
  // Pseudo-random value noise (deterministic) — broadband, no structure.
  (u, v, pitch) => {
    const x = Math.round(u / pitch);
    const y = Math.round(v / pitch);
    const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    const c = Math.round((h - Math.floor(h)) * 255);
    return [c, c, c, 255];
  },
  // Concentric color rings.
  (u, v) => {
    const dx = u - 0.5;
    const dy = v - 0.5;
    const r = Math.sqrt(dx * dx + dy * dy);
    const [rr, gg, bb] = hsv((r * 6) % 1, 0.8, 0.95);
    return [rr, gg, bb, 255];
  },
  // Fine 1px-ish grid lines on flat field — classic moiré generator.
  (u, v) => {
    const n = 48;
    const gx = (u * n - Math.floor(u * n)) < 0.12;
    const gy = (v * n - Math.floor(v * n)) < 0.12;
    return (gx || gy) ? [10, 10, 10, 255] : [220, 220, 220, 255];
  },
];

function hsv(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const table: [number, number, number][] = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ];
  const [r, g, b] = table[((i % 6) + 6) % 6];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// Optional global alpha field: given pixel coords (x, y), return straight-alpha
// coverage in [0,255], replacing each cell's own alpha. Used by the alpha variant
// to overlay coverage variation on the exact same RGB content.
type AlphaField = (x: number, y: number) => number;

function renderFeatureGrid(size: number, alphaField?: AlphaField): ImageData {
  const data = new Uint8ClampedArray(size * size * COMPONENTS);
  const cols = 4;
  const rows = 4;
  const cellW = size / cols;
  const cellH = size / rows;
  const pitch = 1 / Math.max(cellW, cellH);

  let p = 0;
  for (let y = 0; y < size; ++y) {
    const cy = Math.min(rows - 1, Math.floor(y / cellH));
    const v = (y - cy * cellH) / cellH;
    for (let x = 0; x < size; ++x) {
      const cx = Math.min(cols - 1, Math.floor(x / cellW));
      const u = (x - cx * cellW) / cellW;
      const cell = CELLS[(cy * cols + cx) % CELLS.length];
      const [r, g, b, a] = cell(u, v, pitch);
      data[p++] = r;
      data[p++] = g;
      data[p++] = b;
      // Variant overrides the cell's alpha with the global field; otherwise keep
      // the cell's own alpha (so plain `featureGrid` is unchanged).
      data[p++] = alphaField ? Math.round(alphaField(x, y)) : a;
    }
  }
  return new ImageData(data, size, size);
}

/**
 * A `size`x`size` multi-feature test image: a 4x4 grid of cells each containing
 * a different frequency/orientation/edge/color/alpha pattern. Designed to
 * surface tiling seams and aliasing across a wide variety of content in one
 * source. Straight-alpha RGBA.
 */
export function featureGrid(size: number): ImageData {
  return renderFeatureGrid(size);
}

/**
 * Like {@link featureGrid} but with a **zone plate as the alpha channel**, masked
 * by an 8x8 grid of cells. The checkerboard's two diagonal cells in each 2x2 block
 * carry the radial chirp coverage (partial), while the other diagonal alternates
 * fully opaque / fully transparent — so every 2x2 region has two partial, one
 * opaque, and one transparent cell. This mixes the smooth low-to-high frequency
 * sweep with hard, tile-aligned coverage edges and genuinely transparent regions
 * (period = size/8, the default tile size at 4096). A rich alpha-aliasing +
 * coverage-edge stress test; pairs with `featureGrid` to A/B coverage handling on
 * identical color.
 */
export function featureGridAlpha(size: number): ImageData {
  const { cellSize, km } = zonePlateParams(size, { tiles: 2 });
  const checker = Math.max(1, Math.round(size / 8)); // 8x8 grid of mask cells
  return renderFeatureGrid(size, (x, y) => {
    const mx = Math.floor(x / checker);
    const my = Math.floor(y / checker);
    if (((mx + my) & 1) === 0) {
      return zonePlateSample(x, y, cellSize, km) * 255; // chirp (partial)
    }
    // The non-chirp diagonal alternates opaque / transparent by column parity.
    return (mx & 1) === 0 ? 0 : 255;
  });
}

export interface SyntheticSource {
  readonly label: string;
  generate(size: number): ImageData;
}

export const SYNTHETIC_SOURCES: Record<string, SyntheticSource> = {
  features: { label: 'Feature grid', generate: featureGrid },
  featuresAlpha: { label: 'Feature grid (alpha)', generate: featureGridAlpha },
  zoneplate: { label: 'Zone plate', generate: zonePlate },
};
