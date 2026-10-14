/* ClearScan — 画像処理ライブラリ
 * メインスレッド(枠検出)とワーカー(台形補正・補正処理)の両方から読み込む。
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

  function evaluate(label, id, count, w, h) {
    const N = w * h;
    const frac = count / N;
    if (frac < 0.1) return null;
    const q = cornersOf(label, id, w, h);
    if (!isConvex(q)) return null;
    const qa = quadArea(q);
    if (qa / N < 0.1) return null;
    const fill = count / Math.max(qa, 1); // 四角形らしさ
    if (fill < 0.72) return null;
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
    const thr = Math.max(40, percentile(mag, 0.86));
    const edge = new Uint8Array(N);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mag[i] > thr) { edge[i] = 1; edge[i - 1] = 1; edge[i + 1] = 1; edge[i - w] = 1; edge[i + w] = 1; }
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
    let res = evaluate(c.label, c.id, c.count, w, h);

    // --- 2. 明るさ方式(紙は背景より明るいことが多い)
    if (!res || res.area > 0.97) {
      const t = otsu(g);
      const bright = new Uint8Array(N);
      for (let i = 0; i < N; i++) bright[i] = g[i] > t ? 1 : 0;
      c = largestComponent(bright, w, h);
      const r2 = evaluate(c.label, c.id, c.count, w, h);
      if (r2 && r2.area < 0.97 && (!res || r2.score > res.score)) res = r2;
    }
    if (res && res.area > 0.97) return null;
    if (res) {
      // 縮小画像での誤差で背景がはみ出さないよう、わずかに内側へ寄せる
      const cx = res.corners.reduce((a, p) => a + p[0], 0) / 4, cy = res.corners.reduce((a, p) => a + p[1], 0) / 4;
      res.corners = res.corners.map(([x, y]) => [x + (cx - x) * 0.012, y + (cy - y) * 0.012]);
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

  // ---------- 補正 ----------
  // 肌色判定(YCbCr)
  function isSkin(r, g, b, loose) {
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    if (loose) return y > 40 && cr > 132 && cr < 185 && cb > 75 && cb < 135;
    return y > 60 && cr > 138 && cr < 178 && cb > 80 && cb < 128 && r > g && r > b;
  }

  /* 指マスク: 画像の端に接している肌色ブロックの塊を指とみなす。
   * 返り値: Uint8Array(w*h) 1=指 */
  function fingerMask(img, bs, gw, gh) {
    const { data, width: w, height: h } = img;
    const skinBlock = new Uint8Array(gw * gh);
    for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) {
      let n = 0, k = 0;
      const x1 = Math.min(w, (bx + 1) * bs), y1 = Math.min(h, (by + 1) * bs);
      for (let y = by * bs; y < y1; y += 2) for (let x = bx * bs; x < x1; x += 2) {
        const p = (y * w + x) * 4; n++;
        if (isSkin(data[p], data[p + 1], data[p + 2], false)) k++;
      }
      skinBlock[by * gw + bx] = k / Math.max(n, 1) > 0.45 ? 1 : 0;
    }
    // 端に接した成分だけ残す
    const lab = new Int32Array(gw * gh), keep = new Uint8Array(gw * gh);
    const stack = [];
    let id = 0;
    for (let i = 0; i < skinBlock.length; i++) {
      if (!skinBlock[i] || lab[i]) continue;
      id++; const members = []; let border = false;
      stack.push(i); lab[i] = id;
      while (stack.length) {
        const p = stack.pop(); members.push(p);
        const x = p % gw, y = (p / gw) | 0;
        if (x === 0 || y === 0 || x === gw - 1 || y === gh - 1) border = true;
        for (const q of [x > 0 ? p - 1 : -1, x < gw - 1 ? p + 1 : -1, y > 0 ? p - gw : -1, y < gh - 1 ? p + gw : -1]) {
          if (q >= 0 && skinBlock[q] && !lab[q]) { lab[q] = id; stack.push(q); }
        }
      }
      if (border && members.length < gw * gh * 0.3) members.forEach((m) => (keep[m] = 1));
    }
    if (!keep.some((v) => v)) return null;
    // 1ブロック膨張した範囲でゆるい肌色判定、中心ブロックは全塗り
    const ring = new Uint8Array(gw * gh);
    for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) {
      if (!keep[by * gw + bx]) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = bx + dx, y = by + dy;
        if (x >= 0 && y >= 0 && x < gw && y < gh) ring[y * gw + x] = 1;
      }
    }
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const by = Math.min(gh - 1, (y / bs) | 0);
      for (let x = 0; x < w; x++) {
        const bi = by * gw + Math.min(gw - 1, (x / bs) | 0);
        if (!ring[bi]) continue;
        const p = (y * w + x) * 4;
        if (keep[bi] || isSkin(data[p], data[p + 1], data[p + 2], true)) mask[y * w + x] = 1;
      }
    }
    // 輪郭の影も含めるため数ピクセル膨張
    const r = Math.max(2, Math.round(bs / 8));
    const blurred = boxBlur(Float32Array.from(mask), w, h, r);
    for (let i = 0; i < mask.length; i++) mask[i] = blurred[i] > 0.02 ? 1 : 0;
    return mask;
  }

  /* 紙の地色(背景)をブロック単位で推定する。影・ムラ・色かぶりを含む。
   * 各ブロックの明るい側(上位10%)の平均色を背景とみなす。 */
  function estimateBackground(img, mask, bs, gw, gh) {
    const { data, width: w, height: h } = img;
    const bg = new Float32Array(gw * gh * 3);
    const valid = new Uint8Array(gw * gh);
    const hist = new Uint32Array(64);
    for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) {
      hist.fill(0);
      let n = 0, total = 0;
      const x1 = Math.min(w, (bx + 1) * bs), y1 = Math.min(h, (by + 1) * bs);
      for (let y = by * bs; y < y1; y++) for (let x = bx * bs; x < x1; x++) {
        total++;
        if (mask && mask[y * w + x]) continue;
        const p = (y * w + x) * 4;
        hist[((0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) / 4.05) | 0]++; n++;
      }
      if (n < total * 0.15 || n < 8) continue;
      let acc = 0, t = 63;
      for (; t > 0; t--) { acc += hist[t]; if (acc >= n * 0.1) break; }
      const lo = t * 4.05;
      let sr = 0, sg = 0, sb = 0, k = 0;
      for (let y = by * bs; y < y1; y++) for (let x = bx * bs; x < x1; x++) {
        if (mask && mask[y * w + x]) continue;
        const p = (y * w + x) * 4;
        if (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2] >= lo) { sr += data[p]; sg += data[p + 1]; sb += data[p + 2]; k++; }
      }
      const bi = (by * gw + bx) * 3;
      bg[bi] = sr / k; bg[bi + 1] = sg / k; bg[bi + 2] = sb / k;
      valid[by * gw + bx] = 1;
    }
    // 無効ブロックを近傍で埋める
    for (let iter = 0; iter < gw + gh; iter++) {
      let missing = 0;
      const nv = valid.slice();
      for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) {
        const i = by * gw + bx;
        if (valid[i]) continue;
        let s0 = 0, s1 = 0, s2 = 0, k = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const x = bx + dx, y = by + dy;
          if (x < 0 || y < 0 || x >= gw || y >= gh || !valid[y * gw + x]) continue;
          const j = (y * gw + x) * 3; s0 += bg[j]; s1 += bg[j + 1]; s2 += bg[j + 2]; k++;
        }
        if (k) { bg[i * 3] = s0 / k; bg[i * 3 + 1] = s1 / k; bg[i * 3 + 2] = s2 / k; nv[i] = 1; } else missing++;
      }
      valid.set(nv);
      if (!missing) break;
    }
    for (let i = 0; i < valid.length; i++) if (!valid[i]) { bg[i * 3] = bg[i * 3 + 1] = bg[i * 3 + 2] = 235; }

    // 紙全体の白さ(上位ブロック)を基準に、写真や図版で暗くなりすぎたブロックを持ち上げる
    const lums = new Float32Array(gw * gh);
    for (let i = 0; i < lums.length; i++) lums[i] = 0.299 * bg[i * 3] + 0.587 * bg[i * 3 + 1] + 0.114 * bg[i * 3 + 2];
    const paper = Math.max(60, percentile(lums, 0.9));
    for (let i = 0; i < lums.length; i++) {
      const floor = paper * 0.5;
      if (lums[i] < floor) { const f = floor / Math.max(lums[i], 1); bg[i * 3] *= f; bg[i * 3 + 1] *= f; bg[i * 3 + 2] *= f; }
    }
    // 3x3 最大値 → ぼかし(太字の見出しなどを背景に含めない)
    const mx = new Float32Array(bg.length);
    for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) {
      let best = -1, bj = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = bx + dx, y = by + dy;
        if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
        if (lums[y * gw + x] > best) { best = lums[y * gw + x]; bj = y * gw + x; }
      }
      const i = by * gw + bx;
      // 最大値と自分の値の中間を採用(影の境界を残しすぎない)
      for (let c = 0; c < 3; c++) mx[i * 3 + c] = (bg[bj * 3 + c] * 0.6 + bg[i * 3 + c] * 0.4);
    }
    for (let c = 0; c < 3; c++) {
      const ch = new Float32Array(gw * gh);
      for (let i = 0; i < ch.length; i++) ch[i] = mx[i * 3 + c];
      const bl = boxBlur(boxBlur(ch, gw, gh, 1), gw, gh, 1);
      for (let i = 0; i < ch.length; i++) bg[i * 3 + c] = bl[i];
    }
    return { bg, paper };
  }

  function sampleGrid(bg, gw, gh, bs, x, y, out) {
    let gx = (x + 0.5) / bs - 0.5, gy = (y + 0.5) / bs - 0.5;
    gx = clamp(gx, 0, gw - 1); gy = clamp(gy, 0, gh - 1);
    const x0 = Math.min(gw - 2, gx | 0), y0 = Math.min(gh - 2, gy | 0);
    if (gw < 2 || gh < 2) { out[0] = bg[0]; out[1] = bg[1]; out[2] = bg[2]; return; }
    const ax = gx - x0, ay = gy - y0;
    const i00 = (y0 * gw + x0) * 3, i10 = i00 + 3, i01 = i00 + gw * 3, i11 = i01 + 3;
    for (let c = 0; c < 3; c++) {
      const t = bg[i00 + c] + (bg[i10 + c] - bg[i00 + c]) * ax;
      const b = bg[i01 + c] + (bg[i11 + c] - bg[i01 + c]) * ax;
      out[c] = t + (b - t) * ay;
    }
  }

  function sharpen(img, amount) {
    const { data, width: w, height: h } = img;
    const src = new Uint8ClampedArray(data);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const p = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const n = (src[p - 4 + c] + src[p + 4 + c] + src[p - w * 4 + c] + src[p + w * 4 + c]) / 4;
        data[p + c] = src[p + c] + (src[p + c] - n) * amount;
      }
    }
  }

  /* opts: { mode: auto|color|gray|bw|photo|original, shadow, finger, clean } */
  function enhance(img, opts) {
    const { data, width: w, height: h } = img;
    const mode = opts.mode || 'auto';
    if (mode === 'original') return img;
    const bs = Math.max(8, Math.round(Math.max(w, h) / 48));
    const gw = Math.ceil(w / bs), gh = Math.ceil(h / bs);
    const mask = opts.finger ? fingerMask(img, bs, gw, gh) : null;
    const { bg, paper } = estimateBackground(img, mask, bs, gw, gh);
    const out = new Uint8ClampedArray(data.length);
    const b = [0, 0, 0];

    if (mode === 'photo') {
      // 身分証・写真: 背景で割らず、全体のレベル補正だけ行う
      const lo = [255, 255, 255], hi = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const ch = new Float32Array(w * h);
        for (let i = 0; i < ch.length; i++) ch[i] = data[i * 4 + c];
        lo[c] = percentile(ch, 0.01); hi[c] = Math.max(lo[c] + 40, percentile(ch, 0.99));
      }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        let r = data[p], g = data[p + 1], bl = data[p + 2];
        if (mask && mask[y * w + x]) { sampleGrid(bg, gw, gh, bs, x, y, b); r = b[0]; g = b[1]; bl = b[2]; }
        out[p] = (r - lo[0]) / (hi[0] - lo[0]) * 255;
        out[p + 1] = (g - lo[1]) / (hi[1] - lo[1]) * 255;
        out[p + 2] = (bl - lo[2]) / (hi[2] - lo[2]) * 255;
        out[p + 3] = 255;
      }
      const res = { data: out, width: w, height: h };
      sharpen(res, 0.25);
      return res;
    }

    // 影除去なしの場合は紙全体の平均色で割る(色かぶり補正のみ)
    let gr = 0, gg = 0, gb = 0;
    if (!opts.shadow) {
      for (let i = 0; i < gw * gh; i++) { gr += bg[i * 3]; gg += bg[i * 3 + 1]; gb += bg[i * 3 + 2]; }
      const n = gw * gh; gr /= n; gg /= n; gb /= n;
    }
    const white = opts.clean ? (mode === 'color' ? 0.9 : 0.86) : 0.97;
    const black = mode === 'color' ? 0.18 : 0.28;
    const span = white - black;
    const bw = mode === 'bw';
    const gray = mode === 'gray';

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, p = i * 4;
        if (opts.shadow) sampleGrid(bg, gw, gh, bs, x, y, b); else { b[0] = gr; b[1] = gg; b[2] = gb; }
        if (mask && mask[i]) { out[p] = out[p + 1] = out[p + 2] = 255; out[p + 3] = 255; continue; }
        let r = data[p] / Math.max(b[0], 1), g = data[p + 1] / Math.max(b[1], 1), bl = data[p + 2] / Math.max(b[2], 1);
        if (bw || gray) {
          const l = 0.299 * r + 0.587 * g + 0.114 * bl;
          let v;
          if (bw) v = clamp((l - 0.6) / (0.8 - 0.6), 0, 1);
          else { v = clamp((l - black) / span, 0, 1); v = Math.pow(v, 1.15); }
          out[p] = out[p + 1] = out[p + 2] = v * 255;
        } else {
          r = clamp((r - black) / span, 0, 1); g = clamp((g - black) / span, 0, 1); bl = clamp((bl - black) / span, 0, 1);
          out[p] = Math.pow(r, 1.12) * 255; out[p + 1] = Math.pow(g, 1.12) * 255; out[p + 2] = Math.pow(bl, 1.12) * 255;
        }
        out[p + 3] = 255;
      }
    }
    const res = { data: out, width: w, height: h };
    if (!bw) sharpen(res, 0.35);
    return res;
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

  /* 一連の処理: 台形補正 → (見開き分割) → 補正 */
  function processPage(img, cornersNorm, opts, maxSide) {
    const quad = cornersNorm.map(([x, y]) => [x * img.width, y * img.height]);
    const [W, H] = outputSize(quad, maxSide || 2400);
    const warped = warp(img, quad, W, H);
    const parts = opts.split ? splitSpread(warped) : [warped];
    return parts.map((p) => enhance(p, opts));
  }

  root.Imaging = { detectQuad, warp, enhance, processPage, homography, outputSize, splitSpread };
})(typeof self !== 'undefined' ? self : this);
