/* ClearScan — 画像処理ワーカー(重い処理を画面の裏で行う) */
importScripts('imaging.js');

self.onmessage = (e) => {
  const { id, width, height, buffer, corners, opts, maxSide, part } = e.data;
  try {
    const img = { data: new Uint8ClampedArray(buffer), width, height };
    const parts = Imaging.processPage(img, corners, opts, maxSide);
    const out = parts[part || 0] || parts[0];
    self.postMessage({ id, ok: true, width: out.width, height: out.height, buffer: out.data.buffer, parts: parts.length }, [out.data.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
