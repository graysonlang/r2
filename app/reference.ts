import { displayImage, displayImageData, getImageData, loadImage } from '../src/canvasUtils';
import { resize, ResizeOptions } from '../src/resize';
import { type KernelName, resizeSeparable } from '../src/separable';

// Importing the page keeps esbuild from stripping it and ensures esp copies it
// to the output directory as the served entry document.
import referenceHtml from './reference.html';
export const filePaths = { reference: referenceHtml };

const IMAGE_DIR = 'assets/';
const IMAGE_FILES = [
  'test_card.png',
  'zone_plate.png',
  'zone_plate2.png',
  'sharpen_test.png',
  'star.png',
  'grid_spectrum.png',
  '3D.png',
  'picker.png',
  'alpha_fringe.png',
  'alpha_checker.png',
];

// Kernel choices shown in each panel's dropdown. 'box' is the fused oracle and
// 'browser' draws via the canvas's own scaler; the rest route through the
// separable resampler (see SEPARABLE_KERNELS).
const KERNEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'box', label: 'Box (fused, oracle)' },
  { value: 'box-sep', label: 'Box (separable)' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'mitchell', label: 'Mitchell' },
  { value: 'lanczos2', label: 'Lanczos-2' },
  { value: 'lanczos3', label: 'Lanczos-3' },
  { value: 'browser', label: 'Browser' },
];

const SEPARABLE_KERNELS: Record<string, KernelName> = {
  'box-sep': 'box',
  'triangle': 'triangle',
  'mitchell': 'mitchell',
  'lanczos2': 'lanczos2',
  'lanczos3': 'lanczos3',
};

// Control defaults (mirror the values in index.html). Params equal to these are
// omitted from the URL so a pristine view has a clean address.
const DEFAULT_SCALE = '0.65';
const DEFAULT_COVERAGE = true;
const DEFAULT_BACKDROP = 'transparent';
const DEFAULT_SHARPEN = '0';
const DEFAULT_KERNEL_A = 'box';
const DEFAULT_KERNEL_B = 'browser';

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element: #${id}`);
  }
  return element as T;
}

// Resolve the initial image from the `img` query param, falling back to the
// first image when it's missing or unrecognized.
function indexFromUrl(): number {
  const name = new URLSearchParams(window.location.search).get('img');
  const i = name === null ? -1 : IMAGE_FILES.indexOf(name);
  return i >= 0 ? i : 0;
}

window.addEventListener('load', () => {
  const scaleNumber = requireElement<HTMLInputElement>('scale-number');
  const scaleRange = requireElement<HTMLInputElement>('scale-range');
  const imageSelect = requireElement<HTMLSelectElement>('image-select');
  const prevButton = requireElement<HTMLButtonElement>('prev-image');
  const nextButton = requireElement<HTMLButtonElement>('next-image');

  const srcCanvas = requireElement<HTMLCanvasElement>('canvas-source');
  const canvasA = requireElement<HTMLCanvasElement>('canvas-a');
  const canvasB = requireElement<HTMLCanvasElement>('canvas-b');
  const kernelA = requireElement<HTMLSelectElement>('kernel-a');
  const kernelB = requireElement<HTMLSelectElement>('kernel-b');
  const coverageToggle = requireElement<HTMLInputElement>('coverage-alpha');
  const sharpenNumber = requireElement<HTMLInputElement>('sharpen-number');
  const sharpenRange = requireElement<HTMLInputElement>('sharpen-range');
  const backdropSelect = requireElement<HTMLSelectElement>('backdrop');

  for (const select of [kernelA, kernelB]) {
    for (const { value, label } of KERNEL_OPTIONS) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
  }
  kernelA.value = DEFAULT_KERNEL_A;
  kernelB.value = DEFAULT_KERNEL_B;

  // Apply control query params over the markup defaults; `img` is handled
  // separately by indexFromUrl().
  const params = new URLSearchParams(window.location.search);
  const scaleParam = params.get('scale');
  if (scaleParam !== null && Number.isFinite(parseFloat(scaleParam))) {
    scaleNumber.value = scaleParam;
    scaleRange.value = scaleParam;
  }
  const coverageParam = params.get('coverage');
  if (coverageParam !== null) {
    coverageToggle.checked = coverageParam !== '0';
  }
  const sharpenParam = params.get('sharpen');
  if (sharpenParam !== null && Number.isFinite(parseFloat(sharpenParam))) {
    sharpenNumber.value = sharpenParam;
    sharpenRange.value = sharpenParam;
  }
  const isKernel = (v: string | null): v is string =>
    v !== null && KERNEL_OPTIONS.some(o => o.value === v);
  const kaParam = params.get('ka');
  if (isKernel(kaParam)) {
    kernelA.value = kaParam;
  }
  const kbParam = params.get('kb');
  if (isKernel(kbParam)) {
    kernelB.value = kbParam;
  }
  const backdropParam = params.get('backdrop');
  if (backdropParam !== null
    && [...backdropSelect.options].some(o => o.value === backdropParam)) {
    backdropSelect.value = backdropParam;
  }

  const options = new ResizeOptions();
  options.coverageWeightedAlpha = coverageToggle.checked;
  options.sharpeningCoefficient = parseFloat(sharpenNumber.value);
  document.body.dataset.backdrop = backdropSelect.value;

  for (const [i, file] of IMAGE_FILES.entries()) {
    const option = document.createElement('option');
    option.value = String(i);
    option.textContent = file;
    imageSelect.appendChild(option);
  }

  let currentIndex = 0;
  let srcImage: HTMLImageElement | null = null;

  // Write current state into the URL as query params, omitting any that equal
  // their default (so a pristine view is a clean address). replaceState keeps it
  // out of history so a reload restores the view without spamming back entries.
  function syncUrl(): void {
    const search = new URLSearchParams();
    if (currentIndex !== 0) {
      search.set('img', IMAGE_FILES[currentIndex]);
    }
    if (scaleNumber.value !== DEFAULT_SCALE) {
      search.set('scale', scaleNumber.value);
    }
    if (coverageToggle.checked !== DEFAULT_COVERAGE) {
      search.set('coverage', coverageToggle.checked ? '1' : '0');
    }
    if (sharpenNumber.value !== DEFAULT_SHARPEN) {
      search.set('sharpen', sharpenNumber.value);
    }
    if (kernelA.value !== DEFAULT_KERNEL_A) {
      search.set('ka', kernelA.value);
    }
    if (kernelB.value !== DEFAULT_KERNEL_B) {
      search.set('kb', kernelB.value);
    }
    if (backdropSelect.value !== DEFAULT_BACKDROP) {
      search.set('backdrop', backdropSelect.value);
    }
    const query = search.toString();
    history.replaceState(null, '', query ? '?' + query : window.location.pathname);
  }

  // Render one output panel with the chosen kernel. 'browser' uses the canvas's
  // built-in scaler; everything else runs our linear-light pipeline (fused box
  // or separable). Sharpen applies only to the fused box path.
  function renderPanel(canvas: HTMLCanvasElement, kernel: string): void {
    if (!srcImage) {
      return;
    }
    const scale = parseFloat(scaleNumber.value);

    if (kernel === 'browser') {
      displayImage(srcImage, canvas, scale);
      return;
    }

    const srcImageData = getImageData(srcImage);
    const dstWidth = Math.max(3, Math.floor(srcImageData.width * scale));
    const dstHeight = Math.max(3, Math.floor(srcImageData.height * scale));

    const separableKernel = SEPARABLE_KERNELS[kernel];
    const dst = separableKernel === undefined
      ? resize(srcImageData, dstWidth, dstHeight, options)
      : resizeSeparable(srcImageData, dstWidth, dstHeight, {
          kernel: separableKernel,
          sRGBGamma: options.sRGBGamma,
          gamma: options.gamma,
          coverageWeightedAlpha: options.coverageWeightedAlpha,
        });
    const dstImageData = new ImageData(dst, dstWidth, dstHeight, { colorSpace: 'display-p3' });
    displayImageData(dstImageData, canvas);
  }

  function refreshOutput(): void {
    renderPanel(canvasA, kernelA.value);
    renderPanel(canvasB, kernelB.value);
  }

  async function selectImage(index: number): Promise<void> {
    currentIndex = (index + IMAGE_FILES.length) % IMAGE_FILES.length;
    const file = IMAGE_FILES[currentIndex];
    imageSelect.value = String(currentIndex);
    syncUrl();
    srcImage = await loadImage(IMAGE_DIR + file);
    displayImage(srcImage, srcCanvas);
    refreshOutput();
  }

  scaleNumber.addEventListener('input', () => {
    scaleRange.value = scaleNumber.value;
    syncUrl();
    refreshOutput();
  });
  scaleRange.addEventListener('input', () => {
    scaleNumber.value = scaleRange.value;
    syncUrl();
    refreshOutput();
  });
  coverageToggle.addEventListener('change', () => {
    options.coverageWeightedAlpha = coverageToggle.checked;
    syncUrl();
    refreshOutput();
  });
  sharpenNumber.addEventListener('input', () => {
    sharpenRange.value = sharpenNumber.value;
    options.sharpeningCoefficient = parseFloat(sharpenNumber.value);
    syncUrl();
    refreshOutput();
  });
  sharpenRange.addEventListener('input', () => {
    sharpenNumber.value = sharpenRange.value;
    options.sharpeningCoefficient = parseFloat(sharpenRange.value);
    syncUrl();
    refreshOutput();
  });
  kernelA.addEventListener('change', () => {
    syncUrl();
    refreshOutput();
  });
  kernelB.addEventListener('change', () => {
    syncUrl();
    refreshOutput();
  });
  backdropSelect.addEventListener('change', () => {
    document.body.dataset.backdrop = backdropSelect.value;
    syncUrl();
  });

  prevButton.addEventListener('click', () => void selectImage(currentIndex - 1));
  nextButton.addEventListener('click', () => void selectImage(currentIndex + 1));
  imageSelect.addEventListener('change', () => void selectImage(Number(imageSelect.value)));

  // React to back-forward navigation (e.g. manual URL edits committed via the
  // address bar surface here on history traversal).
  window.addEventListener('popstate', () => {
    const index = indexFromUrl();
    if (index !== currentIndex) {
      void selectImage(index);
    }
  });

  void selectImage(indexFromUrl());
});
