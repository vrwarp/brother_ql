/**
 * A deterministic stand-in for the canvas API.
 *
 * `src/browser/image-source.ts` needs a 2D context to flatten, resize and read
 * pixels. Node has none, but the module's logic — type dispatch, size
 * arithmetic, the flatten-onto-white ordering, buffer copying — is exactly
 * what needs testing, and none of it depends on the browser's resampling
 * filter. This context implements the four calls the module makes with the
 * simplest well-defined semantics: nearest-neighbour sampling and
 * integer source-over compositing.
 *
 * Install with `installFakeCanvas()` in a test and restore with
 * `vi.unstubAllGlobals()`.
 */

import { vi } from 'vitest';

export class FakeImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {
    if (data.length !== width * height * 4) {
      throw new RangeError('FakeImageData buffer does not match its dimensions.');
    }
  }
}

/** Anything the fake context can sample pixels from. */
interface Sampleable {
  readonly width: number;
  readonly height: number;
  samplePixels(): Uint8ClampedArray;
}

function isSampleable(value: unknown): value is Sampleable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Sampleable).samplePixels === 'function'
  );
}

export class FakeContext2D {
  imageSmoothingEnabled = false;
  imageSmoothingQuality = 'low';
  fillStyle = '';

  readonly pixels: Uint8ClampedArray;

  constructor(readonly canvas: FakeCanvasBase) {
    this.pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4);
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    // Only the one fill the module performs is supported: opaque white.
    if (this.fillStyle !== '#ffffff') {
      throw new Error(`FakeContext2D only fills white, got ${this.fillStyle}.`);
    }
    for (let row = y; row < y + height; row++) {
      const start = (row * this.canvas.width + x) * 4;
      this.pixels.fill(255, start, start + width * 4);
    }
  }

  putImageData(data: FakeImageData, x: number, y: number): void {
    for (let row = 0; row < data.height; row++) {
      const src = row * data.width * 4;
      const dst = ((y + row) * this.canvas.width + x) * 4;
      this.pixels.set(data.data.subarray(src, src + data.width * 4), dst);
    }
  }

  drawImage(source: unknown, x: number, y: number, width: number, height: number): void {
    if (!isSampleable(source)) {
      throw new TypeError('FakeContext2D cannot sample this source.');
    }
    const srcPixels = source.samplePixels();
    for (let oy = 0; oy < height; oy++) {
      const sy = Math.min(source.height - 1, Math.floor((oy * source.height) / height));
      for (let ox = 0; ox < width; ox++) {
        const sx = Math.min(source.width - 1, Math.floor((ox * source.width) / width));
        const src = (sy * source.width + sx) * 4;
        const dst = ((y + oy) * this.canvas.width + (x + ox)) * 4;
        const alpha = srcPixels[src + 3] as number;
        if (alpha === 255) {
          this.pixels[dst] = srcPixels[src] as number;
          this.pixels[dst + 1] = srcPixels[src + 1] as number;
          this.pixels[dst + 2] = srcPixels[src + 2] as number;
          this.pixels[dst + 3] = 255;
        } else {
          // Integer source-over onto whatever is there (the white fill).
          for (let c = 0; c < 3; c++) {
            const over = srcPixels[src + c] as number;
            const under = this.pixels[dst + c] as number;
            this.pixels[dst + c] = Math.round((over * alpha + under * (255 - alpha)) / 255);
          }
          this.pixels[dst + 3] = Math.max(alpha, this.pixels[dst + 3] as number);
        }
      }
    }
  }

  getImageData(x: number, y: number, width: number, height: number): FakeImageData {
    const out = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row++) {
      const src = ((y + row) * this.canvas.width + x) * 4;
      out.set(this.pixels.subarray(src, src + width * 4), row * width * 4);
    }
    return new FakeImageData(out, width, height);
  }
}

export class FakeCanvasBase implements Sampleable {
  #context: FakeContext2D | null = null;
  /** Set to true to make getContext return null, as a browser under memory pressure can. */
  static failContexts = false;

  constructor(
    public width: number,
    public height: number,
  ) {}

  getContext(kind: string): FakeContext2D | null {
    if (kind !== '2d' || FakeCanvasBase.failContexts) return null;
    this.#context ??= new FakeContext2D(this);
    return this.#context;
  }

  samplePixels(): Uint8ClampedArray {
    return this.getContext('2d')?.pixels ?? new Uint8ClampedArray(this.width * this.height * 4);
  }
}

export class FakeOffscreenCanvas extends FakeCanvasBase {}
export class FakeHTMLCanvasElement extends FakeCanvasBase {
  constructor() {
    super(0, 0);
  }
}

export class FakeImageBitmap implements Sampleable {
  closed = false;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly pixels: Uint8ClampedArray,
  ) {}

  close(): void {
    this.closed = true;
  }

  samplePixels(): Uint8ClampedArray {
    return this.pixels;
  }
}

export class FakeHTMLImageElement implements Sampleable {
  complete = true;
  decodeCalls = 0;
  width = 0;
  height = 0;
  naturalWidth = 0;
  naturalHeight = 0;
  // Annotated: the initialiser alone would infer the ArrayBuffer-backed
  // specialisation and reject caller-supplied views over other buffer kinds.
  #pixels: Uint8ClampedArray = new Uint8ClampedArray(0);

  setPixels(width: number, height: number, pixels: Uint8ClampedArray): void {
    this.naturalWidth = width;
    this.naturalHeight = height;
    this.#pixels = pixels;
  }

  async decode(): Promise<void> {
    this.decodeCalls += 1;
    this.complete = true;
  }

  samplePixels(): Uint8ClampedArray {
    return this.#pixels;
  }
}

export interface FakeCanvasWorld {
  /** Bitmaps handed out by the stubbed `createImageBitmap`, for asserting `close()`. */
  bitmaps: FakeImageBitmap[];
  /** Pixels the next `createImageBitmap(blob)` call decodes to. */
  setBlobPixels(width: number, height: number, pixels: FakeImageData['data']): void;
}

/**
 * Install the fake canvas API as globals.
 *
 * @param options.offscreen Install `OffscreenCanvas` (default). With `false`,
 *   a `document.createElement('canvas')` fallback is installed instead.
 */
export function installFakeCanvas(options: { offscreen?: boolean } = {}): FakeCanvasWorld {
  FakeCanvasBase.failContexts = false;
  vi.stubGlobal('ImageData', FakeImageData);
  vi.stubGlobal('ImageBitmap', FakeImageBitmap);
  vi.stubGlobal('HTMLImageElement', FakeHTMLImageElement);
  vi.stubGlobal('HTMLCanvasElement', FakeHTMLCanvasElement);

  if (options.offscreen ?? true) {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  } else {
    vi.stubGlobal('OffscreenCanvas', undefined);
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        if (tag !== 'canvas') throw new Error(`Unexpected createElement('${tag}').`);
        return new FakeHTMLCanvasElement();
      },
    });
  }

  const world: FakeCanvasWorld & { blobPixels: FakeImageData | null } = {
    bitmaps: [],
    blobPixels: null,
    setBlobPixels(width, height, pixels) {
      this.blobPixels = new FakeImageData(pixels, width, height);
    },
  };

  vi.stubGlobal('createImageBitmap', async (source: unknown): Promise<FakeImageBitmap> => {
    if (!(source instanceof Blob)) {
      throw new TypeError('The fake createImageBitmap only decodes Blobs.');
    }
    const decoded = world.blobPixels;
    if (!decoded) throw new Error('No blob pixels configured; call setBlobPixels first.');
    const bitmap = new FakeImageBitmap(decoded.width, decoded.height, decoded.data);
    world.bitmaps.push(bitmap);
    return bitmap;
  });

  return world;
}

/** An opaque single-colour RGBA buffer. */
export function solidPixels(
  width: number,
  height: number,
  [r, g, b, a]: [number, number, number, number],
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = a;
  }
  return out;
}
