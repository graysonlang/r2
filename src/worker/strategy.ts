// Routing policy: given source + destination dimensions, choose HOW to resize —
// inline on the calling thread, a worker shrink-then-reduce, or the tile pool.
// Pure and unit-tested (scripts/test-strategy.mjs) so the thresholds are explicit
// and the demo + any production caller share one source of truth.
//
// Thresholds are measurement-derived (this session; see tiled-scaler-plan.md
// §10–11 and docs/resampling.md), all on a ~10-core machine:
//   - single-thread whole-image cost ≈ 7ms@512², 30ms@1024², 66ms@1536², 120ms@2048².
//   - TS pool per-resize overhead (source copy + transfer + blit) ≈ 40–80ms.
//   - heavy-downscale shrink-then-reduce wins at ≥4×/axis (1.6×@4×, 2.4×@8×).
//   - tile 256 = sweep winner; workers = hardwareConcurrency.

/** Cost driver: anything at/under this source size resizes inline (no worker). */
export const INLINE_MAX_MPIX = 1.1; // ≈ 1024² → ~30ms single-thread, < pool overhead

/** Downscale ratio (per axis) at/above which shrink-then-reduce is used. */
export const SHRINK_RATIO = 4;

/** Sweep-backed pool tile size. */
export const POOL_TILE = 256;

/**
 * How the resize should be executed.
 * - inline: resizeSeparable on the calling thread — small/cheap
 * - shrink: shrink-then-reduce (resizeThumbnail), heavy downscale
 * - pool:   tile pool, mild downscale on a large source
 */
export type ResizePath = 'inline' | 'shrink' | 'pool';

export interface StrategyInput {
  readonly srcWidth: number;
  readonly srcHeight: number;
  readonly dstWidth: number;
  readonly dstHeight: number;
}

export interface Strategy {
  readonly path: ResizePath;
  /** Tile size for the pool path (0 otherwise). */
  readonly tile: number;
  /** Why this path was chosen (for the demo status line / debugging). */
  readonly reason: string;
}

/**
 * Choose the resize path from dimensions alone. Engine family (TS/Wasm/SAB) is a
 * separate axis the caller pins; this decides inline-vs-shrink-vs-pool.
 *
 * Order matters: heavy downscale wins first (it collapses the source, so the
 * residual is cheap regardless of original size — and shrink-then-reduce should
 * run even on small sources because pure Lanczos plateaus at high ratios). Then
 * the inline cutoff (small/cheap → no worker). Otherwise the pool.
 */
export function chooseStrategy(input: StrategyInput): Strategy {
  const { srcWidth, srcHeight, dstWidth, dstHeight } = input;
  const srcMpix = (srcWidth * srcHeight) / 1e6;
  const ratio = Math.max(srcWidth / dstWidth, srcHeight / dstHeight);

  if (ratio >= SHRINK_RATIO) {
    return { path: 'shrink', tile: 0, reason: `${ratio.toFixed(1)}× ≥ ${SHRINK_RATIO}× → shrink-then-reduce` };
  }
  if (srcMpix <= INLINE_MAX_MPIX) {
    return { path: 'inline', tile: 0, reason: `${srcMpix.toFixed(2)}MP ≤ ${INLINE_MAX_MPIX}MP → inline` };
  }
  return { path: 'pool', tile: POOL_TILE, reason: `${srcMpix.toFixed(2)}MP, ${ratio.toFixed(1)}× → pool ${POOL_TILE}` };
}
