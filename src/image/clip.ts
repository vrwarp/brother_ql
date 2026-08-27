/**
 * Pillow's `CLIP8` macro, from `src/libImaging/Imaging.h`.
 *
 * Shared by the two ports that need it (`dither.ts` and `hsv.ts`) rather than
 * written out in each: they have to clamp identically, because both feed the
 * same byte planes and a difference of one would move a dot between the black
 * and red planes.
 *
 * Kept as an explicit clamp even where the caller's arithmetic cannot leave the
 * range — `hsv.ts` provably cannot — so that the port stays line-for-line with
 * the C it comes from.
 */
export function clip8(v: number): number {
  // Stryker disable next-line EqualityOperator: `v < 0` is equivalent. The two
  // differ only at v === 0, where the first arm returns 0 and the second falls
  // through to `0 < 256 ? 0 : 255`, which is also 0. It is written `<= 0` to
  // match the C macro, not because zero needs the short cut.
  return v <= 0 ? 0 : v < 256 ? v : 255;
}
