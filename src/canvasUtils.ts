// Small canvas helpers for the demo: load images, pull pixels, and paint
// results. Canvases use the display-p3 color space so wide-gamut output is
// shown without clipping where the display supports it.

type Sized = { readonly width: number; readonly height: number };

function get2DContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', { colorSpace: 'display-p3' });
  if (!context) {
    throw new Error('Unable to acquire a 2D canvas context.');
  }
  return context;
}

/** Size `canvas` to `src` (optionally scaled) and return a cleared context. */
export function prepCanvas(src: Sized, canvas: HTMLCanvasElement, scale = 1.0): CanvasRenderingContext2D {
  canvas.width = Math.max(1, Math.round(src.width * scale));
  canvas.height = Math.max(1, Math.round(src.height * scale));
  const context = get2DContext(canvas);
  if (scale !== 1.0) {
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
  }
  context.clearRect(0, 0, canvas.width, canvas.height);
  return context;
}

/** Decode an image into an `ImageData` of straight-alpha RGBA pixels. */
export function getImageData(image: HTMLImageElement): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = get2DContext(canvas);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

/** Draw `image` to `canvas`, scaled by `scale` (browser resampling). */
export function displayImage(image: HTMLImageElement, canvas: HTMLCanvasElement, scale = 1.0): void {
  prepCanvas(image, canvas, scale).drawImage(image, 0, 0, image.width * scale, image.height * scale);
}

/** Paint `imageData` to `canvas` 1:1. */
export function displayImageData(imageData: ImageData, canvas: HTMLCanvasElement): void {
  prepCanvas(imageData, canvas).putImageData(imageData, 0, 0);
}

/** Load an image from `src`, resolving once it has decoded. */
export function loadImage(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  return new Promise((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    image.src = src;
  });
}
