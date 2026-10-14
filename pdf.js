/* ClearScan — 検索可能PDFの作成
 * 各ページに JPEG 画像を敷き、その上に OCR の文字を透明(描画モード3)で重ねる。
 * 日本語は PDF 標準の HeiseiKakuGo-W5 + UniJIS-UCS2-H を参照し、フォントは埋め込まない
 * (透明文字なので見た目には影響せず、検索・コピーだけに使われる)。
 */
(function (root) {
  'use strict';

  const enc = new TextEncoder();

  function hex4(n) { return n.toString(16).toUpperCase().padStart(4, '0'); }

  function toUCS2Hex(str) {
    let s = '';
    for (const ch of str) {
      const c = ch.codePointAt(0);
      s += c > 0xffff ? '30FB' : hex4(c); // BMP 外は中黒で代用
    }
    return s;
  }

  function toUnicodeCMap() {
    let ranges = '';
    for (let hi = 0; hi < 256; hi += 1) {
      if (hi >= 0xd8 && hi <= 0xdf) continue;
      const a = hi.toString(16).toUpperCase().padStart(2, '0');
      ranges += `<${a}00> <${a}FF> <${a}00>\n`;
    }
    // bfrange は 1 ブロック最大 100 件
    const lines = ranges.trim().split('\n');
    let body = '';
    for (let i = 0; i < lines.length; i += 100) {
      const chunk = lines.slice(i, i + 100);
      body += `${chunk.length} beginbfrange\n${chunk.join('\n')}\nendbfrange\n`;
    }
    return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${body}endcmap
CMapName currentdict /CMapResource defineresource pop
end
end`;
  }

  const num = (n) => (Math.round(n * 100) / 100).toString();

  /* pages: [{ jpeg: Uint8Array, width, height, lines: [{ t, b:[x0,y0,x1,y1] (0〜1) }] }] */
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
    const objects = []; // 書き出しは後でまとめて

    const catalogId = alloc(), pagesId = alloc(), fontId = alloc(), cidId = alloc(), descId = alloc(), cmapId = alloc(), infoId = alloc();
    const pageIds = [];

    objects.push([fontId, `<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiKakuGo-W5 /Encoding /UniJIS-UCS2-H /DescendantFonts [${cidId} 0 R] /ToUnicode ${cmapId} 0 R >>`]);
    objects.push([cidId, `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiKakuGo-W5 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /FontDescriptor ${descId} 0 R /DW 1000 >>`]);
    objects.push([descId, `<< /Type /FontDescriptor /FontName /HeiseiKakuGo-W5 /Flags 4 /FontBBox [-92 -250 1010 922] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 737 /StemV 93 >>`]);
    const cmap = toUnicodeCMap();
    objects.push([cmapId, `<< /Length ${enc.encode(cmap).length} >>\nstream\n${cmap}\nendstream`]);

    for (const pg of pages) {
      const pageId = alloc(), imgId = alloc(), contId = alloc();
      pageIds.push(pageId);
      // 長辺を A4 の長辺(842pt)に合わせる
      const s = 842 / Math.max(pg.width, pg.height);
      const W = pg.width * s, H = pg.height * s;
      let content = `q ${num(W)} 0 0 ${num(H)} 0 0 cm /Im0 Do Q\n`;
      if (pg.lines && pg.lines.length) {
        content += 'BT 3 Tr\n';
        for (const ln of pg.lines) {
          const text = (ln.t || '').replace(/\s+/g, ' ').trim();
          if (!text) continue;
          const [x0, y0, x1, y1] = ln.b;
          const bw = (x1 - x0) * W, bh = (y1 - y0) * H;
          const n = [...text].length;
          let size, tz;
          if (bh > bw * 1.6) { // 縦書きの行
            size = Math.max(1, bw);
            tz = (bh / (n * size)) * 100;
          } else {
            size = Math.max(1, bh * 0.9);
            tz = (bw / (n * size)) * 100;
          }
          tz = Math.max(1, Math.min(1000, tz));
          content += `/F1 ${num(size)} Tf ${num(tz)} Tz 1 0 0 1 ${num(x0 * W)} ${num(H - y1 * H + bh * 0.12)} Tm <${toUCS2Hex(text)}> Tj\n`;
        }
        content += 'ET\n';
      }
      objects.push([pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(W)} ${num(H)}] /Resources << /XObject << /Im0 ${imgId} 0 R >> /Font << /F1 ${fontId} 0 R >> >> /Contents ${contId} 0 R >>`]);
      objects.push([imgId, { head: `<< /Type /XObject /Subtype /Image /Width ${pg.width} /Height ${pg.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.jpeg.length} >>\nstream\n`, bin: pg.jpeg }]);
      objects.push([contId, `<< /Length ${enc.encode(content).length} >>\nstream\n${content}endstream`]);
    }

    objects.push([pagesId, `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`]);
    objects.push([catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`]);
    const d = new Date();
    const pd = `D:${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}00`;
    objects.push([infoId, `<< /Title <FEFF${toUCS2Hex(title || 'Scan')}> /Producer (ClearScan) /CreationDate (${pd}) >>`]);

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
