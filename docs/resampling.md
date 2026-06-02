# Resampling: filters, separability, and the SIMD path

Technical notes on the resampling kernels in this repo — what the current
algorithm is, how box / triangle / Mitchell / Lanczos compare, and why the
filter choice and the SIMD/tiling story are more entangled than they look.

## Two implementations, on purpose

- **`src/resize.ts`** — the fused, single-pass **area (box) resampler**. This is
  the Phase-1 oracle: a known-good reference we keep bit-stable and test against.
- **`src/separable.ts`** — the general **two-pass separable resampler** with a
  kernel selector (box / triangle / Mitchell / Lanczos-2 / Lanczos-3). This is
  the structure the spec (`tiled-scaler-spec.md` §5.1) assumes for tiling and the
  eventual Wasm kernel. It is a companion, not a replacement.

Both share the alpha contract (coverage-weighted, spec §5.4) and the edge policy
(out-of-bounds = weight 0, renormalize; never zero-alpha-outside — spec §5.5).

## What the current algorithm actually is

`resize.ts` is an **exact area-averaging** resampler, not a naive block average.
Three properties lift it above "average NxN":

1. The box width **scales with the downscale ratio** (support = `srcW/dstW`
   source pixels), the correct adaptive antialiasing behavior for a box.
2. **Exact fractional coverage** at the box edges (continuous, not integer) — the
   `pxRed` carry-over and `xScale`/`yScale` machinery integrate the partial
   boundary pixels.
3. It averages **in linear light** (gamma-correct), which most box code omits.

Formally, modeling each source pixel as a unit box and integrating over a
width-`R` output box convolves two boxes → a **trapezoid** kernel: ≈box of width
`R` with 1px ramped edges. For large downscale it is essentially a box; for mild
downscale (`R≈1`) it leans toward a triangle/tent. So: "basically a box," with a
tent-ish character at gentle ratios.

## Box vs Mitchell vs Lanczos

The defining difference is **negative lobes**. Box has none; Mitchell and Lanczos
do.

| Filter | Support | Neg. lobes | Sharpness | Ringing/halos | Cost |
|---|---|---|---|---|---|
| Box (area) | ~R, adaptive | none | soft | none | cheapest |
| Triangle | 1px (·/scale) | none | soft-ish | none | cheap |
| Mitchell (B=C=⅓) | 2px | small | balanced | mild | moderate |
| Lanczos-2/3 | 2–3px | pronounced | sharpest | visible | priciest |

Frequency-domain intuition: the box's response is a **sinc** — slow rolloff, so
it both *blurs* (attenuates detail below Nyquist) and *aliases a little* (leaks
above it). Lanczos is a windowed sinc approximating an ideal brick-wall lowpass:
crisp passband, good stopband, best near-Nyquist detail retention — at the cost
of ringing on hard edges. Mitchell is the deliberate compromise: small negative
lobes keep most of Lanczos's sharpness with far less overshoot, which is why it's
the usual photographic-downscale default.

For **downscaling specifically**, area-averaging is a legitimate antialiaser (the
correct prefilter for box reconstruction), and the no-negative-lobe property is
exactly why it never rings and mitigates moiré. The gap to Mitchell/Lanczos is
mostly (a) near-Nyquist detail retention and (b) mild downscale ratios — not the
pathological aliasing cases, where the box's softness is a feature.

## Unsharp ≈ synthesized negative lobes

The optional unsharp pass in `resize.ts` (`sharpeningCoefficient`) is, in effect,
**synthesizing negative lobes after the fact**. A box blur followed by an unsharp
mask pushes the combined frequency response up toward a Mitchell/Lanczos-like
shape — and, overdriven, produces the same overshoot halos. That is why ~0.25
"looks good across a wide range": it nudges the box's sinc rolloff back toward
flat without committing to a wide multi-lobe kernel. It is a cheap, tunable
approximation of a sharper filter. (Disposition: kept, default 0; revisit the
tiling apron cost at Phase 3.)

## Separability and tileability

Mitchell and Lanczos are **separable** (2D = 1D⊗1D), so each is two 1D passes —
the same shape as box in the separable form. Tileability is identical to any
separable filter: output tile → input region + apron, where
`apron = ceil(radius / scale)` per axis. Box, in this framework, is just another
weight table (`radius 0.5`, no negative lobes). So supporting all four costs one
resampler implementation plus four tiny weight-generating functions.

The structural shift from the fused box to the separable form:

```
1. Per axis, precompute a weight table (once, not per row):
     for each output o:  taps = list of (srcIndex, weight) over the support
     (out-of-bounds taps dropped; remainder renormalized so Σw = 1)
2. Horizontal pass: intermediate[srcH × dstW] = Σ taps, linear f32
3. Vertical pass:   output[dstH × dstW]      = Σ taps, then un-premul + encode
```

Kernels (normalized offset `x`):

```
box:        1 for |x| < 0.5
triangle:   max(0, 1 − |x|)                 radius 1
mitchell:   piecewise cubic, B=C=⅓          radius 2   (small negative lobes)
lanczos-a:  sinc(x)·sinc(x/a)               radius a   (pronounced lobes)
```

Downscale stretches the kernel: `filterScale = min(scale,1)`,
`support = radius/filterScale`, `center(o) = (o+0.5)/scale − 0.5`,
`w_i = kernel((i−center)·filterScale)`, normalized.

## The SIMD irony (why "more complex" is actually better)

All four filters share **one hot loop** — a weighted tap sum; only the
precomputed weights differ. So filter choice has zero SIMD-structure cost;
Lanczos is not "harder to vectorize" than box, just wider support (more taps).

Wasm fixed-width SIMD (`v128` / `f32x4`, stable since ~2021) maps cleanly onto
**interleaved RGBA**: one pixel's four channels = one 128-bit lane group.

```
acc4 = 0
for k in support:
    src4 = f32x4(RGBA at tap k)        // 4 channels → 4 lanes
    w    = f32x4.splat(weight[k])
    acc4 = acc4 + w * src4             // baseline: mul+add; relaxed: relaxed_madd
```

Caveats: no SIMD **gather**, so the gamma→linear LUT stays a scalar lookup per
channel (build the `f32x4` from 4 scalar lookups, *then* vectorize the tap sum —
the loop is the hot part), or swap the LUT for a SIMD polynomial. No FMA in
baseline SIMD (relaxed-SIMD adds `f32x4.relaxed_madd`, at the price of
nondeterminism — keep it off where bit-stability matters).

The irony: the clever fused box is **worse** for SIMD than the "more complex"
separable filter. Its `pxRed += …; pxRed = fracRed` carry-over is a
**loop-carried dependency** across output pixels — inherently serial. The
explicit-weight separable form has **independent output pixels** → embarrassingly
parallel for both SIMD lanes and worker tiles. So moving to selectable
Lanczos/Mitchell/box-as-weights is not just a quality feature; it is what
*unlocks* the SIMD path. The elegant scalar trick and the SIMD-friendly structure
are at odds, and Phase 3 wants the latter.

Coverage-weighted alpha does not spoil this: premultiply is lane math inside the
same `f32x4`; the two denominators (`Σw·a` for color, `Σw` for alpha) are a couple
of scalar reductions at pixel finalize. Layout note (spec §5.1): the horizontal
pass reads contiguous; the vertical pass is strided per tap, but each tap is still
a contiguous 4-float vector load, so the transpose-vs-strided question is about
cache, not vectorizability.

## Measured: SIMD on the Wasm kernel (2026-05-31)

The C kernel (`src/wasm/resize.c`) was SIMD-specialized (`f32x4`-per-RGBA,
`-msimd128`, scalar `double` path retained as the bit-exact reference) and
benchmarked vs the TS oracle (`scripts/test-wasm.mjs`, 2048²→1331², Lanczos-2,
coverage). Findings, in order:

1. **C over JS is ~1.8×** on its own (scalar C vs TS), before any SIMD.
2. **Naive SIMD bought ~nothing** (≈0% over scalar C). Confirmed empirically the
   no-gather caveat above: the horizontal tap loop did three scalar LUT lookups
   (`decode[p[0..2]]`) per tap, so `f32x4_make` from four scalars just lane-packs
   work that's still scalar. The arithmetic was never the bottleneck.
3. **Fix: pre-linearize once.** Decode + premultiply every source pixel into a
   contiguous f32 RGBA buffer up front (the LUT gather and per-pixel coverage
   weight are tap-independent, so they hoist out). The horizontal tap loop then
   reads contiguous `v128` loads — no gather. This unblocked SIMD: **~1.9× over
   TS** (≈5% over scalar C), and relocated the bottleneck to the **vertical pass's
   strided per-tap loads** (the transpose-vs-strided question, §5.1) — the next
   real lever, bigger than more SIMD ops.
4. **Float divergence appeared, within budget.** The f32 build now shows
   `maxDiff=1` LSB vs the double oracle on box/triangle (float accumulation
   rounding); scalar stays 0. This is exactly what the ≤1 LSB tolerance (§8)
   exists for — bit-identity across impls was never the goal.

5. **Transpose pass-1 output: tried, measured slower, reverted.** Laying the
   intermediate out transposed ([dstW][srcH][4]) so the vertical pass reads
   contiguously made it **slower** (SIMD 84→107ms, scalar 85→140ms). It doesn't
   remove the stride, it moves it from the pass-2 read to the pass-1 write — and
   scattered strided *writes* cost more than strided reads (writes thrash the
   write-combining buffer; reads prefetch). The spec's "profile both" (§5.1)
   resolves here to: keep row-major, eat the strided read. A code comment in
   `resize.c` records this so it isn't re-attempted. The real cache win is tiling.

Takeaways: pre-linearized contiguous f32 is the right kernel structure (it's also
what tiling/pooling wants); per-tile SIMD is a modest win next to memory layout
and parallelism; transposition is a net loss (strided writes > strided reads);
keep the scalar double path as the exact oracle. Current: ~1.9× over TS.

## Measured: SIMD is inert for this kernel; Wasm is a flat ~1.5× (2026-06-01)

Followed up because the ~1.8× felt low vs. typical Wasm-convolution wins. Isolated
benchmarks (node, kernel-only timing, sizes 96²→2048²) settled it:

- **Not the staging copy** — kernel-only ≈ full call (malloc/HEAPU8.set/copy-out
  are negligible vs. the resample).
- **Not cache/bandwidth** — the Wasm/TS ratio is flat ~1.5–1.6× from 96² (working
  set in L1) to 2048² (far out of cache). (Falsified an earlier "memory-bound"
  guess — at small sizes a bandwidth-bound kernel would show a *bigger* SIMD/Wasm
  gap; it doesn't.)
- **SIMD genuinely does nothing** — `wasm-dis` confirms the scalar build has **0**
  vector ops (not auto-vectorized) and the SIMD build has f32x4 ops, yet they run
  identically (83.8 vs 85.5ms @ 2048²). The disassembled hot loop is **one
  f32x4 multiply-add per tap**, where the 4 lanes are R/G/B/A of a single pixel.

Why SIMD can't help as structured: the 128-bit vector (4 floats) is exactly one
interleaved-RGBA pixel, and the tap loop is a **reduction** into that accumulator —
there's no extra parallelism to capture (the scalar compiler already overlaps the
4 channels via ILP). This is the opposite regime from a classic convolution that
vectorizes across *adjacent pixels* of a planar/single channel (load 4–16
neighbors into lanes, broadcast the weight) — that's where Wasm SIMD wins big.

Getting the 3–4× would require **planar (deinterleaved) layout** + vectorizing the
tap loop across adjacent output pixels (spec §8) — a real kernel rewrite (de/re-
interleave passes + gather-or-scale-specialized inner loop). **Decided NOT to do
this** (2026-06-01): overkill for the payoff, especially since the worker pool's
data-movement overhead already erases most of the per-tile kernel edge. So the
~1.5× is the honest ceiling for the interleaved kernel, and **TS is the primary
engine** — `-msimd128` stays on (harmless, occasionally a hair faster) but Wasm is
an optional accelerator, not load-bearing.

## Measured: vs libvips (2026-06-01)

External yardstick — `scripts/bench-vips.mjs` (`sharp`/libvips 8.17.3) in Node,
raw RGBA in/out (no codec), Lanczos-2, linear light, 4096²→2662², avg of 6:

```
ours TS   (1 thread)   524ms   14 Mpix/s   1.0x
ours Wasm (1 thread)   318ms   22 Mpix/s   1.6x
libvips   (1 thread)   133ms   53 Mpix/s   4.0x our TS / 2.4x our Wasm
libvips   (10 threads)  29ms  241 Mpix/s
```

So a mature C lib is **~2.4× our best single-threaded kernel** — closer than
expected for decades of hand-tuned SIMD C. Most of the gap is **algorithmic, not
SIMD**: libvips uses **shrink-then-reduce** (integer box-shrink to near the target,
then a short Lanczos pass over far fewer taps), and its `.gamma()` is an approximate
2.2-power round-trip vs our exact sRGB-piecewise LUT. Both are techniques we could
adopt, not just "better assembly."

**The lever to close it is shrink-then-reduce, not more SIMD** (SIMD is capped, see
above): integer-shrink the source first (cheap, cache-friendly box average), then
Lanczos the remainder — slashes tap count at large downscale.

**Done: `resizeThumbnail` (shrink-then-reduce).** `k = floor(srcDim / (dst·2))` per
axis box-shrink (reusing `resizeSeparable` with the box kernel — disjoint k×k
blocks, every source pixel touched once), then the requested kernel on the residual
(<2× → few taps). Falls back to plain resize when neither axis shrinks ≥2× (so it's
a no-op at mild ratios like 0.65×; the win is the thumbnail regime). Output is
within **~6 LSB** of pure Lanczos (box pre-filter + 8-bit intermediate = a slightly
different, still high-quality filter — opt-in, tolerance-checked, NOT the
bit-identity oracle).

Measured (`scripts/bench-vips.mjs`), 4096²→256² (16× downscale), single-thread:
```
ours TS pure-Lanczos   176.6ms   1.0x
ours TS shrink-reduce    70.7ms   2.5x faster than pure
libvips (1 thread)       86.5ms
```
**Shrink-reduce in plain TS (70.7ms) BEATS single-thread libvips (86.5ms)** at
thumbnail ratios — the gap flipped from 2.0× behind to ~1.2× ahead. At 16× the box
pre-shrink does nearly all the reduction one-touch-per-pixel, leaving Lanczos a tiny
~512² intermediate; our straight-line path then undercuts libvips's per-call
`.gamma()` + thread-pool overhead at single-image size. (Threaded libvips still wins
on bulk throughput.) This directly serves the thumbnail-generation flow.

**Auto-routing (2026-06-01).** Pure separable Lanczos cost is dominated by the
horizontal pass reading every SOURCE pixel, and taps grow as scale shrinks — so
cost **plateaus at heavy downscale** (e.g. 2048²→256² ≈ 44ms vs →128² ≈ 40ms,
barely faster despite 4× fewer outputs). The worker (`resizeWorker` handleResize,
TS engine) therefore **auto-routes to shrink-then-reduce at ≥4×/axis** — measured
1.6× @4×, 2.4× @8×, ~1.8× on the demo's 4096²@0.1. Below 4× it stays pure (the
shrink overhead isn't repaid yet — it's actually ~0.8× at exactly 4×, so the
threshold is the crossover). Heavy-downscale takes precedence over tiling (shrink
collapses the source first; the residual is small). NOTE: this makes the TS engine
a ~6 LSB approximation at heavy ratios; the **pool** path (`resizeTileRegion`)
stays bit-identical pure-Lanczos, so it does NOT auto-route — a heavy downscale on
the pool still pays the plateau. (Pool shrink-then-reduce would need the shrink in
the tile plan; not done.)

## Measured: vs the browser's own drawImage (2026-06-01)

The implicit baseline everything competes with: canvas `ctx.drawImage(src, 0,0,
dw,dh)` with `imageSmoothingQuality='high'` (main-thread, GPU-assisted). Added as
the demo **"Browser (drawImage)"** engine. 4096²→2662², warm:

```
browser drawImage   ~137-147ms
auto-ts (→ pool)    ~152-182ms
TS pool (tile 256)  ~162ms
```

So the browser's native path is **slightly faster than our multi-worker TS pool**
(~137 vs ~152ms) — which is a *strong* result for us: plain-TS-in-workers roughly
matches a GPU-assisted native resampler. And the framing that matters:
`drawImage` resamples in **non-linear sRGB** (wrong-gamma edges), with **no
coverage-correct alpha** (Photoshop-style fringing), no kernel choice, no control.
We match its speed at mild ratios while doing strictly more correct work; at heavy
thumbnail ratios shrink-then-reduce pulls ahead AND stays correct. The demo status
line flags `sRGB-space` so the quality caveat is visible. This is the honest
"why not just use the browser?" answer: comparable speed, lower quality.

`separable.ts` is the **scalar TS reference** (correctness + A/B quality, exposed
in the demo's kernel dropdown), deliberately in the independent-output weight-table
form. `src/wasm/resize.c` is the **Wasm kernel** (scalar double + SIMD f32 paths),
tolerance-verified against it and running in the worker. `resize.ts` remains the
fused-box oracle.
