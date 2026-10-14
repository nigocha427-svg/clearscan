/* ClearScan — 画像処理ライブラリ
 * メインスレッド(枠検出)とワーカー(台形補正・切り抜き)の両方から読み込む。
 * 画像は {data: Uint8ClampedArray(RGBA), width, height} の形で扱う。
 */
(function (root) {
  'use strict';

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  function toGray(img) {
    const { data, width: w, height: h } = img;
    const g = new Float32Array(w * h);
    for (let i = 0, p = 0; i < g.length; i++, p += 4) {
      g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    }
    return g;
  }

  // 分離型ボックスブラー
  function boxBlur(src, w, h, r) {
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    const k = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      let s = 0;
      const row = y * w;
      for (let x = -r; x <= r; x++) s += src[row + clamp(x, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = s / k;
        s += src[row + clamp(x + r + 1, 0, w - 1)] - src[row + clamp(x - r, 0, w - 1)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += tmp[clamp(y, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = s / k;
        s += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x];
      }
    }
    return out;
  }

  function percentile(arr, q) {
    const hist = new Uint32Array(1024);
    let max = 1e-6;
    for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
    for (let i = 0; i < arr.length; i++) hist[Math.min(1023, (arr[i] / max * 1023) | 0)]++;
    const target = arr.length * q;
    let acc = 0;
    for (let i = 0; i < 1024; i++) { acc += hist[i]; if (acc >= target) return (i / 1023) * max; }
    return max;
  }

  function otsu(g) {
    const hist = new Float64Array(256);
    for (let i = 0; i < g.length; i++) hist[clamp(g[i] | 0, 0, 255)]++;
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = g.length - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; }
    }
    return thr;
  }

  // mask(Uint8) の最大連結成分。{pixels:Int32Array, count, touchesBorder}
  function largestComponent(mask, w, h) {
    const label = new Int32Array(w * h);
    const stack = new Int32Array(w * h);
    let bestCount = 0, bestId = 0, id = 0;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i] || label[i]) continue;
      id++;
      let sp = 0, count = 0;
      stack[sp++] = i; label[i] = id;
      while (sp) {
        const p = stack[--sp]; count++;
        const x = p % w, y = (p / w) | 0;
        if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = id; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && !label[p - w]) { label[p - w] = id; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && !label[p + w]) { label[p + w] = id; stack[sp++] = p + w; }
      }
      if (count > bestCount) { bestCount = count; bestId = id; }
    }
    return { label, id: bestId, count: bestCount };
  }

  // 成分の4隅(左上・右上・右下・左下)を対角方向の極値から求める
  function cornersOf(label, id, w, h) {
    let tl = [0, 0], tr = [0, 0], br = [0, 0], bl = [0, 0];
    let minS = Infinity, maxS = -Infinity, minD = Infinity, maxD = -Infinity;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (label[y * w + x] !== id) continue;
      const s = x + y, d = x - y;
      if (s < minS) { minS = s; tl = [x, y]; }
      if (s > maxS) { maxS = s; br = [x, y]; }
      if (d > maxD) { maxD = d; tr = [x, y]; }
      if (d < minD) { minD = d; bl = [x, y]; }
    }
    return [tl, tr, br, bl];
  }

  function quadArea(q) {
    let a = 0;
    for (let i = 0; i < 4; i++) { const p = q[i], n = q[(i + 1) % 4]; a += p[0] * n[1] - n[0] * p[1]; }
    return Math.abs(a) / 2;
  }

  function isConvex(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(z) < 1e-9) continue;
      const s = Math.sign(z);
      if (sign && s !== sign) return false;
      sign = s;
    }
    return true;
  }

  /* 各辺の内側と外側の「地の明るさ」(明るい側 80% 点)の差。本物の紙の縁なら差がはっきり出る。
   * 文字の固まりや印刷された表の枠は、内外とも同じ紙なので差が出ない。
   * 画面の端に接している辺(紙が画面からはみ出している)は合格扱い。 */
  function sidesWithContrast(q, g, w, h) {
    const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    const off = Math.max(3, Math.round(Math.max(w, h) / 80));
    let ok = 0;
    for (let k = 0; k < 4; k++) {
      const a = q[k], b = q[(k + 1) % 4];
      let nx = b[1] - a[1], ny = a[0] - b[0];
      const len = Math.hypot(nx, ny) || 1; nx /= len; ny /= len;
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; } // 外向きにそろえる
      const ins = [], outs = [];
      let outOfFrame = 0;
      for (let t = 0.1; t <= 0.9; t += 0.04) {
        const px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t;
        const ox = Math.round(px + nx * off), oy = Math.round(py + ny * off);
        // 検出した輪郭は太らせたエッジの外側にあるので、内側はさらに少し奥を見る
        const ix = Math.round(px - nx * (off + 3)), iy = Math.round(py - ny * (off + 3));
        if (ox < 0 || oy < 0 || ox >= w || oy >= h) { outOfFrame++; continue; }
        if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
        ins.push(g[iy * w + ix]); outs.push(g[oy * w + ox]);
      }
      const n = ins.length;
      const p80 = (arr) => arr.sort((x, y) => x - y)[Math.floor(arr.length * 0.8)];
      if (outOfFrame > n) ok++;
      else if (n >= 4 && Math.abs(p80(ins) - p80(outs)) >= 14) ok++;
    }
    return ok;
  }

  function evaluate(label, id, count, w, h, g) {
    const N = w * h;
    const frac = count / N;
    if (frac < 0.1) return null;
    const q = cornersOf(label, id, w, h);
    if (!isConvex(q)) return null;
    const qa = quadArea(q);
    if (qa / N < 0.2) return null;
    const fill = count / Math.max(qa, 1); // 四角形らしさ
    if (fill < 0.65) return null;
    // 極端に細長いものは紙ではない
    const W = (Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) + Math.hypot(q[2][0] - q[3][0], q[2][1] - q[3][1])) / 2;
    const H = (Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]) + Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1])) / 2;
    if (W / H < 0.33 || W / H > 3) return null;
    if (sidesWithContrast(q, g, w, h) < 3) return null;
    return { corners: q.map(([x, y]) => [(x + 0.5) / w, (y + 0.5) / h]), score: fill, area: qa / N };
  }

  /* 書類の枠検出。小さめ(長辺 200〜320px)の画像を渡す。
   * 1) エッジの外側を塗りつぶして閉じた領域を探す
   * 2) だめなら明るさの二値化で紙を探す */
  function detectQuad(img) {
    const w = img.width, h = img.height, N = w * h;
    const g = boxBlur(toGray(img), w, h, 1);

    // --- 1. エッジ方式
    const mag = new Float32Array(N);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1];
      const gy = g[i + w - 1] + 2 * g[i + w] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - w] - g[i - w + 1];
      mag[i] = Math.abs(gx) + Math.abs(gy);
    }
    const thr = Math.max(30, percentile(mag, 0.86));
    // エッジを2ピクセル太らせて、指や影で途切れた紙の輪郭をつなぐ
    const edge = new Uint8Array(N);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      if (mag[y * w + x] <= thr) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && xx >= 0 && yy < h && xx < w) edge[yy * w + xx] = 1;
      }
    }
    const outside = new Uint8Array(N);
    const stack = new Int32Array(N);
    let sp = 0;
    const seed = (i) => { if (!edge[i] && !outside[i]) { outside[i] = 1; stack[sp++] = i; } };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (sp) {
      const p = stack[--sp];
      const x = p % w, y = (p / w) | 0;
      if (x > 0) seed(p - 1);
      if (x < w - 1) seed(p + 1);
      if (y > 0) seed(p - w);
      if (y < h - 1) seed(p + w);
    }
    const inner = new Uint8Array(N);
    for (let i = 0; i < N; i++) inner[i] = outside[i] ? 0 : 1;
    let c = largestComponent(inner, w, h);
    let res = evaluate(c.label, c.id, c.count, w, h, g);

    // --- 2. 明るさ方式(紙は背景より明るいことが多い)
    if (!res || res.area > 0.97) {
      const t = otsu(g);
      const bright = new Uint8Array(N);
      for (let i = 0; i < N; i++) bright[i] = g[i] > t ? 1 : 0;
      c = largestComponent(bright, w, h);
      const r2 = evaluate(c.label, c.id, c.count, w, h, g);
      if (r2 && r2.area < 0.97 && (!res || r2.score > res.score)) res = r2;
    }
    if (res && res.area > 0.97) return null;
    if (res) {
      // 縮小画像での誤差で背景がはみ出さないよう、わずかに内側へ寄せる
      const cx = res.corners.reduce((a, p) => a + p[0], 0) / 4, cy = res.corners.reduce((a, p) => a + p[1], 0) / 4;
      res.corners = res.corners.map(([x, y]) => [x + (cx - x) * 0.025, y + (cy - y) * 0.025]);
    }
    return res;
  }

  // ---------- 射影変換 ----------
  function solve(A, b) {
    const n = b.length;
    for (let i = 0; i < n; i++) {
      let max = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[max][i])) max = r;
      [A[i], A[max]] = [A[max], A[i]]; [b[i], b[max]] = [b[max], b[i]];
      for (let r = i + 1; r < n; r++) {
        const f = A[r][i] / A[i][i];
        for (let k = i; k < n; k++) A[r][k] -= f * A[i][k];
        b[r] -= f * b[i];
      }
    }
    const x = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i];
      for (let k = i + 1; k < n; k++) s -= A[i][k] * x[k];
      x[i] = s / A[i][i];
    }
    return x;
  }

  // from[i] → to[i] へ写すホモグラフィ
  function homography(from, to) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = from[i], [u, v] = to[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = solve(A, b);
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  // 台形補正後のサイズを決める(元画像ピクセル座標の quad)
  function outputSize(quad, maxSide) {
    let W = (dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2;
    let H = (dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2;
    const s = Math.min(1, maxSide / Math.max(W, H));
    return [Math.max(16, Math.round(W * s)), Math.max(16, Math.round(H * s))];
  }

  function warp(img, quad, outW, outH) {
    const { data: s, width: sw, height: sh } = img;
    const H = homography([[0, 0], [outW, 0], [outW, outH], [0, outH]], quad);
    const out = new Uint8ClampedArray(outW * outH * 4);
    let o = 0;
    for (let y = 0; y < outH; y++) {
      const fy = y + 0.5;
      for (let x = 0; x < outW; x++, o += 4) {
        const fx = x + 0.5;
        const den = H[6] * fx + H[7] * fy + 1;
        let u = (H[0] * fx + H[1] * fy + H[2]) / den - 0.5;
        let v = (H[3] * fx + H[4] * fy + H[5]) / den - 0.5;
        u = clamp(u, 0, sw - 1.001); v = clamp(v, 0, sh - 1.001);
        const x0 = u | 0, y0 = v | 0, ax = u - x0, ay = v - y0;
        const p = (y0 * sw + x0) * 4, q = p + sw * 4;
        for (let c = 0; c < 3; c++) {
          const top = s[p + c] + (s[p + 4 + c] - s[p + c]) * ax;
          const bot = s[q + c] + (s[q + 4 + c] - s[q + c]) * ax;
          out[o + c] = top + (bot - top) * ay;
        }
        out[o + 3] = 255;
      }
    }
    return { data: out, width: outW, height: outH };
  }

  // 見開きの綴じ目(中央付近で最も暗い列)を探す
  function findGutter(img) {
    const { data, width: w, height: h } = img;
    const x0 = Math.round(w * 0.38), x1 = Math.round(w * 0.62);
    let best = Infinity, bx = Math.round(w / 2);
    const prof = [];
    for (let x = x0; x < x1; x++) {
      let s = 0;
      for (let y = Math.round(h * 0.1); y < h * 0.9; y += 3) { const p = (y * w + x) * 4; s += data[p] + data[p + 1] + data[p + 2]; }
      prof.push(s);
    }
    for (let i = 2; i < prof.length - 2; i++) {
      const v = prof[i - 2] + prof[i - 1] + prof[i] + prof[i + 1] + prof[i + 2];
      if (v < best) { best = v; bx = x0 + i; }
    }
    return bx;
  }

  function crop(img, x, y, cw, ch) {
    const out = new Uint8ClampedArray(cw * ch * 4);
    for (let r = 0; r < ch; r++) {
      const s = ((y + r) * img.width + x) * 4;
      out.set(img.data.subarray(s, s + cw * 4), r * cw * 4);
    }
    return { data: out, width: cw, height: ch };
  }

  function splitSpread(img) {
    const g = findGutter(img);
    return [crop(img, 0, 0, g, img.height), crop(img, g, 0, img.width - g, img.height)];
  }

  /* 一連の処理: 台形補正(切り抜き) → (見開き分割) */
  function processPage(img, cornersNorm, opts, maxSide) {
    const quad = cornersNorm.map(([x, y]) => [x * img.width, y * img.height]);
    const [W, H] = outputSize(quad, maxSide || 2400);
    const warped = warp(img, quad, W, H);
    return opts.split ? splitSpread(warped) : [warped];
  }

  root.Imaging = { detectQuad, warp, processPage, homography, outputSize, splitSpread };
})(typeof self !== 'undefined' ? self : this);
