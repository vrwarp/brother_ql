/**
 * The printed test card.
 *
 * Protocol traces cannot see a mirrored or rotated print: a wrong-way-round
 * job is byte-perfect on the wire. The card makes orientation mistakes
 * unmissable on paper, and it is painted with pure integer rectangle fills —
 * no canvas, no fonts — so the same inputs produce the same RGBA bytes on
 * every machine. That determinism is what lets the job bytes inside a bundle
 * be reproduced exactly by a test later.
 *
 * Layout (before any rotation the pipeline applies):
 *  - a frame around the whole card;
 *  - four *distinct* corner marks — the top-left carries a large L, the other
 *    corners squares of three different sizes — so every one of the eight
 *    flip/rotation cases lands in a visibly different state;
 *  - a large "F", asymmetric in both axes, filling the middle;
 *  - a staircase running towards bottom-right;
 *  - a fine comb of 1-dot lines at the bottom, which shows missing or weak
 *    print-head dots;
 *  - in two-colour mode, a red bar beside the F and a red segment in the
 *    frame, which shows black/red plane alignment.
 */

import type { RawImage } from '@vrwarp/brother-ql-webusb';

export interface TestCardOptions {
  /** Paint the red elements for a black/red label. Defaults to false. */
  red?: boolean;
  /** Feature scale; pass 2 for a 600 dpi card. Defaults to 1. */
  scale?: number;
}

const BLACK = [0, 0, 0] as const;
const RED = [255, 0, 0] as const;

type Rgb = readonly [number, number, number];

function fillRect(
  image: { width: number; height: number; data: Uint8Array },
  x: number,
  y: number,
  w: number,
  h: number,
  rgb: Rgb,
): void {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(image.width, x + w);
  const y1 = Math.min(image.height, y + h);
  for (let py = y0; py < y1; py++) {
    let offset = (py * image.width + x0) * 4;
    for (let px = x0; px < x1; px++) {
      image.data[offset] = rgb[0];
      image.data[offset + 1] = rgb[1];
      image.data[offset + 2] = rgb[2];
      image.data[offset + 3] = 255;
      offset += 4;
    }
  }
}

/** Paint the card at the given pixel size. Deterministic. */
export function paintTestCard(
  width: number,
  height: number,
  options: TestCardOptions = {},
): RawImage {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 32 || height < 32) {
    throw new RangeError(`Test card needs at least 32x32 pixels, got ${width}x${height}.`);
  }
  const s = Math.max(1, Math.floor(options.scale ?? 1));
  const red = options.red ?? false;

  const image = {
    width,
    height,
    data: new Uint8Array(width * height * 4).fill(255),
  };

  const line = 2 * s; // base stroke
  const margin = 4 * s;

  // Frame.
  fillRect(image, 0, 0, width, line, BLACK);
  fillRect(image, 0, height - line, width, line, BLACK);
  fillRect(image, 0, 0, line, height, BLACK);
  fillRect(image, width - line, 0, line, height, BLACK);
  if (red) {
    // A red segment in the top frame: shows plane alignment against black.
    fillRect(image, Math.floor(width / 2), 0, Math.floor(width / 4), line, RED);
  }

  // Corner marks, all different so any flip or rotation is identifiable.
  const unit = Math.max(3 * s, Math.floor(Math.min(width, height) / 16));
  // Top-left: a thick L.
  fillRect(image, margin, margin, unit * 3, unit, BLACK);
  fillRect(image, margin, margin, unit, unit * 3, BLACK);
  // Top-right: large square.
  fillRect(image, width - margin - unit * 2, margin, unit * 2, unit * 2, BLACK);
  // Bottom-left: medium square.
  fillRect(image, margin, height - margin - unit - Math.floor(unit / 2), unit, unit, BLACK);
  // Bottom-right: small square.
  const small = Math.max(2 * s, Math.floor(unit / 2));
  fillRect(image, width - margin - small, height - margin - small * 2, small, small, BLACK);

  // The F: hangs off a left stem, with the top arm longer than the middle one
  // — asymmetric horizontally (arms point right) and vertically (no bottom
  // arm). Sized from the card's middle band.
  const fx = Math.floor(width * 0.22);
  const fy = Math.floor(height * 0.2);
  const fw = Math.floor(width * 0.4);
  const fh = Math.floor(height * 0.45);
  const stroke = Math.max(line * 2, Math.floor(Math.min(fw, fh) / 5));
  fillRect(image, fx, fy, stroke, fh, BLACK); // stem
  fillRect(image, fx, fy, fw, stroke, BLACK); // top arm
  fillRect(image, fx, fy + Math.floor(fh / 2), Math.floor(fw * 0.7), stroke, BLACK); // middle arm

  if (red) {
    // Red bar to the right of the F.
    fillRect(image, fx + fw + margin, fy, stroke, fh, RED);
  }

  // Staircase towards bottom-right.
  const steps = 4;
  const stepSize = Math.max(2 * s, Math.floor(Math.min(width, height) / 20));
  const sx = Math.floor(width * 0.68);
  const sy = Math.floor(height * 0.62);
  for (let i = 0; i < steps; i++) {
    fillRect(image, sx + i * stepSize, sy + i * stepSize, stepSize, stepSize, BLACK);
  }

  // Fine comb near the bottom: alternating 1*s-wide columns.
  const combTop = height - margin - 8 * s;
  const combHeight = 6 * s;
  if (combTop > line) {
    for (let x = margin * 2; x < Math.floor(width / 2); x += 2 * s) {
      fillRect(image, x, combTop, s, combHeight, BLACK);
    }
  }

  return image;
}
