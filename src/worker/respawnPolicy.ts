// High-water-mark respawn policy for a persistent resize worker.
//
// Browsers cannot read RSS live (`process.memoryUsage` is Node-only;
// `measureUserAgentSpecificMemory` is async/heavy/COI-gated), so we cannot sample
// memory per resize in-browser. Instead we use a **work proxy**: the bench
// (`scripts/bench-startup.mjs`, plan §11) measured RSS creep of ~0.6 MB per
// 512²-from-2048² job, i.e. memory grows roughly with cumulative megapixels
// processed. So we budget by total output megapixels since spawn and respawn when
// it crosses a threshold derived from the measured creep + a target RSS ceiling.
//
// This is a pure, unit-testable decision separate from the Worker plumbing.

/** Measured creep, in MB of RSS growth per output megapixel (see plan §11). */
export const MB_PER_OUTPUT_MPIX = 0.6 / (512 * 512 / 1e6); // ≈ 2.29 MB / Mpix

export interface RespawnConfig {
  /**
   * Target RSS growth budget over the worker's life, in MB. When estimated growth
   * (cumulative output Mpix × MB_PER_OUTPUT_MPIX) exceeds this, the worker is
   * recycled to flush. Default 150 MB ≈ the §11 "ready+150" ceiling.
   */
  readonly budgetMB: number;
  /**
   * Hard cap on jobs per worker regardless of size, as a backstop for many tiny
   * resizes (whose per-job fixed overhead the Mpix proxy underweights). 0 = none.
   */
  readonly maxJobs: number;
}

export const DEFAULT_RESPAWN: RespawnConfig = { budgetMB: 150, maxJobs: 0 };

/** Running tally for one worker instance. */
export interface WorkerUsage {
  jobs: number;
  outputMpix: number;
}

export function newUsage(): WorkerUsage {
  return { jobs: 0, outputMpix: 0 };
}

/** Record one completed resize of `dstWidth`×`dstHeight` output pixels. */
export function recordJob(usage: WorkerUsage, dstWidth: number, dstHeight: number): void {
  usage.jobs += 1;
  usage.outputMpix += (dstWidth * dstHeight) / 1e6;
}

/** Estimated RSS growth (MB) this worker has accrued, from the work proxy. */
export function estimatedGrowthMB(usage: WorkerUsage): number {
  return usage.outputMpix * MB_PER_OUTPUT_MPIX;
}

/**
 * Should the worker be recycled BEFORE running the next job? Checked after each
 * completed job so the recycle happens between jobs (never mid-flight). Returns
 * true when the estimated growth exceeds the budget, or the job cap is hit.
 */
export function shouldRespawn(usage: WorkerUsage, config: RespawnConfig): boolean {
  if (config.maxJobs > 0 && usage.jobs >= config.maxJobs) {
    return true;
  }
  return estimatedGrowthMB(usage) >= config.budgetMB;
}
