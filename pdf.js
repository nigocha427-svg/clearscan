/* ClearScan — PDF の作成
 * 各ページに JPEG 画像をそのまま敷いた、画像だけの PDF を作る。
 */
(function (root) {
  'use strict';

  const enc = new TextEncoder();

  function hex4(n) { return n.toString(16).toUpperCase().padStart(4, '0'); }

  // PDF のタイトル用(UTF-16BE の16進文字列)
  function toUTF16Hex(str) {
    let s = '';
    for (let i = 0; i < str.length; i++) s += hex4(str.charCodeAt(i));
    return s;
  }

  const num = (n) => (Math.round(n * 100) / 100).toString();

  /* pages: [{ jpeg: Uint8Array, width, height }] */
  function build(pages, title) {
    const chunks = [];
    let offset = 0;
    const offsets = [];
    const push = (data) => {
      const u = typeof data === 'string' ? enc.encode(data) : data;
      chunks.push(u); offset += u.length;
    };
    let nextId = 1;
    const alloc = () => nextId++;
    const objects = [];

    const catalogId = alloc(), pagesId = alloc(), infoId = alloc();
    const pageIds = [];

    for (const pg of pages) {
      const pageId = alloc(), imgId = alloc(), contId = alloc();
      pageIds.push(pageId);
      // 長辺を A4 の長辺(842pt)に合わせる
      const s = 842 / Math.max(pg.width, pg.height);
      const W = pg.width * s, H = pg.height * s;
      const content = `q ${num(W)} 0 0 ${num(H)} 0 0 cm /Im0 Do Q\n`;
      objects.push([pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(W)} ${num(H)}] /Resources << /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${contId} 0 R >>`]);
      objects.push([imgId, { head: `<< /Type /XObject /Subtype /Image /Width ${pg.width} /Height ${pg.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.jpeg.length} >>\nstream\n`, bin: pg.jpeg }]);
      objects.push([contId, `<< /Length ${enc.encode(content).length} >>\nstream\n${content}endstream`]);
    }

    objects.push([pagesId, `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`]);
    objects.push([catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`]);
    const d = new Date();
    const pd = `D:${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}00`;
    objects.push([infoId, `<< /Title <FEFF${toUTF16Hex(title || 'Scan')}> /Producer (ClearScan) /CreationDate (${pd}) >>`]);

    push('%PDF-1.4\n%'); push(new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
    objects.sort((a, b) => a[0] - b[0]);
    for (const [id, body] of objects) {
      offsets[id] = offset;
      push(`${id} 0 obj\n`);
      if (typeof body === 'string') push(body);
      else { push(body.head); push(body.bin); push('\nendstream'); }
      push('\nendobj\n');
    }
    const xref = offset;
    const total = nextId;
    let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
    for (let i = 1; i < total; i++) x += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    push(x);
    push(`trailer\n<< /Size ${total} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

    return new Blob(chunks, { type: 'application/pdf' });
  }

  root.PDF = { build };
})(window);
