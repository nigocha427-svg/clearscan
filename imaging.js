/* ClearScan — 画像処理ライブラリ
 * メインスレッド(枠検出)とワーカー(台形補正・切り抜き)の両方から読み込む。
 * 画像は {data: Uint8ClampedArray(RGBA), width, height} の形で扱う。
 */
(function (root) {
  'use strict';

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  /* 「紙らしさ」: 明るく、色味が少ないほど高い。
   * 明るい色柄の敷物やカラフルな背景を紙と取り違えないために、彩度(RGBの最大と最小の差)を差し引く。 */
  function toPaperness(img) {
    const { data, width: w, height: h } = img;
    const g = new Float32Array(w * h);
    for (let i = 0, p = 0; i < g.length; i++, p += 4) {
      const r = data[p], gr = data[p + 1], b = data[p + 2];
      const lum = 0.299 * r + 0.587 * gr + 0.114 * b;
      const chroma = Math.max(r, gr, b) - Math.min(r, gr, b);
      g[i] = Math.max(0, lum - 2 * chroma);
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

  /* 四角形 q の各辺について、内側と外側の「紙らしさ」(明るい側 80% 点)の差を調べる。
   * 本物の紙の縁なら内側(紙)が外側(背景)よりはっきり高くなる。
   * 文字の行や印刷された表の枠は、内外とも同じ紙なので差が出ない。
   * 画面の端に重なる辺(紙が画面からはみ出している)は「画面端」として別に数える。
   * ただし画面端の辺も、その内側が紙でなければ失格(背景ごと画面端まで囲う候補を落とす)。
   * paper: その候補の内側の紙の明るさの目安 */
  function sideStats(q, g, w, h, paper) {
    const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    const off = Math.max(3, Math.round(Math.max(w, h) / 80));
    const at = (x, y) => {
      x = Math.round(x); y = Math.round(y);
      return x < 0 || y < 0 || x >= w || y >= h ? -1 : g[y * w + x];
    };
    const res = { frame: 0, pass: 0, fail: 0, qual: 0, pos: 0, neg: 0 };
    for (let k = 0; k < 4; k++) {
      const a = q[k], b = q[(k + 1) % 4];
      let nx = b[1] - a[1], ny = a[0] - b[0];
      const len = Math.hypot(nx, ny) || 1; nx /= len; ny /= len;
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; } // 外向きにそろえる
      let n = 0, pos = 0, neg = 0;
      const insAll = [];
      for (let t = 0.06; t <= 0.94; t += 0.04) {
        const px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t;
        // 内側・外側それぞれ2点ずつ見る(文字の上に当たっても判定がぶれないように)
        const i1 = at(px - nx * (off + 1), py - ny * (off + 1)), i2 = at(px - nx * (off + 3), py - ny * (off + 3));
        const o1 = at(px + nx * off, py + ny * off), o2 = at(px + nx * (off + 2), py + ny * (off + 2));
        if (i1 < 0 || i2 < 0) continue;
        insAll.push(Math.max(i1, i2));
        if (o1 < 0 || o2 < 0) continue;
        n++;
        if (Math.max(i1, i2) - Math.max(o1, o2) >= 16) pos++;       // 内側が紙・外側が背景
        else if (Math.min(o1, o2) - Math.min(i1, i2) >= 16) neg++;  // 明るい背景に濃い色のカード
      }
      // 辺の内側の大半が「中身」と同じ明るさであること(中央値で判定)。
      // 画面端の辺は「紙が画面の外まで続いている」という主張なので、より厳しく見る
      const onFrame = n < 6;
      const median = insAll.length ? insAll.sort((x, y) => x - y)[insAll.length >> 1] : 0;
      if (median < paper * (onFrame ? 0.85 : 0.7)) { res.fail++; continue; }
      if (onFrame) { res.frame++; continue; }
      // 辺の大部分(65%以上)で、内と外の差がはっきりしていること
      const f = Math.max(pos, neg) / n;
      if (f >= 0.65) { res.pass++; res.qual += f; if (pos >= neg) res.pos++; else res.neg++; } else res.fail++;
    }
    return res;
  }

  function quadShapeOK(q, w, h) {
    if (!isConvex(q)) return false;
    const a = quadArea(q) / (w * h);
    if (a < 0.15 || a > 0.97) return false;
    // 極端に細長いものは紙ではない
    const W = (Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) + Math.hypot(q[2][0] - q[3][0], q[2][1] - q[3][1])) / 2;
    const H = (Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]) + Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1])) / 2;
    return W / H >= 0.3 && W / H <= 3.3;
  }

  /* 紙の縁らしい長い直線を探す(ハフ変換)。
   * 勾配の向きに沿って投票し、強い直線を最大 maxLines 本返す。 */
  function findLines(g, w, h, maxLines) {
    const nT = 90, step = Math.PI / nT;
    const cosT = new Float32Array(nT), sinT = new Float32Array(nT);
    for (let k = 0; k < nT; k++) { cosT[k] = Math.cos(k * step); sinT[k] = Math.sin(k * step); }
    const diag = Math.ceil(Math.hypot(w, h)), nR = diag + 1; // ρ は 2px 刻みで -diag〜diag
    const acc = new Float32Array(nT * nR);
    const gxs = new Float32Array(w * h), gys = new Float32Array(w * h), mag = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1];
      const gy = g[i + w - 1] + 2 * g[i + w] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - w] - g[i - w + 1];
      gxs[i] = gx; gys[i] = gy; mag[i] = Math.hypot(gx, gy);
    }
    const thr = Math.max(40, percentile(mag, 0.9));
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mag[i] <= thr) continue;
      let phi = Math.atan2(gys[i], gxs[i]);
      if (phi < 0) phi += Math.PI;
      const k0 = Math.round(phi / step);
      for (let dk = -3; dk <= 3; dk++) {
        const k = ((k0 + dk) % nT + nT) % nT;
        const rho = x * cosT[k] + y * sinT[k];
        acc[k * nR + Math.round((rho + diag) / 2)] += mag[i];
      }
    }
    // 強い順に取り出し、近い直線はまとめる
    const order = [];
    for (let i = 0; i < acc.length; i++) if (acc[i] > 0) order.push(i);
    order.sort((a, b) => acc[b] - acc[a]);
    const lines = [];
    for (const i of order) {
      if (lines.length >= maxLines) break;
      const k = Math.floor(i / nR), rho = (i % nR) * 2 - diag;
      const near = lines.some((l) => {
        let dk = Math.abs(l.k - k); dk = Math.min(dk, nT - dk);
        return dk <= 4 && Math.abs(l.rho - (dk === Math.abs(l.k - k) ? rho : -rho)) <= 8;
      });
      if (!near) lines.push({ k, theta: k * step, rho });
    }
    return lines;
  }

  function intersect(l1, l2) {
    const a1 = Math.cos(l1.theta), b1 = Math.sin(l1.theta), a2 = Math.cos(l2.theta), b2 = Math.sin(l2.theta);
    const det = a1 * b2 - a2 * b1;
    if (Math.abs(det) < 1e-6) return null;
    return [(l1.rho * b2 - l2.rho * b1) / det, (a1 * l2.rho - a2 * l1.rho) / det];
  }

  /* 書類の枠検出。小さめ(長辺 200〜320px)の画像を渡す。
   * 1) 紙の縁らしい直線(と画面の端)を組み合わせて四角形の候補を作る
   * 2) 紙の塊の四隅から作った候補も加える
   * 3) すべての辺で「内側が紙・外側が紙でない」と言える候補のうち、一番大きいものを選ぶ */
  function detectQuad(img) {
    const w = img.width, h = img.height, N = w * h;
    const g = boxBlur(toPaperness(img), w, h, 1);
    const candidates = [];

    // --- 1. 直線の組み合わせ
    const lines = findLines(g, w, h, 16);
    const horiz = [], vert = [];
    for (const l of lines) {
      const deg = l.theta * 180 / Math.PI;
      if (deg > 55 && deg < 125) horiz.push(l);          // 法線が縦 = 横向きの線
      else if (deg < 35 || deg > 145) vert.push(l);       // 法線が横 = 縦向きの線
    }
    // 画面の端も「縁」の候補にする(紙が画面からはみ出している場合)
    horiz.push({ theta: Math.PI / 2, rho: 0, frame: true }, { theta: Math.PI / 2, rho: h - 1, frame: true });
    vert.push({ theta: 0, rho: 0, frame: true }, { theta: 0, rho: w - 1, frame: true });
    const yAt = (l) => (l.rho - (w / 2) * Math.cos(l.theta)) / Math.sin(l.theta);
    const xAt = (l) => (l.rho - (h / 2) * Math.sin(l.theta)) / Math.cos(l.theta);
    for (let i = 0; i < horiz.length; i++) for (let j = 0; j < horiz.length; j++) {
      const top = horiz[i], bot = horiz[j];
      if (yAt(bot) - yAt(top) < h * 0.2) continue;
      for (let m = 0; m < vert.length; m++) for (let n = 0; n < vert.length; n++) {
        const left = vert[m], right = vert[n];
        if (xAt(right) - xAt(left) < w * 0.2) continue;
        if (top.frame && bot.frame && left.frame && right.frame) continue;
        const q = [intersect(top, left), intersect(top, right), intersect(bot, right), intersect(bot, left)];
        if (q.some((p) => !p || p[0] < -w * 0.05 || p[1] < -h * 0.05 || p[0] > w * 1.05 || p[1] > h * 1.05)) continue;
        candidates.push(q.map(([x, y]) => [clamp(x, 0, w - 1), clamp(y, 0, h - 1)]));
      }
    }

    // --- 2. 紙の塊の四隅(紙らしさで二値化した最大の塊)
    const t = otsu(g);
    const bright = new Uint8Array(N);
    for (let i = 0; i < N; i++) bright[i] = g[i] > t ? 1 : 0;
    const c = largestComponent(bright, w, h);
    if (c.count > N * 0.1) candidates.push(cornersOf(c.label, c.id, w, h));

    // --- 3. 評価: すべての辺の内側が紙で、画面端以外の辺では外側が紙でないこと
    // 紙の明るさの目安は候補ごとに、その四角形の内側から測る(影で全体が暗いページにも対応)
    const innerPaper = (q) => {
      const v = [];
      for (let i = 1; i < 8; i++) for (let j = 1; j < 8; j++) {
        const u = 0.1 + 0.8 * i / 8, t = 0.1 + 0.8 * j / 8;
        const x = (1 - t) * ((1 - u) * q[0][0] + u * q[1][0]) + t * ((1 - u) * q[3][0] + u * q[2][0]);
        const y = (1 - t) * ((1 - u) * q[0][1] + u * q[1][1]) + t * ((1 - u) * q[3][1] + u * q[2][1]);
        v.push(g[clamp(Math.round(y), 0, h - 1) * w + clamp(Math.round(x), 0, w - 1)]);
      }
      return v.sort((a, b) => a - b)[Math.floor(v.length * 0.75)];
    };
    let best = null, bestScore = 0;
    for (const q of candidates) {
      if (!quadShapeOK(q, w, h)) continue;
      const s = sideStats(q, g, w, h, innerPaper(q));
      // 失格の辺がなく、本物の縁が1本以上あり、明暗の向きがそろっていること
      if (s.fail > 0 || s.pass < 1 || (s.pos && s.neg)) continue;
      const area = quadArea(q) / N;
      // 大きいほど・本物の縁(画面端でない辺)が多いほど・縁の差がはっきりしているほど高得点
      const q2 = s.qual / s.pass;
      const score = area * (0.4 + 0.15 * s.pass) * q2 * q2;
      if (score > bestScore) { bestScore = score; best = { q, area }; }
    }
    if (!best) return null;
    // 縮小画像での誤差で背景がはみ出さないよう、わずかに内側へ寄せる
    const q = best.q.map(([x, y]) => [(x + 0.5) / w, (y + 0.5) / h]);
    const cx = q.reduce((a, p) => a + p[0], 0) / 4, cy = q.reduce((a, p) => a + p[1], 0) / 4;
    return { corners: q.map(([x, y]) => [x + (cx - x) * 0.02, y + (cy - y) * 0.02]), score: bestScore, area: best.area };
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

  // 時計回りに 90/180/270 度回転
  function rotate(img, deg) {
    deg = ((deg % 360) + 360) % 360;
    if (!deg) return img;
    const { data, width: w, height: h } = img;
    const W = deg === 180 ? w : h, H = deg === 180 ? h : w;
    const out = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let X, Y;
      if (deg === 90) { X = h - 1 - y; Y = x; } else if (deg === 180) { X = w - 1 - x; Y = h - 1 - y; } else { X = y; Y = w - 1 - x; }
      const s = (y * w + x) * 4, d = (Y * W + X) * 4;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = 255;
    }
    return { data: out, width: W, height: H };
  }

  /* 一連の処理: 台形補正(切り抜き) → 回転 → (見開き分割)
   * 見開きの綴じ目は正しい向きにしてから探す(横倒しのまま分けると上下に割れてしまうため) */
  function processPage(img, cornersNorm, opts, maxSide) {
    const quad = cornersNorm.map(([x, y]) => [x * img.width, y * img.height]);
    const [W, H] = outputSize(quad, maxSide || 2400);
    const page = rotate(warp(img, quad, W, H), opts.rotation || 0);
    return opts.split ? splitSpread(page) : [page];
  }

  root.Imaging = { detectQuad, warp, processPage, homography, outputSize, splitSpread };
})(typeof self !== 'undefined' ? self : this);
