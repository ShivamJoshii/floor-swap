// Image helpers: quality analysis, perspective crop (rectify), homography.
export type Quad = [number, number][]; // TL, TR, BR, BL in source pixels
export type Quality = { width: number; height: number; sharpness: number; score: number; warnings: string[] };

export async function loadBitmap(file: Blob, maxSide = 4000): Promise<ImageBitmap> {
  const bmp = await createImageBitmap(file);
  if (Math.max(bmp.width, bmp.height) <= maxSide) return bmp;
  const sc = maxSide / Math.max(bmp.width, bmp.height);
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  return await createImageBitmap(c);
}

/** Laplacian-variance sharpness on a 512px grayscale copy, plus resolution checks. */
export function analyze(bmp: ImageBitmap, region?: Quad): Quality {
  const w = 512, h = Math.max(32, Math.round(512 * bmp.height / bmp.width));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  let sum = 0, sum2 = 0, n = 0;
  const kx = w / bmp.width, ky = h / bmp.height;
  const inside = (x: number, y: number) => !region || pointInQuad(x / kx, y / ky, region);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    if (!inside(x, y)) continue;
    const i = y * w + x;
    const lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
    sum += lap; sum2 += lap * lap; n++;
  }
  const mean = n ? sum / n : 0, variance = n ? sum2 / n - mean * mean : 0;
  const sharpness = Math.sqrt(Math.max(0, variance));
  const long = Math.max(bmp.width, bmp.height);
  const warnings: string[] = [];
  if (long < 1500) warnings.push(`Low resolution (${bmp.width}×${bmp.height}). Aim for 2500 px or more on the long side.`);
  if (sharpness < 6) warnings.push("Looks soft or blurry. Reshoot or rescan.");
  const resScore = Math.min(50, Math.round(50 * Math.min(1, long / 2500)));
  const sharpScore = Math.min(50, Math.round(50 * Math.min(1, sharpness / 14)));
  return { width: bmp.width, height: bmp.height, sharpness: Math.round(sharpness * 10) / 10, score: resScore + sharpScore, warnings };
}

function pointInQuad(x: number, y: number, q: Quad) {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const [xi, yi] = q[i], [xj, yj] = q[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function solve(A: number[][], b: number[]) {
  const n = b.length; const M = A.map((r, i) => r.concat([b[i]]));
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / d; if (!f) continue; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / (r[i] || 1e-12));
}
export function homography(src: number[][], dst: number[][]) {
  const A: number[][] = [], b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i], [x, y] = dst[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  const h = solve(A, b); return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}
export function apply(m: number[], x: number, y: number): [number, number] {
  const d = m[6] * x + m[7] * y + m[8]; return [(m[0] * x + m[1] * y + m[2]) / d, (m[3] * x + m[4] * y + m[5]) / d];
}

/** Perspective-correct crop of `quad` out of `bmp`, sized to the quad's real edge lengths (no upscaling past the source). */
export function rectify(bmp: ImageBitmap, quad: Quad, maxSide = 3000): HTMLCanvasElement {
  const len = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const wEdge = (len(quad[0], quad[1]) + len(quad[3], quad[2])) / 2, hEdge = (len(quad[0], quad[3]) + len(quad[1], quad[2])) / 2;
  const sc = Math.min(1, maxSide / Math.max(wEdge, hEdge));
  const outW = Math.max(8, Math.round(wEdge * sc)), outH = Math.max(8, Math.round(hEdge * sc));
  const sc2 = document.createElement("canvas"); sc2.width = bmp.width; sc2.height = bmp.height;
  const sctx = sc2.getContext("2d", { willReadFrequently: true })!; sctx.drawImage(bmp, 0, 0);
  const sd = sctx.getImageData(0, 0, bmp.width, bmp.height).data, sw = bmp.width, sh = bmp.height;
  const Hm = homography([[0, 0], [outW, 0], [outW, outH], [0, outH]], quad);
  const out = new ImageData(outW, outH), o = out.data;
  const clamp = (v: number, a: number, b: number) => v < a ? a : v > b ? b : v;
  for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) {
    const [sx, sy] = apply(Hm, x + 0.5, y + 0.5);
    const fx = clamp(sx - 0.5, 0, sw - 1), fy = clamp(sy - 0.5, 0, sh - 1), x0 = fx | 0, y0 = fy | 0, x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1), ax = fx - x0, ay = fy - y0;
    const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4, o4 = (y * outW + x) * 4;
    for (let c = 0; c < 3; c++) o[o4 + c] = (sd[i00 + c] * (1 - ax) + sd[i10 + c] * ax) * (1 - ay) + (sd[i01 + c] * (1 - ax) + sd[i11 + c] * ax) * ay;
    o[o4 + 3] = 255;
  }
  const oc = document.createElement("canvas"); oc.width = outW; oc.height = outH; oc.getContext("2d")!.putImageData(out, 0, 0);
  return oc;
}

/** Grey-world white balance: scales channels so their means match (only applied when the user asks). */
export function whiteBalance(c: HTMLCanvasElement) {
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data; let r = 0, g = 0, b = 0;
  const n = d.length / 4; for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  r /= n; g /= n; b /= n; const m = (r + g + b) / 3; const kr = m / (r || 1), kg = m / (g || 1), kb = m / (b || 1);
  for (let i = 0; i < d.length; i += 4) { d[i] = Math.min(255, d[i] * kr); d[i + 1] = Math.min(255, d[i + 1] * kg); d[i + 2] = Math.min(255, d[i + 2] * kb); }
  ctx.putImageData(img, 0, 0);
}

export const canvasToJpeg = (c: HTMLCanvasElement, q = 0.92) => new Promise<Blob>((res, rej) => c.toBlob((b) => b ? res(b) : rej(new Error("encode failed")), "image/jpeg", q));
