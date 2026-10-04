/**
 * How a logo should be framed. `circle`: a round mark on a plain square,
 * shown cropped to the circle so the background doesn't show. `free`: already
 * transparent around the artwork, shown as it is. `square`: anything else,
 * shown in a rounded square.
 */
export type LogoShape = 'circle' | 'free' | 'square';

/** Reads full-size RGBA. Samples a few points, so it's cheap on any size. */
export function logoShape(data: ArrayLike<number>, width: number, height: number): LogoShape {
  if (width < 16 || height < 16) return 'square';
  const at = (x: number, y: number) => {
    const i = (Math.min(height - 1, Math.max(0, Math.round(y))) * width + Math.min(width - 1, Math.max(0, Math.round(x)))) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]] as const;
  };
  const inset = Math.max(2, Math.round(Math.min(width, height) * 0.01));
  const corners = [
    at(inset, inset),
    at(width - 1 - inset, inset),
    at(inset, height - 1 - inset),
    at(width - 1 - inset, height - 1 - inset)
  ];
  if (corners.every((c) => c[3] < 24)) return 'free';

  const near = (a: readonly number[], b: readonly number[], tol: number) =>
    Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) <= tol && Math.abs(a[3] - b[3]) <= 40;
  const bg = corners[0];
  if (!corners.every((c) => near(c, bg, 36))) return 'square';

  // A circle fills to the middle of each edge while leaving the corners as
  // background; the diagonal just inside a corner is background too.
  const edges = [at(width / 2, inset), at(width / 2, height - 1 - inset), at(inset, height / 2), at(width - 1 - inset, height / 2)];
  const diag = Math.min(width, height) * 0.1;
  const insideCorners = [at(diag, diag), at(width - 1 - diag, diag), at(diag, height - 1 - diag), at(width - 1 - diag, height - 1 - diag)];
  const edgesArt = edges.filter((e) => !near(e, bg, 60)).length;
  if (edgesArt >= 3 && insideCorners.every((c) => near(c, bg, 60))) return 'circle';
  return 'square';
}
