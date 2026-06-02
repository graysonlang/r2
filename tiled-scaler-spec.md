# Tiled, Color-Correct Image Scaling System — Design Specification

A web-based image scaling subsystem for a drag-and-drop asset import workflow. Processes
dropped image assets through a color-correct, linear-light, tiled resampler running in
disposable workers, emitting either tagged PNG output or straight-alpha sRGB for GPU
compositing in Three.js.

This document consolidates the full design. It is decision-complete at the architectural
level; remaining open items are empirical (browser-behavior verification, profiling sweeps)
and are explicitly called out as such.

---

## 1. Goals and constraints

**Functional**
- Accept image assets via drag-and-drop (one or many per drop).
- High-quality downscale (primary case) with correct color and alpha handling.
- Inline sharpen/soften as part of the scale operation.
- Two output destinations: tagged PNG (backend storage) and straight-alpha sRGB pixels for
  Three.js texture ingest.

**Non-functional (these drove most of the design)**
- **Low, evictable memory footprint** across long batch sessions — must not accumulate or
  fragment over repeated imports.
- **Low startup/init cost** — target under ~60ms (≈1/16s), acceptable because it overlaps
  asset disk I/O.
- **Color correctness** sufficient for intermediate compositing, not merely on-screen
  presentation.

**Explicit scope limits (v1)**
- 8 bits per channel, interleaved.
- Greyscale (1ch), RGB (3ch), RGBA (4ch).
- Transfer-function-aware; **primaries retained, not converted** (see §4).
- sRGB assumed when no embedded profile is present.

**Non-goals (v1)**: primary/gamut conversion, >8-bit input, planar formats, GPU-side
resampling, full CMM-based rendering-intent handling.

---

## 2. System overview

```
                          MAIN THREAD
  drop event ──┬─────────────────────────────────────────────┐
               │                                              │
               ├─ spawn worker(s)  ──────────────┐  (overlaps decode I/O)
               │                                  │
               └─ for each dropped Blob:          │
                    sniff format + color metadata │
                    route decode strategy ────────┼──▶ hand Blob + route to worker
                                                   │
                                                   ▼
                                              WORKER (disposable, per-drop)
                                              ├─ decode (controlled or browser path)
                                              ├─ color-adapt → known linear state
                                              ├─ tiled resample (linear f32)
                                              ├─ inline sharpen/soften (apron'd)
                                              ├─ encode + quantize
                                              └─ emit: tagged PNG bytes  ── store
                                                       or straight sRGB ── Three.js ingest
               ┌──────────────────────────────────────────────┘
               └─ batch complete → worker.terminate()  (full memory reclamation)
```

Two architectural spines hold the design together:

1. **A color-adapter front end** that absorbs *all* per-engine / per-format / per-metadata
   variance and emits a single known internal representation. Everything downstream is
   invariant to how the pixels got into that state.
2. **A disposable per-drop worker lifecycle** where `terminate()` is the memory-eviction
   mechanism, making in-process memory hygiene largely unnecessary.

---

## 3. Inbound routing and color management

### 3.1 The core problem

Browser convenience decode paths (`createImageBitmap`, `<img>`, canvas `drawImage`) are
built for on-screen presentation and are **color-unsafe for compositing**. Notably, Chrome's
managed path bakes *both* the embedded profile *and* the display profile into the returned
pixels — correct for screen, corrupting for intermediate compositing, because the output is
in display space rather than any portable space.

Verified behavior (source-level, from prior Google Photos work — **re-verify per engine and
version**, see §3.5):
- Chrome applies color management as a **binary gate**: an image with **no embedded ICC
  profile** is processed **entirely un-color-managed** (raw passthrough).
- Chrome's gate appears keyed on the **embedded profile specifically**; lighter color chunks
  (`gAMA`, `cHRM`, `sRGB`) appear to be **ignored** by its decode path.
- WebKit / Gecko behavior is expected to be similar but is **not yet verified** and may
  honor chunks Chrome ignores — the source of potential cross-engine drift.

### 3.2 The invariant that makes this tractable

Every decode path must terminate in a **known color state**: linearized pixel data with a
known transfer function and known (retained) primaries. All engine-specific messiness lives
in the adapter; nothing downstream depends on which path produced the pixels.

Consequence: per-engine quirks, version shifts, and new format support become **routing-table
data, not architecture**. Unverified combinations route to the conservative (own-decode) path
and fail safe; verified-safe combinations may be relaxed to the cheaper browser path as a
pure optimization with no correctness cost.

### 3.3 The routing gate

On each dropped Blob, sniff container magic bytes and color metadata, then route:

| Condition | Decode path | Color handling |
|---|---|---|
| No embedded profile | Browser unmanaged passthrough (where verified) or own-decode | Treat as sRGB (consistent with Chrome's raw passthrough) |
| Embedded ICC profile present | **Controlled / own-decode** | Preserve raw ICC bytes; linearize via profile's transfer function; retain primaries |
| Partial tags (`gAMA`/`cHRM`, no `iCCP`) | See §3.4 — policy decision | Honor declared transfer function (recommended) |
| Format not browser-decodable | Own-decode (Wasm codec) or reject | Per profile if present, else sRGB |

The gate's primary key is **embedded-profile-present**: present → managed-path danger →
controlled decode; absent → raw passthrough → apply own interpretation.

### 3.4 Partial-tagging policy (gAMA/cHRM without iCCP)

A genuine conflict exists for PNGs carrying `gAMA`/`cHRM` but no `iCCP`, given Chrome ignores
those chunks:
- **Match-browser-output**: ignore the chunks too (treat as raw/sRGB) — consistent with what
  Chrome displayed.
- **Honor-file-intent** *(recommended for this pipeline)*: apply the declared transfer
  function, since downstream is doing colorimetric math, not reproducing screen output.

These conflict only for this rare partial-tagging case. **Decision: honor declared transfer
function.** Document this explicitly; the rare asset hitting it will be visibly wrong under
the other choice, so the policy must be intentional, not default.

### 3.5 Empirical items (do not hardcode without verifying)

- Whether `createImageBitmap`'s `colorSpaceConversion: 'none'` reliably yields
  un-color-managed pixels on each target engine/version (load-bearing for using the browser
  decode path at all on tagged assets).
- WebKit and Gecko untagged-image handling: is the unmanaged path **bit-identical
  passthrough**, or does it apply an implicit (possibly non-identity) assumption? Drift here
  breaks the cross-engine consistency of the "assume sRGB" policy.
- Whether Chrome's "only embedded profile matters" behavior is **stable across supported
  versions** (recent versions may have improved P3 handling as P3 has become common).
- WebCodecs `ImageDecoder` color behavior and profile access as an alternative controlled
  decode surface.

Fallback posture: anything tagged or uncertain routes to own-decode, which is fully
deterministic and engine-independent. Browser-decode is an optimization adopted only where
positively verified safe.

---

## 4. Color model for resampling

### 4.1 Transfer function is decoupled from gamut

The **only** color property that matters for correct resampling is the transfer function,
because resampling is a weighted average and that average is valid in any linear RGB space
regardless of primaries. Therefore:

- **Linearize** via the colorspace's transfer function before resampling.
- **Retain primaries unchanged** through the operation — no primary/gamut conversion. This
  is correct (not an approximation) for a gamut-preserving downscale; converting primaries
  would be the error.

### 4.2 Transfer-function routing table (keyed on colorspace identity, NOT gamut width)

| Colorspace | Transfer function | Note |
|---|---|---|
| sRGB | sRGB piecewise (linear toe + ~2.4 exp w/ offset) | Do **not** approximate as pure 2.2 |
| Display-P3 | **sRGB piecewise** | **Gotcha**: P3 = sRGB curve + wider primaries |
| Adobe RGB (1998) | Pure ~2.199 exponent | Straight power |
| ProPhoto RGB | ~1.8 exponent **with linear toe** | 8-bit ProPhoto is banding-prone (designed for 16-bit) |

The lesson: **select the curve from the actual transfer characteristic, never infer it from
gamut width.** Display-P3 is the case that punishes gamut-based inference.

### 4.3 Precision and gamut edges

- f32 accumulator throughout the linear section (already required by the resampler).
- Wide-gamut 8-bit (esp. ProPhoto) is more quantization-fragile; include such assets in the
  validation set.
- Averaging in-gamut values cannot produce out-of-gamut values, so the resample creates no
  new out-of-range colors; only ensure correct clamp at 0/1 on re-encode.

### 4.4 Untagged wide-gamut assets

Untagged-but-actually-wide-gamut assets (e.g. a P3 export that lost its tag) are
undetectable by definition. Assuming sRGB is the only defensible choice; any error is the
asset's fault. Mark this as deliberate policy in code so the sRGB assumption isn't read as
an oversight.

---

## 5. The resampling kernel

### 5.1 Separable two-pass structure

Resampling is two 1-D passes operating on the input sub-region, producing the output tile,
entirely in **linear f32**:

1. **Horizontal pass**: input-region width → output-tile width; reads along rows
   (contiguous in interleaved layout) — cache-friendly. Produces f32 linear intermediate.
2. **Vertical pass**: intermediate height → output-tile height. Either accept strided
   column reads or transpose during pass 1 so pass 2 is row-contiguous — **profile both**
   (§8).

Horizontal-first on downscale also shrinks the buffer the vertical pass walks.

### 5.2 Filter support and scale

Per axis, `s = out_dim / in_dim`:
- Downscale (`s < 1`): filter stretched in input space; input support radius = `r_filter / s`.
- Upscale (`s > 1`): input support radius = `r_filter`.
- `support_in = ceil(r_filter / min(s, 1))`.

### 5.3 Linearization

- 256-entry `Float32Array` LUT for sRGB→linear (8-bit input), or the appropriate per-curve
  LUT per §4.2. Exact, branch-free, cache-resident.
- Linearize **color channels only**. Alpha is coverage — never linearize it.
- Greyscale: the single channel is color → linearize.

### 5.4 Coverage-weighted accumulation (alpha path)

Color is weighted by alpha so transparent pixels contribute no color (the implicit-premul
approach — correct, and one pass fewer than materializing a premultiplied buffer). Per output
sample over contributing inputs `i` with filter weights `w_i`:

```
num_rgb = Σ (w_i · a_i · linear_rgb_i)     // alpha-weighted color, linear
den_a   = Σ (w_i · a_i)                     // denominator for COLOR
sum_w   = Σ (w_i)                           // denominator for ALPHA (coverage)

out_a   = Σ(w_i · a_i) / sum_w              // alpha normalized by Σw_i
out_rgb = den_a > epsilon ? num_rgb / den_a : 0   // guarded un-premultiply
```

**Two distinct denominators**: color ÷ `den_a` (alpha-weighted), alpha ÷ `sum_w` (plain
weights). Conflating them is a classic subtle bug.

- **Degenerate pixel**: `den_a ≤ epsilon` → emit **transparent black** (rgb=0, a=0).
  Zero-alpha source samples contribute nothing to accumulation; `epsilon` is a **numerical
  floor for the divide only** (sized to f32 conditioning), *not* a perceptual cutoff —
  keeping it tiny avoids eroding soft low-alpha edges. (Note: a larger perceptual epsilon
  compounds across repeated downscales / mip chains, hardening feathered edges — keep it
  numerical.)
- **Non-alpha formats**: `out = Σ(w_i · linear_i) / Σw_i`.

### 5.5 Edge handling

Pick one policy, apply consistently in both passes:
- **Clamp-to-edge** (replicate boundary), with **renormalization by actual in-bounds
  weights** so edges aren't dimmed by missing contributions.

Two non-negotiable rules at the boundary:

1. **Off-image samples get spatial weight 0** (renormalize the in-bounds weights to
   sum to 1), **never** modeled as transparent-black samples (`w=1, a=0`). Counting
   phantom transparent samples in the coverage denominator `out_a = Σ(w·a)/Σw` drops
   the alpha of a fully-opaque image around its entire perimeter — the **Photoshop
   PNG-layer bug**: a loaded PNG becomes a non-background layer, and PS branches on
   "layer has an alpha channel" (whether or not any pixel is actually transparent),
   taking the kernel path that samples outside the canvas as transparent and leaving
   a semitransparent 1px frame on basically every downsized PNG.
2. **Clamp in the coverage-weighted (premultiplied) domain**: replicate `a` and
   `a·rgb` at the boundary, then un-premultiply — so a low-alpha boundary pixel
   contributes coverage-correctly instead of smearing its essentially-undefined
   straight RGB inward.

Mirror is also artifact-free and acceptable; "zero-alpha outside" is the only choice
that is wrong. This only becomes a live decision once kernel support exceeds ½px (the
wide separable kernel in §5.1); the current box/area resampler never samples out of
bounds, so an opaque image is already opaque to the edge with no special case. Either
way, the contract is verified by the **"opaque image stays opaque at all borders (no
OOB falloff)"** check in `scripts/test-alpha.mjs`.

### 5.6 Inline sharpen / soften (with apron)

Folded into the vertical-pass output stage, in **linear light, before encode** (sharpening
in sRGB has the same gamma-error class as resizing in sRGB).

- Formulation: unsharp mask (`out = lerp(blurred, sharp, amount)`, amount>1 sharpen, <1
  soften, =1 identity) or a small separable convolution tap.
- **Apron requirement**: a spatial sharpen reads resampled neighbors, so a tile must produce
  a margin (apron) of resampled output beyond its own rect to sharpen its border rows/cols
  seam-free. Resample tile-plus-apron, sharpen the full extent, **crop to the tile rect on
  write-out**. Apron width = sharpen radius mapped back through the scale.
- This preserves the property that tiled output is **bit-identical to whole-image output**
  even with inline sharpen (the apron supplies real neighbor data for border pixels). Cost:
  redundant resampling in the apron overlap between adjacent tiles — part of the tile-size
  tradeoff (§8).

### 5.7 Encode and quantize

- Linear→encoded via the output colorspace's transfer function (direct compute, or a fine
  LUT e.g. 4096-entry with interpolation).
- Quantize f32→8-bit with **rounding**, not truncation.
- Optional dithering (ordered or error-diffusion) before quantization to avoid banding,
  especially for greyscale and wide-gamut — behind a flag.
- Alpha quantized linearly (no transfer function), with rounding.

---

## 6. Tiling

### 6.1 Output-space planning, input-region pull

Tiles are planned over the **output** image; each pulls the input rows/cols its filter
support touches. Output tiles are **disjoint** (no write contention); input regions **overlap**
at seams (read-only, fine).

For output tile rows `[oy0, oy1)`:
```
in_center_y(oy) = (oy + 0.5) / s_y - 0.5
iy0 = floor(in_center_y(oy0)     - support_in_y)
iy1 = ceil (in_center_y(oy1-1)   + support_in_y) + 1   // exclusive
// + apron expansion per §5.6; same for x
```

### 6.2 Tile size as a dual-axis parameter

Tile size `{tileW, tileH}` is a **runtime parameter** serving two purposes:

1. **Cache coherence** (throughput): keep the per-tile working set within L2. Working set ≈
   `(input_region_area + output_tile_area) × channels × 4 bytes` plus 8-bit buffers.
2. **Peak working-set bound** (memory): peak footprint scales with
   `tile_size × concurrent_workers`, **decoupling memory from asset size** — the key lever
   for batches of arbitrarily large imported assets.

Because downscale widens input support, the per-tile **input** region grows as scale shrinks;
sweep tile size **per scale regime**, bounding the **worst-case** (largest downscale) region
against the memory target.

---

## 7. Worker lifecycle and memory

### 7.1 Disposable per-drop workers

The workflow is drag-and-drop: bursty activity, then idle. The model is **terminate the
worker per batch**. `worker.terminate()` discards the entire isolate/heap wholesale — this
**is** the eviction mechanism. No intra-process eviction protocol, no reference-nulling, no
GC coaxing.

Consequences:
- **Intra-batch, optimize freely for speed** (reuse scratch buffers, keep LUTs warm) —
  termination reclaims everything regardless, so retention within a batch is not a concern.
- **Wasm non-shrinking linear memory is neutralized**: it ratchets only within one worker's
  life and dies on terminate, bounding it to per-batch peak.
- The only intra-batch memory concern is **peak** working set — bounded via tile size (§6.2).

### 7.2 Startup hidden behind I/O

Startup budget ~60ms is acceptable because it overlaps asset decode/disk I/O. **Spawn
worker(s) the instant the drop event fires**, concurrently with reading/decoding files, so
init is hidden rather than added to the critical path. Use an explicit **ready handshake**
(worker posts `ready` after installing its message handler) to (a) know when to dispatch and
(b) avoid the top-level-await dropped-message race in worker+module startup.

### 7.3 Multi-asset drops

A drop may contain one or many assets. Spawn `min(assetCount, hardwareConcurrency)` workers,
distribute assets across them, process in parallel, terminate all on batch drain. Tile
scheduling (§6) applies *within* each large asset; across assets it's just work distribution.
The terminate-on-batch-complete boundary is unchanged.

### 7.4 In-worker decode

Hand the raw `Blob` to the worker and decode there (`createImageBitmap` / `ImageDecoder`
available in workers). Only a small Blob reference crosses the input boundary (not a large
pixel buffer), the main thread stays free, and the worker owns the asset end-to-end. The
startup-overlap logic still holds; the worker's own decode is the long pole it overlaps.

---

## 8. JS vs. Wasm kernel comparison

The lifecycle and memory questions resolve **identically** for both kernels (terminate-per-
drop bounds memory and hides startup for both), so the JS-vs-Wasm decision **collapses to
pure per-tile throughput** — the original reason for the reference implementation.

To make the comparison valid:
- Share **all** scaffolding: tile planning, scheduling, buffer transfer, reassembly,
  color-adapter front end.
- The **only** swappable unit is the per-tile `resample(inputRegion, params) → outputTile`
  call. Otherwise you measure "JS harness vs Wasm harness," not the kernels.

Notes:
- **Do not** require bit-identical output across JS and Wasm — `Number`/IEEE-double vs.
  compiled single-precision, plus differing transcendental implementations, make this
  unrealistic. Use a **tolerance comparison** (e.g. max abs channel diff ≤ 1 LSB) across
  implementations. Bit-identical equality applies only *within* one implementation (tiled
  vs. whole-image oracle, §9).
- If Wasm is chosen and respawn cost matters: precompile the `WebAssembly.Module` once on the
  main thread and reuse it across spawns so respawn pays only instantiation + memory init,
  not recompilation (kept well within the ~60ms budget, and overlapped with I/O anyway).

---

## 9. Validation and profiling

### 9.1 Correctness (within one implementation)

- **Whole-image vs. tiled bit-identical**: the single most valuable checkpoint. With the
  apron (§5.6), tiled output must equal whole-image output exactly. Any divergence is a
  tiling/decomposition bug (region mapping, edges, apron, reassembly), never kernel math.
  Keep the whole-image path permanently as the oracle.
- **Gradient round-trip**: linear ramp resized 1:1 returns unchanged within rounding
  (verifies LUTs/encode are inverse).
- **Alpha fringe**: opaque white shape on transparent-black, downscaled 4× → no dark halo;
  compare against a deliberately-broken straight-alpha resample to confirm the test detects
  fringing.
- **Degenerate region**: fully transparent tile → rgb=0, a=0, no NaN/Inf.
- **Edge policy**: flat color downscaled → no darkened border.
- **Greyscale/RGB parity**: grey promoted to RGB matches per-channel.
- **Color**: tagged P3/AdobeRGB/ProPhoto assets linearized with the correct curve (esp.
  P3-uses-sRGB-curve); wide-gamut 8-bit assets checked for banding.

### 9.2 Build order

1. Single-threaded, whole-image, RGBA-only, linear resample + coverage — get correctness green.
2. Add inline sharpen/soften with apron.
3. Add tiling (output-space plan, input-region pull) still single-threaded — verify
   bit-identical to whole-image.
4. Add worker pool + ready handshake (transferable strategy first).
5. Add color-adapter front end + routing (start conservative: own-decode for anything tagged).
6. Add grey/RGB specializations; optional channel compaction.
7. Introduce the second (Wasm) kernel behind the same per-tile interface; tolerance-compare.
8. SIMD-specialize the hot accumulation loop once layout is settled.

Steps 1–3 matching exactly isolates resampling correctness from concurrency before any
parallelism is introduced.

### 9.3 Profiling sweeps (empirical, harness-produced)

- `{tileW, tileH}` × scale-regime → output Mpix/s + variance; bound worst-case-downscale
  per-tile region against memory target.
- Buffer strategy: transferable-extract vs. SharedArrayBuffer-shared-source vs.
  SAB-shared-output (the last writes disjoint rects directly — no result copy, no atomics;
  requires COOP/COEP).
- Worker count around `hardwareConcurrency` (over-subscription sometimes hides dispatch
  latency, sometimes thrashes cache).
- Transpose-in-pass-1 vs. strided vertical reads (§5.1).
- JS vs. Wasm per-tile throughput (§8).
- **RSS-over-time** under a simulated long batch session, confirming terminate-per-drop
  actually returns memory to the OS on the target engine.

---

## 10. Output contract and downstream

### 10.1 Interchange format

**Straight (unassociated) alpha, 8-bit, in the asset's color space** is the interchange
format across every boundary. It serves both consumers without forcing either to undo the
other's assumption:
- **PNG storage** wants straight natively (direct write).
- **GPU/Three.js** wants premultiplied but premultiplies on ingest as part of its normal
  contract.

Premultiplied is a *terminal* format (ideal at the sampling stage, awkward where data still
forks). Since output forks to two consumers, keep it straight until the last moment.

### 10.2 PNG storage

- Embed color via PNG's dedicated chunks: **`iCCP`** for an embedded ICC profile (wide-gamut
  retained), or **`sRGB`** (+ `gAMA`/`cHRM` for fallback) for the sRGB case. Color info rides
  in these ancillary chunks, **not EXIF**.
- **Pass original ICC bytes through verbatim** to `iCCP` — do not parse-and-regenerate. The
  profile was parsed only to determine the transfer function for linearization; preserve and
  reattach it.
- Output must genuinely be in the space it's tagged as, or the careful ingest color
  management is undone one stage later.

### 10.3 Three.js / GPU ingest

- Current architecture: **premul happens only at Three.js ingest**; all shaders assume
  premultiplied throughout. This is the textbook setup and ratifies the straight-everywhere
  upstream design — premul is a property of the render domain only.
- Feed straight-alpha sRGB; let texture ingest perform the single straight→premul.
- **Verify the ingest premul and shader assumption agree**: don't double-premultiply (data
  already premul *and* `premultiplyAlpha=true`) or skip it (straight data with premultiplied
  blending). Both reintroduce edge fringing at the final stage. Blend state must be the
  premultiplied equation (source factor ONE, not SRC_ALPHA).

### 10.4 Future: linear compositing

If Three.js moves to linear compositing later: the worker output **stays straight sRGB** (the
correct interchange regardless), and only the texture-ingest stage changes — the
premultiply must then happen in **linear** space (premultiply linearized color, consistent
with linear blending), and shader color math/constants retuned for linear light. The upstream
pipeline is already gamma-correct end-to-end, so the change is **confined to the render
domain** — the payoff of the straight-everywhere contract. Sequence it as its own isolated
change (with the premul-ordering move) to keep regressions bisectable.

---

## 11. Open items (none force a rewrite)

All remaining work is implementation, browser-behavior verification, or profiling. The
adapter-isolates-variance structure (§3.2) guarantees that engine/version/format findings
are routing-table data, not architectural changes; conservative defaults fail safe.

- **Browser color-path verification** (§3.5): `colorSpaceConversion:'none'` trustworthiness;
  WebKit/Gecko untagged passthrough fidelity; Chrome iCCP-only-gate stability across
  versions; recent P3 handling improvements; WebCodecs `ImageDecoder` color behavior.
- **Profiling sweeps** (§9.3): tile size, buffer strategy, worker count, transpose variant,
  JS-vs-Wasm throughput, RSS-over-time.
- **Partial-tagging policy** (§3.4): confirm the honor-file-intent decision against real
  asset distribution.

---

## Appendix A: Design rationale (key decisions and why)

- **Straight alpha as interchange**: forks cleanly to PNG (native) and GPU (premul-on-ingest);
  premul is terminal and belongs only at the render boundary.
- **Implicit premul via coverage-weighted accumulation**: correct and one pass fewer than
  materializing a premultiplied buffer; output stays straight without a separate un-premul.
- **Transfer function decoupled from gamut**: resampling is valid in any linear space;
  retaining primaries is correct for gamut-preserving downscale, not an approximation.
- **Terminate-per-drop lifecycle**: `terminate()` is wholesale heap reclamation — the most
  reliable eviction; neutralizes both glibc-style fragmentation concerns and Wasm
  non-shrinking-memory; lets intra-batch code optimize purely for speed.
- **Startup overlapped with decode I/O**: turns the ~60ms init from "acceptable" into
  "off the critical path."
- **Color-adapter isolates engine variance**: per-engine quirks become routing data; the
  known-linear-state invariant makes everything downstream engine-independent; conservative
  own-decode fallback fails safe.
- **Apron'd inline sharpen**: preserves tiled == whole-image bit-identity even with a
  neighbor-reading spatial operation, so tiling stays a pure performance decomposition.
- **Tile size as memory bound**: decouples peak footprint from asset size — essential for
  batches of arbitrarily large imports.
