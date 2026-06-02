# Tiled, Worker-Based Image Scaling System — Implementation Plan

A clean-room reference design for a web-based, gamma-correct, tiled image scaler
with a worker pool. Intended as a structure to profile against, not a drop-in
replacement for a working implementation.

## Scope and assumptions

- **Input:** `ImageBitmap` objects.
- **Pixel formats:** gamma-encoded (sRGB) interleaved integer data — greyscale (1 ch),
  RGB (3 ch), RGBA (4 ch), 8 bits per channel to start.
- **Output:** same logical format as input, straight (unassociated) alpha, 8-bit sRGB,
  emitted as a transferable buffer.
- **Resampling:** separable filter, performed in **linear light**, **coverage-weighted**
  for the alpha-bearing case, with an **inline sharpen/soften** stage folded into the
  vertical pass.
- **Accumulator:** higher-bit-depth internal representation (f32) throughout the
  linear-light section.
- **Tiling:** tile size is a runtime parameter so it can be swept for cache-coherence
  profiling.
- **Parallelism:** a warm pool of workers, each self-contained (straight-in / straight-out),
  fed tiles by a scheduler on the main thread.

Non-goals for v1: >8-bit input, planar formats, arbitrary color-management beyond sRGB↔linear,
GPU offload. All are noted as extension points.

---

## Implementation status (annotated 2026-05-31)

This plan is the Phase-3 target. Phases 1–2 (TypeScript demo) are built and validated;
the decisions below are locked in and should carry into the worker/Wasm port.

- **Resampler exists in two forms.** `src/resize.ts` is a fused single-pass area (box)
  resampler — the bit-stable **oracle**. `src/separable.ts` is the general two-pass
  weight-table form with selectable kernels (box / triangle / Mitchell / Lanczos-2 /
  Lanczos-3). The separable module is deliberately written in the
  **independent-output** form this plan assumes, so the Wasm/SIMD kernel is a
  transcription of its structure, not a redesign.
- **Default kernel: Lanczos-2** (`r_filter = 2`), chosen after side-by-side evaluation —
  best acutance-vs-ringing balance across content/scales, and the cheaper Lanczos for
  the SIMD tap loop. See `docs/resampling.md` and the kernel-choice memory note.
- **Alpha (coverage-weighted) and edge policy are decided and tested** — see the
  hardened notes in the spec (`tiled-scaler-spec.md` §5.4–5.5). Edge = out-of-bounds
  weight 0 + renormalize (NOT zero-alpha-outside; the Photoshop PNG-frame bug). Clamp in
  the premultiplied domain. `scripts/test-alpha.mjs` guards both across every kernel
  (33 checks, wired to `npm test`).
- **Sharpen is no longer a quality requirement.** The unsharp pass in the fused box
  path (`sharpeningCoefficient`, default 0) was synthesizing the negative lobes the box
  lacks; Lanczos-2 has those lobes natively, so a crisp default downscale needs no
  separate sharpen stage. A *tunable* sharpen/soften amount (esp. the soften direction a
  fixed kernel can't do) remains a possible creative control, but it is
  **optional/deferred**, not on the critical path. Consequence: the dedicated sharpen
  apron (§4.5) goes away; only the resample-support apron (§2.2, inherent to L2's radius)
  remains.
- **Reference background:** `docs/resampling.md` covers the filter comparison, the
  unsharp ≈ synthesized-negative-lobes framing, the separable structure, and the SIMD
  analysis (f32x4-per-RGBA, no-gather LUT caveat, why the fused box's carry-over is
  serial while the separable form is vector/tile-parallel).
- **Worker exists, with two engines.** `src/worker/{protocol,client,resizeWorker}.ts` —
  typed message protocol (`ready` handshake, transferable-buffer round-trip, `engine`
  + `tileSize` params). `ResizeClient` is the main-thread client. The worker runs either
  the **TS** resampler (`resizeSeparable` / `resizeSeparableTiled`) or the **Wasm**
  kernel, selected per request. The interactive demo (`app/main.ts`) coalesces slider
  requests, but that is a **demo-only** UI affordance, not part of the resize contract —
  the real import flow resizes each asset once.
- **Tiled-in-worker done.** `resizeSeparableTiled` runs in the worker with a configurable
  tile size (demo Tile control, default 256), bit-identical to whole-image. Large
  synthetic sources (`src/synthetic.ts`: tiled zone plate + feature grid, generated at
  runtime up to 8192²) exercise the tiling/working-set path without checked-in assets.
- **Wasm kernel: scalar port done + wired + browser-verified.** `src/wasm/resize.c` is a
  close transcription of `separable.ts` (double accumulators), compiled by esp's emcc
  plugin with `SINGLE_FILE=1` so the wasm is embedded in the worker bundle (no separate
  fetch). `scripts/test-wasm.mjs` tolerance-compares it to the TS oracle (spec §8): all
  kernels × coverage × scales agree at **maxDiff 0** today (the ≤1 LSB budget is reserved
  for SIMD). Confirmed instantiating and resizing **inside a real Worker** via headless
  Chrome (the one seam Node can't test). `npm run build:wasm` / `npm run test:wasm`.
  **Next: SIMD** (`f32x4`-per-RGBA, `-msimd128`) — the `--simd` flag is already plumbed in
  `scripts/build-wasm.mjs`; this is where float-vs-double divergence (and the ≤1 LSB
  tolerance) starts to matter, and where Wasm should pull ahead of the near-parity TS path.
- **Cancellation (Wasm, TODO).** The real worker must support **user-abort of an
  in-flight resize** — a finer mechanism than the per-drop `terminate()` (§7.1), which
  only reclaims at batch boundaries. Add a `cancel` message to the protocol; the Wasm
  kernel needs an interruption point (e.g. check an abort flag between tiles/rows). Not
  needed by the current TS demo (resizes are fast and coalesced), so deferred to the
  Wasm port — but it is a hard requirement there, not optional.

---

## 1. Architecture overview

```
main thread                                worker (×N, warm pool)
-----------                                ----------------------
ImageBitmap                                
  │                                        
  ├─ decode to ImageData (OffscreenCanvas) 
  │     → straight sRGB 8-bit interleaved  
  │                                        
  ├─ compute tiling plan (output-space)    
  │     → list of output tile rects        
  │                                        
  ├─ for each tile: postMessage(job)  ───▶  receive job (src region + params)
  │     transfer src sub-buffer or          │
  │     SharedArrayBuffer view              ├─ sRGB→linear (LUT)
  │                                         ├─ horizontal resample (f32 accum)
  │                                         ├─ vertical resample (f32 accum)
  │                                         ├─ inline sharpen/soften
  │                                         ├─ linear→sRGB (+ round/dither)
  │                                         └─ un-premul / normalize → straight
  │                                        
  └─ receive tile result  ◀──────────────  postMessage(result), transfer buffer
        write into output buffer            
        resolve when all tiles done         
```

Key boundary contract: **the buffer crossing every postMessage is straight-alpha,
sRGB, 8-bit.** All linear-light and coverage math is internal to the worker. This keeps
the worker a pure "give me pixels, get smaller pixels" unit and keeps storage (PNG) and
GPU-ingest paths able to consume worker output directly.

---

## 2. Coordinate model and tiling

The resample is defined in **output space**: each output pixel maps back to a region of
input space through the filter's support. Tiling is therefore planned over the **output**
image, and each output tile pulls the input rows/columns its support touches.

### 2.1 Scale ratios and filter support

For a separable filter with base radius `r` (in output-normalized units) and scale factor
`s = out_dim / in_dim` per axis (default kernel Lanczos-2, `r = 2`; box `r = 0.5`):

- **Downscale (`s < 1`):** the filter is stretched in *input* space; support radius in
  input pixels is `r / s`. This is the antialiasing case — the kernel widens to average
  more source pixels.
- **Upscale (`s > 1`):** support radius in input pixels is `r` (kernel not stretched);
  interpolation case.

Define, per axis:

```
support_in = ceil(r_filter / min(s, 1))   // input pixels each output sample reads
```

### 2.2 Output tiles → input regions

For an output tile covering output rows `[oy0, oy1)` and cols `[ox0, ox1)`:

```
// map output extent back to input center positions
in_center_y(oy) = (oy + 0.5) / s_y - 0.5
iy0 = floor(in_center_y(oy0)      - support_in_y)
iy1 = ceil (in_center_y(oy1 - 1)  + support_in_y) + 1   // exclusive
// (same for x)
```

The worker is handed the **input sub-region** `[iy0, iy1) × [ix0, ix1)` (clamped to image
bounds, with edge handling per §4.4) plus the output tile rect. Output tiles are disjoint,
so writes never contend; input regions overlap at tile seams, which is fine because reads
are read-only.

### 2.3 Tile size as a profiling parameter

Tile size is a `{ tileW, tileH }` parameter on the job plan. Considerations for the sweep:

- The worker's working set per tile is roughly:
  `(input_region_area + output_tile_area) × channels × 4 bytes (f32)`
  plus the two 8-bit buffers. For cache coherence you want this to fit comfortably in L2.
- Because support widens on downscale, the *input* region for a fixed output tile grows as
  the scale factor shrinks. The profiler should sweep tile size **per scale regime**, not
  once globally.
- Tall-thin vs. square tiles interact with the separable pass order (horizontal pass is
  row-friendly; see §4.1). Expose `tileW`/`tileH` independently so the sweep can find the
  anisotropy that suits the memory layout.

Suggested sweep grid to start: tileW ∈ {64, 128, 256, 512}, tileH ∈ {16, 32, 64, 128},
times the scale regimes you care about. Record wall-time and (if available) derive
throughput in Mpix/s of *output*.

---

## 3. Worker pool and scheduling

### 3.1 Pool lifecycle

- Spawn `navigator.hardwareConcurrency` workers (or a configured cap) **once**, at module
  init, before any image arrives. Workers have no heavy runtime init (unlike a wasm module),
  so warming cost is just thread creation — but a persistent pool still avoids per-image
  spawn latency and lets you reuse allocated scratch buffers (§3.3).
- Each worker posts a `ready` message after its message handler is installed. The main
  thread does not dispatch jobs to a worker until it has signalled ready. This avoids the
  top-level-await / dropped-message race that bites worker+module startup.

### 3.2 Dispatch strategy

- Maintain a queue of tile jobs and a set of idle workers. On `ready` or on `result`,
  pull the next job and dispatch. This is simple work-stealing-by-pull and naturally
  load-balances uneven tile costs (edge tiles with clamping can differ from interior).
- One image = many tiles = many jobs. A single `Promise` resolves when the tile-completion
  count equals the plan's tile count. Reassemble tiles into the output buffer as results
  arrive (each result carries its output rect).

### 3.3 Buffer strategy (the part that decides whether parallelism pays off)

Two viable models:

1. **Transferable per job.** Slice the input sub-region into its own `ArrayBuffer`, transfer
   ownership to the worker, worker transfers the output tile back. Zero-copy across the
   boundary but you pay to *extract* the sub-region (a strided copy) on the main thread.
2. **`SharedArrayBuffer` for the source.** Put the whole decoded source in a SAB; workers
   read their region directly with no extraction and no transfer. Output tiles still come
   back as transferables (or are written into a second shared output SAB at the tile's
   offset). This avoids the strided extraction entirely and is usually the better choice
   for many-tile images.
   - Requires cross-origin isolation (`COOP`/`COEP` headers). If you can't set those, fall
     back to model 1.
   - With a shared **output** SAB, workers write disjoint tile rects directly — no result
     copy at all. This is the fastest path; just ensure rects are truly disjoint (they are,
     by construction) so no atomics are needed for the pixel writes.

Reuse per-worker f32 scratch buffers across jobs (size to the largest tile in the plan)
to avoid reallocating every tile.

---

## 4. The resampling kernel (inside the worker)

All steps operate on the input sub-region and produce the output tile.

### 4.1 Pass order

Separable resampling is two 1-D passes. Order them to favor memory locality:

1. **Horizontal pass:** resample input region width → output tile width, keeping full input
   region height. Reads along rows (contiguous in interleaved layout) → cache-friendly.
   Produces an intermediate buffer `[in_region_h × out_tile_w × ch]` in **f32 linear**.
2. **Vertical pass:** resample that intermediate's height → output tile height. Reads down
   columns of the intermediate; keep the intermediate row-major and accept the strided read,
   or transpose during pass 1 so pass 2 is also row-contiguous (worth profiling — the
   transpose trades a write pattern for a read pattern).

Doing horizontal first when downscaling also shrinks the buffer the vertical pass walks.

### 4.2 Linearization (sRGB → linear)

At ingest into the f32 accumulator, convert each **color** channel sRGB→linear. Alpha is
**not** gamma-encoded — never linearize it.

- For 8-bit input, use a **256-entry LUT** (`Float32Array(256)`) of the sRGB→linear
  transfer function. Exact, branch-free, and trivially cache-resident.
- Greyscale: the single channel is color → linearize it.
- RGB: linearize all three.
- RGBA: linearize R,G,B; leave A linear-as-is (it's coverage, already linear).

### 4.3 Coverage-weighted accumulation (the alpha path)

For the alpha-bearing format, accumulate color **weighted by alpha** so transparent pixels
contribute no color (this is the implicit-premultiply approach — correct and one fewer pass
than materializing a premultiplied buffer):

Per output sample, over contributing input samples `i` with filter weights `w_i`:

```
num_rgb = Σ (w_i · a_i · linear_rgb_i)     // alpha-weighted color, linear
den_a   = Σ (w_i · a_i)                    // for normalizing color
sum_w   = Σ (w_i)                          // for normalizing alpha (coverage)

out_a   = clamp(den_a is over sum_w? ...)  // alpha normalized by Σw_i, NOT den_a
out_rgb = den_a > epsilon ? num_rgb / den_a : 0   // guarded un-premultiply
```

Two distinct denominators — color divides by `den_a` (alpha-weighted), alpha divides by
`sum_w` (plain weights). Mixing these up is a classic subtle bug.

- **Degenerate pixel:** when `den_a ≤ epsilon`, emit transparent black (rgb = 0, a = 0).
  Choose `epsilon` purely as a numerical floor for the divide (tiny — sized to f32
  conditioning), *not* as a perceptual cutoff, so you don't erode soft low-alpha edges.
  Excluding `a_i == 0` samples from accumulation entirely is equivalent and avoids the
  question for exact-zero pixels.
- **Non-alpha formats (grey, RGB):** no coverage weighting; `out = Σ(w_i · linear_i) / Σw_i`.

### 4.4 Edge handling

When the support window runs off the image edge, pick one policy and apply it consistently
in both passes:

- **Clamp-to-edge** (replicate boundary pixel) is the usual default — simple, no darkening.
- Renormalize by the *actual* weights used (`Σ w_i` over in-bounds samples only) so the
  edge isn't dimmed by missing contributions. This pairs naturally with clamp.

Document the choice; it affects a 1–2 px border and is easy to regress.

### 4.5 Inline sharpen / soften

Fold this into the **vertical pass output stage**, while data is still f32 linear, before
the linear→sRGB encode. Two common formulations:

- **Unsharp mask:** `out = lerp(blurred, sharp, amount)` where `amount > 1` sharpens,
  `< 1` softens, `= 1` is identity. Needs a blurred version of the resampled result.
- **Convolution tap:** a small 3×3 (or separable 1-D) kernel applied to the resampled
  output. Cheaper to fold inline because the vertical pass already has a column of
  neighbors in registers/cache.

Doing it inline, in linear light, before encoding, is the correct-color choice — sharpening
in sRGB has the same gamma error class as resizing in sRGB. Keep `amount`/`radius` as job
params so they can be tuned (and profiled) independently of scale.

> Note the seam interaction: an inline spatial sharpen reads neighbors, so a tile needs a
> small **apron** of already-resampled output beyond its own rect to sharpen its border
> rows/cols without seams. Either (a) expand the input region so the tile can produce its
> apron internally, or (b) sharpen as a separate full-image pass after reassembly. Option
> (a) keeps everything in-worker and seam-free at the cost of a slightly larger input
> region; option (b) is simpler but adds a pass. Recommend (a) for v1, with the apron width
> = sharpen radius mapped back through the scale.

### 4.6 Encode (linear → sRGB) and quantize

- Convert color channels linear→sRGB. A LUT is harder here (linear domain is continuous),
  so either compute the transfer function directly or use a fine LUT (e.g. 4096-entry)
  indexed by quantized linear value with interpolation. Direct compute is fine to start.
- Quantize f32 → 8-bit with **rounding** (`+0.5` then floor / `Math.round`), not truncation.
- Optional: ordered or error-diffusion **dither** before quantizing to avoid banding on
  smooth gradients. Worth it for greyscale especially. Keep behind a flag.
- Alpha: quantize linearly (no transfer function), with rounding.

---

## 5. Format handling

Channel count drives three things: linearize-which-channels, whether coverage weighting
applies, and stride. Parameterize by `channels ∈ {1,3,4}`:

| channels | meaning | linearize | coverage-weight | notes |
|---|---|---|---|---|
| 1 | grey | the 1 channel | no | simplest path |
| 3 | RGB | all 3 | no | normalize by Σw |
| 4 | RGBA | R,G,B only | yes (by A) | two denominators (§4.3) |

`ImageBitmap` decoded via `OffscreenCanvas.getImageData` always yields RGBA8; if the source
is logically grey or RGB you can either carry it as RGBA (simplest, alpha = 255) or compact
to the true channel count after decode to shrink the working set. For v1, decoding to RGBA
and treating grey/RGB as "alpha known-opaque" lets the coverage path be a no-op (every
`a_i = 1`, `den_a = sum_w`, division is exact) — fewer code paths, and the profiler tells
you whether the compaction is worth it.

---

## 6. Decode path (main thread)

```js
// ImageBitmap → straight sRGB RGBA8 ImageData
const oc = new OffscreenCanvas(bmp.width, bmp.height);
const ctx = oc.getContext('2d', { alpha: true, colorSpace: 'srgb' });
ctx.drawImage(bmp, 0, 0);
const src = ctx.getImageData(0, 0, bmp.width, bmp.height); // Uint8ClampedArray, straight alpha
```

Caveats to verify on your target browsers:
- `getImageData` returns **straight** (un-premultiplied) alpha per spec — good, matches the
  worker contract.
- Round-tripping through canvas can perturb fully-transparent pixels' RGB (the spec allows
  it). Since the worker treats `a == 0` as no-contribution, this is harmless here.
- Set `colorSpace: 'srgb'` explicitly; if you later support Display-P3 sources this is the
  hook where color management enters.

---

## 7. Validation and profiling

### 7.1 Correctness checks (before optimizing)

- **Gradient round-trip:** a linear ramp resized 1:1 should come back unchanged within
  rounding; confirms LUTs and encode are inverse.
- **Alpha fringe test:** opaque white shape on transparent-black background, downscaled 4×.
  Inspect edge pixels — coverage weighting should show *no* dark halo. Compare against a
  deliberately-broken straight-alpha resample to confirm the test detects fringing.
- **Degenerate region:** fully transparent tile → output rgb all 0, a all 0, no NaN/Inf.
- **Edge policy:** flat-color image resized down should have no darkened border.
- **Greyscale vs. RGB parity:** grey image promoted to RGB should match per-channel.

### 7.2 Profiling harness

- Sweep `{tileW, tileH}` × scale-regime as in §2.3; record output Mpix/s and variance.
- Compare buffer strategies (§3.3): transferable-extract vs. SAB-shared-source vs.
  SAB-shared-output. Expect SAB to win as tile count grows.
- Sweep worker count around `hardwareConcurrency` (over-subscription sometimes helps hide
  per-tile dispatch latency; sometimes hurts via cache thrash).
- Measure the transpose-in-pass-1 variant (§4.1) against strided vertical reads.

### 7.3 Metrics to log per run

tile dimensions, scale factor, channel count, buffer strategy, worker count, total wall
time, output Mpix/s, and ideally a cache-miss proxy if you have access to it (otherwise
wall time at fixed work is the practical signal).

---

## 8. Extension points (post-v1)

- **>8-bit input:** replace the 256-entry sRGB→linear LUT with direct compute or a larger
  LUT; accumulator is already f32 so no structural change.
- **Linear-compositing handoff:** if downstream Three.js moves to linear compositing, the
  worker output stays straight sRGB (correct interchange); the *premultiply* and the
  sRGB→linear for compositing move to texture ingest. The worker doesn't change — this is
  the payoff of the straight-everywhere contract.
- **Planar formats / SIMD:** the inner accumulation loop is the SIMD target. Wasm SIMD on a
  single channel-count specialization is tractable; planar layout makes vectorization
  cleaner than interleaved.
- **Wider transfer functions / color management:** the linearize/encode stages are the only
  color-aware code; swapping sRGB for a managed transform is localized there.

---

## 9. Suggested build order

1. Single-threaded, whole-image (no tiling), RGBA-only, linear resample with coverage —
   get correctness (§7.1) green first.  ✅ **DONE** — `src/separable.ts` (whole-image,
   coverage-weighted, all kernels); alpha + edge cases verified in `scripts/test-alpha.mjs`.
2. ~~Add the inline sharpen/soften with the apron (§4.5).~~  ⊘ **DESCOPED** — Lanczos-2's
   negative lobes supply the acutance the box+unsharp combo was synthesizing, so sharpen
   is no longer needed for default quality. A tunable sharpen/soften control is optional
   and deferred (a `src/resize.ts` unsharp prototype exists if revived). Dropping the
   separate sharpen pass also drops its dedicated apron — only the resample-support apron
   (§2.2) remains, and that is needed for L2 regardless.
3. Add tiling (output-space plan, input-region mapping) still single-threaded — verify
   tiles reassemble seam-free and match the whole-image result exactly.  ✅ **DONE** —
   `resizeSeparableTiled` shares the H/V passes with the whole-image path via the same
   global weight tables, so bit-identity is structural; `scripts/test-alpha.mjs` proves
   it across every kernel × coverage × 6 tile sizes (incl. 1×1, non-dividing, oversized).
   The only apron is the resample-support input region (§2.2). Also runs in the worker
   with a tile-size control.
4. Add the worker pool + ready handshake, transferable strategy first (§3.1–3.3).
   ✅ **DONE** — source-resident persistent pool (`src/worker/{pool,tileWorker,
   tileProtocol}.ts`): each worker gets a source copy via `init`, then pulls
   output-tile jobs (idle-pull work-stealing) built from `prepareTiling` /
   `resizeTileRegion`, main thread blits results. Reassembly is bit-identical to
   the oracle (`scripts/test-alpha.mjs` pool-reassembly checks). Browser-verified:
   **~3× over single-thread TS** on 4096²→2662² (8 workers; 187ms vs 556ms), and
   it beats the Wasm single-worker (354ms) despite running the *slower* TS kernel
   — parallelism > per-tile kernel gain. Demo "TS pool" engine. (Header-free; SAB
   path is step 5.)
5. Add SAB strategies; run the profiling sweep (§7).  ✅ **DONE** — shared source +
   shared output (`src/worker/{sabProtocol,sabWorker,sabPool}.ts`,
   `resizeTileRegionInto` writes tiles in place): no per-worker source copy, no
   per-tile transfer, no main-thread blit. Needs cross-origin isolation — opt-in
   `--cross-origin-isolation` flag on esp's proxy (`npm run dev:sab`) + standalone
   `scripts/serve-sab.mjs`. `SabResizePool.isSupported()` gates the demo "SAB pool".
   **Instrumented profiling sweep** (`app/bench.{ts,html}`, `scripts/run-bench.mjs`;
   phase timings via `PoolTimings`): see "Profiling sweep results" below. Net:
   SAB ~104ms vs best TS-pool ~138ms (**~25%**), the win is almost entirely in
   `staging` (TS 37–81ms of source copies, scaling with worker count; SAB ~5ms flat).
   Best config: **256–512 tile, workers = hardwareConcurrency**. (RSS-over-time and
   the file-decode `ImageBitmap`-in-worker measurement, §7.4, are still open — the
   latter belongs on the single disposable-worker path, not the pool.)
6. Add grey/RGB specializations and the optional compaction.
7. SIMD-specialize the hot accumulation loop once the layout is settled.  ✅ **DONE** —
   scalar + SIMD Wasm (`src/wasm/resize.c`, f32x4-per-RGBA, `-msimd128`),
   tolerance-verified vs the TS oracle. ~1.9× over TS after pre-linearizing to
   contiguous f32 (the gather was the blocker); transpose tried and reverted
   (strided writes > strided reads). The kernel also exposes a source-resident
   tile API (`resize_init`/`resize_tile`/`resize_free`, `WasmTileContext`) wired
   behind the pool as the **Wasm pool** engine. Browser-measured, **averaged**
   (4096²→2662², tile 512, 8 workers, drop cold run): TS pool ~151ms vs Wasm pool
   ~143ms — **effectively tied** (~5%, within noise; mins 141ms both). At the pool
   level the kernel is NOT the bottleneck: both are capped by the same per-image
   overhead (8× source copy on init, tile transfers, main-thread blit +
   getImageData). (An earlier single-shot measurement wrongly suggested ~1.5×;
   averaged runs corrected it.) Also fixed a regression here — `resize_init` was
   pre-linearizing the WHOLE image per worker (268 MB × 8 at 4096² f32); now
   `resize_tile` pre-linearizes only its apron band (tile-bounded). The shared
   overhead is the Amdahl ceiling that **step 5 (SAB)** targets. See
   `docs/resampling.md`.

Getting steps 1–3 exactly matching each other (whole-image vs. tiled producing
bit-identical output) is the single most valuable checkpoint — it isolates resampling
correctness from concurrency before any parallelism is introduced.

---

## 10. Profiling sweep results (2026-06-01)

Instrumented headless sweep (`app/bench.{ts,html}` + `scripts/run-bench.mjs`),
4096²→2662², lanczos2, 10-core machine, 6 runs (drop 2), phase timings via
`PoolTimings`. `staging` = plan + source delivery + init dispatch; `parallel` =
first dispatch → last tile; `blit` = main-thread pixel copy within that window.

```
engine     tile  wk  total  staging parallel blit  tiles
sab-pool    256  10   104.4     5.4     96.9   2.1   121   ← best
sab-pool    512  10   106.8     5.4     99.2   2.3    36
sab-pool   1024  10   119.8     5.3    112.1   2.3     9
pool        512  10   138.3    37.3    101.0   4.8    36   ← best TS
pool        256  10   141.1    39.1    102.0   5.3   121
pool       1024  10   150.9    36.9    114.0   3.8     9
pool        512  20   180.5    75.2    105.3   5.5    36   (oversubscribed)
```

Findings:
- **SAB ~25% faster** (104 vs 138ms), and the gap is **almost entirely `staging`**:
  TS pool spends 37–81ms copying the source per worker (`src.data.slice()` ×N), and
  it **grows with worker count**; SAB shares one source → ~5ms flat. This is the
  data-movement floor earlier single-shot runs couldn't resolve (they wrongly showed
  a near-tie). `blit` is tiny either way (~2–5ms) — transferables were already
  zero-copy, so SAB's no-transfer benefit is minor; the source-copy elimination is
  the real prize.
- **Tile size: 256 ≈ 512 > 1024.** Bigger tiles raise `parallel` (1024: 112–152ms
  vs 97 for 256) — redundant horizontal-apron recompute on overlapping input rows,
  and worse load balance (9 tiles / N workers). 1024 only ever helped by shrinking
  TS `staging`, which SAB solves directly. (Corrects an earlier impression that 1024
  felt faster — that was noisy totals, not instrumented phases.)
- **Workers = hardwareConcurrency** is the sweet spot; oversubscription (2×) hurts TS
  (staging doubles) and doesn't help SAB.

**Decision input:** fastest config is **SAB pool, 256–512 tile, workers = cores**
(~104ms). The tradeoff vs. **TS pool, 512, cores** (~138ms): ~25% throughput for a
cross-origin-isolation (COOP/COEP) server requirement. Per the simplicity priority,
TS pool is the zero-config default; SAB is the opt-in fast path where headers are
available. Kernel language is settled separately (TS primary; Wasm ~1.5× flat,
SIMD-inert — see `docs/resampling.md`).

---

## 11. Startup + memory (2026-06-01) — the axis that actually matters

Reframed by the real goal: this replaces a **long-lived server-side resize
service whose problem is RSS creep / fragmentation**, fronted by network latency.
So speed was never the binding constraint (we already beat a network round-trip);
**flat peak memory over an unbounded session** is. The model that wins is a
persistent local worker with a **high-water-mark terminate+respawn** to flush —
trading a known warming cost against a bounded memory ceiling.

Measured the warming + memory cost of the local worker path (`scripts/
bench-startup.mjs`, `npm run bench:startup`; Node worker_threads, real RSS),
2048²→512², 200 jobs/worker, lanczos2:

```
                  TS        Wasm
spawn → ready     12.1ms    12.3ms
cold first resize 64.8ms    90.2ms
warm resize       59.5ms    22.2ms
cold tax          1.1x      4.1x
RSS at ready      57 MB     182 MB
RSS high-water    181 MB    316 MB   (both creep ~125-135 MB / 200 jobs)
wasm linear        —        97 MB    (only ratchets; dies on terminate)
```

Findings → **TS in a persistent worker is the design**, on every axis that matters
here:
- **Warming is cheap**: ~12ms spawn+instantiate either engine → respawn is
  negligible vs a network hop. Flush freely.
- **Cold tax is lopsided**: TS 1.1× (V8 baseline tier is fine; the "TS always
  suffers from JIT warmup" worry is small), Wasm 4.1×. For a disposable/short-lived
  worker TS actually WINS cold (65 vs 90ms first call); Wasm's warm 2.7× edge only
  pays off if the worker survives to amortize its 90ms first call.
- **Memory favors TS hard**: ~125 MB lower at every point (no f32 linear arena).
  For the low-footprint goal, TS is the clean profile.
- **Respawn trigger**: creep ≈ 0.6 MB/job; pick a ceiling (~ready+150 MB ≈ 200 MB)
  and respawn when RSS crosses it — costs ~12ms + 1 cold resize (~77ms) to reset to
  ~57 MB. Wasm's only edge (warm throughput) is the thing we've established we don't
  need.

Open (non-blocking): wire the high-water respawn into the actual worker/pool
lifecycle; ImageBitmap decode-in-worker (§7.4) for the file→thumbnail end-to-end.

---

## 12. Unified routing policy (2026-06-01)

`src/worker/strategy.ts` `chooseStrategy(srcW,srcH,dstW,dstH) → {path,tile,reason}`
— one pure, unit-tested (`scripts/test-strategy.mjs`) decision shared by the demo
and any production caller. Decides **path** (how to execute); engine *family*
(TS/Wasm/SAB) is a separate axis the caller pins.

Gates, in precedence order (all thresholds measurement-derived, §10–11):
1. **ratio ≥ 4× (per axis) → `shrink`** (shrink-then-reduce). Wins first, at ANY
   source size: pure Lanczos cost plateaus at high ratios (you pay for the source),
   so even small heavy downscales benefit. ~6 LSB approximation.
2. **else srcMpix ≤ 1.1 (~1024²) → `inline`** (resizeSeparable, no pool). Single-
   thread is ≤~30ms here — cheaper than the pool's 40–80ms source-copy/dispatch
   overhead. (In the demo the "inline" path still uses the single worker to keep
   the main thread free; a synchronous caller could run it truly inline.)
3. **else → `pool`, tile 256, workers = cores.** Large + mild downscale is the only
   regime where parallelism's overhead is repaid.

Engine families exposed as demo engines **auto-ts / auto-wasm / auto-sab** (default
auto-ts): each runs the policy, pinning its kernel — auto-sab uses the SAB pool for
the pool path when cross-origin isolated, else falls back to the TS pool. Manual
engines (ts/wasm/pool/wasm-pool/sab-pool, fixed tile) remain for profiling/A-B.

Caveat: the **pool path stays bit-identical pure-Lanczos** (no shrink-then-reduce),
so a mild downscale on a huge source pays full cost — but mild ratios don't hit the
plateau, so that's fine. The only un-accelerated corner is a *heavy* downscale the
policy sends to `shrink` (single worker), not the pool — intended.
