// Desain dokumen Neuron.
// Hanya DESAIN: warna, font, heading, tabel, header+logo, footer, sampul, penomoran halaman.
// Isi dokumen selalu diberikan oleh pemanggil.
const fs = require('fs');
const path = require('path');
// 'docx' dibundel di scripts/vendor (tanpa npm install). Bila bundel hilang, jatuh ke paket 'docx' terpasang.
const loadDocx = () => { try { return require('./vendor/docx.bundle.cjs'); } catch (e) { return require('docx'); } };
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun, Header, Footer,
  AlignmentType, LevelFormat, TableOfContents, HeadingLevel, BorderStyle, WidthType, ShadingType,
  VerticalAlign, PageNumber, NumberFormat, TabStopType,
} = loadDocx();

const LOGO_PATH = path.join(__dirname, '..', 'assets', 'logo_neuron.png');
const LOGO = fs.readFileSync(LOGO_PATH);       // PNG 612x176 (rasio 3,477:1)
const LOGO_RATIO = 612 / 176;

// ---------- token desain ----------
const ACC = 'B3121B';      // merah logo (aksen garis, label sampul)
const INK = '1F2937';      // teks judul/heading
const MUTED = '5B6470';    // teks sekunder (footer, catatan)
const TEXT = '111111';     // teks isi
const RULE = 'C9CDD3';     // garis halus (border tabel, garis footer)
const HEAD_FILL = '2B3440';// header tabel
const ZEBRA = 'F4F5F7';    // baris selang-seling
const FONT = 'Arial';
const W = 9070;            // lebar isi A4 dengan margin 2,5 cm (DXA)
const PAGE = { size: { width: 11906, height: 16838 }, margin: { top: 1418, right: 1418, bottom: 1418, left: 1418, header: 567, footer: 567 } };

// ---------- helper konten ----------
const t = (text, o = {}) => new TextRun({ text, ...o });
// rich('teks **tebal** biasa', o): '**...**' menjadi tebal; berlaku sama di P, B, N, dan sel tabel.
const rich = (s, o = {}) => {
  const segs = String(s).split('**').map((seg, k) => [seg, o.bold || k % 2 === 1]).filter(([seg]) => seg !== '');
  return (segs.length ? segs : [['', !!o.bold]]).map(([seg, bold]) => t(seg, { ...o, bold }));
};
const runs = (r) => (Array.isArray(r) ? r : [r]).flatMap((x) => (typeof x === 'string' ? rich(x) : [x]));
const P = (r, o = {}) => new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 140, line: 300 }, children: runs(r), ...o });
const H1 = (s, { pageBreak = true } = {}) => new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: pageBreak, children: [t(s)] });
const H2 = (s) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [t(s)] });
const H3 = (s) => new Paragraph({ heading: HeadingLevel.HEADING_3, children: [t(s)] });
const B = (r, lvl = 0) => new Paragraph({ numbering: { reference: 'bul', level: lvl }, alignment: AlignmentType.JUSTIFIED, spacing: { after: 80, line: 288 }, children: runs(r) });
// daftar bernomor; ref 'num1'..'num10' (pakai ref berbeda untuk tiap daftar agar penomoran mulai dari 1)
const N = (ref, r) => new Paragraph({ numbering: { reference: ref, level: 0 }, alignment: AlignmentType.JUSTIFIED, spacing: { after: 80, line: 288 }, children: runs(r) });
// keterangan gambar (di bawah gambar, tengah) dan judul tabel (di atas tabel, kiri)
const cap = (label, text) => new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 160 },
  children: [t(label + ' ', { bold: true, size: 19, color: INK }), t(text, { size: 19, color: INK })] });
const capT = (label, text) => new Paragraph({ alignment: AlignmentType.LEFT, spacing: { before: 200, after: 80 }, keepNext: true,
  children: [t(label + ' ', { bold: true, size: 19 }), t(text, { size: 19 })] });
const note = (s) => new Paragraph({ spacing: { before: 40, after: 200 }, children: [t(s, { size: 16, italics: true, color: MUTED })] });
const spacer = (n = 1) => Array.from({ length: n }, () => new Paragraph({ children: [t('')] }));

const bd = { style: BorderStyle.SINGLE, size: 4, color: RULE };
const borders = { top: bd, bottom: bd, left: bd, right: bd };
// table(head, rows, widths, align): widths dalam DXA (jumlah = W), align per kolom: 'l' | 'c' | 'r'. **tebal** didukung di sel.
function table(head, rows, widths, align = []) {
  const sum = widths.reduce((a, b) => a + b, 0);
  if (sum !== W) console.warn(`[neuron_theme] table: jumlah lebar kolom ${sum} DXA, seharusnya ${W} (lebar isi).`);
  if (widths.length !== head.length) throw new Error(`[neuron_theme] table: ${head.length} kolom header tetapi ${widths.length} lebar.`);
  const al = (i) => (align[i] === 'r' ? AlignmentType.RIGHT : align[i] === 'c' ? AlignmentType.CENTER : AlignmentType.LEFT);
  const cell = (txt, i, isHead, zebra) => new TableCell({
    borders, width: { size: widths[i], type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER,
    shading: isHead ? { fill: HEAD_FILL, type: ShadingType.CLEAR } : (zebra ? { fill: ZEBRA, type: ShadingType.CLEAR } : undefined),
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({ alignment: isHead && align[i] !== 'r' ? AlignmentType.LEFT : al(i),
      children: rich(txt, { size: 17, bold: isHead, color: isHead ? 'FFFFFF' : TEXT }) })],
  });
  return new Table({
    width: { size: sum, type: WidthType.DXA }, columnWidths: widths,
    rows: [new TableRow({ tableHeader: true, children: head.map((h, i) => cell(h, i, true)) }),
      ...rows.map((r, ri) => new TableRow({ cantSplit: true, children: r.map((c, i) => cell(c, i, false, ri % 2 === 1)) }))],
  });
}
// Ukuran piksel gambar PNG atau JPEG (dibaca dari header berkas).
function imageInfo(buf, file) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { type: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i + 9 < buf.length;) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: 'jpg', h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  throw new Error(`[neuron_theme] img: ${file} bukan PNG/JPEG yang valid.`);
}
// img(file, maxWpx, maxHpx, alt): PNG atau JPEG, rasio dijaga
function img(file, maxWpx = 600, maxHpx = 560, alt = 'Gambar') {
  const buf = fs.readFileSync(file);
  const { type, w, h } = imageInfo(buf, file);
  let ow = maxWpx, oh = Math.round(maxWpx * h / w);
  if (oh > maxHpx) { oh = maxHpx; ow = Math.round(maxHpx * w / h); }
  return new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 0 }, keepNext: true,
    children: [new ImageRun({ type, data: buf, transformation: { width: ow, height: oh }, altText: { title: alt, description: alt, name: alt } })] });
}
const logoRun = (width, name) => new ImageRun({ type: 'png', data: LOGO,
  transformation: { width, height: Math.round(width / LOGO_RATIO) }, altText: { title: 'Logo Neuron', description: 'Logo Neuron - make it easy', name } });

// ---------- header, footer, sampul ----------
// Header: logo kanan atas + garis merah di bawahnya, di setiap halaman setelah sampul.
const makeHeader = () => new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { after: 0 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: ACC, space: 4 } }, children: [logoRun(116, 'logo')] })] });
// Footer: label kiri, "Halaman N" kanan, garis abu di atasnya.
const makeFooter = (label) => new Footer({ children: [new Paragraph({ tabStops: [{ type: TabStopType.RIGHT, position: W }],
  border: { top: { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 4 } },
  children: [t(label, { size: 16, color: MUTED }), t('\tHalaman ', { size: 16, color: MUTED }),
    new TextRun({ children: [PageNumber.CURRENT], size: 16, color: MUTED })] })] });

// Sampul: logo besar tengah, label jenis dokumen merah, garis merah, judul, subjudul, penyusun, unit, tanggal.
// opts: { type, title, subtitle, caseStudy, author, authorRole, unit, company, date, classification }
function makeCover(o) {
  const C = (r, extra = {}) => new Paragraph({ alignment: AlignmentType.CENTER, ...extra, children: r });
  const out = [
    ...spacer(2),
    C([logoRun(330, 'logo-sampul')]),
    ...spacer(2),
    C([t((o.type || 'LAPORAN').toUpperCase(), { bold: true, size: 22, color: ACC, characterSpacing: 40 })], { spacing: { after: 120 } }),
    C([t('')], { spacing: { after: 240 }, border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: ACC, space: 10 } } }),
    C([t(o.title, { bold: true, size: 36, color: INK })], { spacing: { before: 240, after: 200, line: 360 } }),
  ];
  if (o.subtitle) out.push(C([t(o.subtitle, { size: 26, color: INK })], { spacing: { after: 120, line: 320 } }));
  if (o.caseStudy) out.push(C([t(o.caseStudy, { italics: true, size: 22, color: MUTED })], { spacing: { after: 120 } }));
  out.push(...spacer(5));
  if (o.author) {
    out.push(C([t('Disusun oleh', { size: 20, color: MUTED })], { spacing: { after: 60 } }));
    out.push(C([t(o.author, { bold: true, size: 26, color: INK })], { spacing: { after: 40 } }));
    if (o.authorRole) out.push(C([t(o.authorRole, { size: 22, color: INK })], { spacing: { after: 360 } }));
  }
  if (o.unit) out.push(C([t(o.unit.toUpperCase(), { bold: true, size: 22, color: INK, characterSpacing: 20 })], { spacing: { after: 40 } }));
  if (o.company) out.push(C([t(o.company, { size: 22, color: INK })], { spacing: { after: 40 } }));
  if (o.date) out.push(C([t(o.date, { size: 22, color: INK })], { spacing: { after: 40 } }));
  if (o.classification) out.push(...spacer(1), C([t(o.classification, { size: 16, italics: true, color: MUTED })]));
  return out;
}

// Daftar isi standar (TOC level 1-2).
// Judul dibuat manual (bukan Heading 1) supaya "Daftar Isi" tidak ikut tercantum di daftar isinya sendiri.
const tocBlock = () => [
  new Paragraph({ spacing: { before: 120, after: 240 }, border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: ACC, space: 6 } },
    children: [t('Daftar Isi', { size: 30, bold: true, color: INK })] }),
  new TableOfContents('Daftar Isi', { hyperlink: true, headingStyleRange: '1-2' }),
];

// ---------- gaya dokumen ----------
const styles = {
  default: { document: { run: { font: FONT, size: 21, color: TEXT } } },
  paragraphStyles: [
    { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
      run: { size: 30, bold: true, font: FONT, color: INK },
      paragraph: { spacing: { before: 120, after: 240 }, outlineLevel: 0, border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: ACC, space: 6 } } } },
    { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
      run: { size: 24, bold: true, font: FONT, color: INK }, paragraph: { spacing: { before: 280, after: 120 }, outlineLevel: 1, keepNext: true } },
    { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
      run: { size: 22, bold: true, font: FONT, color: INK }, paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 2, keepNext: true } },
    { id: 'TOC1', name: 'toc 1', basedOn: 'Normal', next: 'Normal', run: { size: 20, bold: true }, paragraph: { spacing: { before: 100, after: 20 } } },
    { id: 'TOC2', name: 'toc 2', basedOn: 'Normal', next: 'Normal', run: { size: 19 }, paragraph: { spacing: { before: 0, after: 10 }, indent: { left: 360 } } },
  ],
};
const numberList = (ref) => ({ reference: ref, levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 567, hanging: 340 } } } }] });
const numbering = { config: [
  { reference: 'bul', levels: [
    { level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 567, hanging: 284 } } } },
    { level: 1, format: LevelFormat.BULLET, text: '–', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1134, hanging: 284 } } } }] },
  ...Array.from({ length: 10 }, (_, i) => numberList('num' + (i + 1))),
] };

// ---------- perakit dokumen ----------
// buildNeuronDoc({ cover: {...}, front: [...], body: [...], footerLabel, creator, title, description, out })
//  - cover : opsi makeCover (tanpa header/footer, tanpa nomor halaman)
//  - front : (opsional) bagian awal berangka romawi, mis. Informasi Dokumen, Abstrak, tocBlock()
//  - body  : isi utama, nomor halaman angka mulai 1
// Tanpa `front`, dokumen = sampul + body. Tanpa `cover`, dokumen langsung body (tetap berlogo di header).
async function buildNeuronDoc(o) {
  const hdr = makeHeader(), ftr = makeFooter(o.footerLabel || 'Dokumen Neuron');
  const sec = (children, fmt) => ({ properties: { page: { ...PAGE, pageNumbers: { start: 1, formatType: fmt } } },
    headers: { default: hdr }, footers: { default: ftr }, children });
  const sections = [];
  if (o.cover) sections.push({ properties: { page: { size: PAGE.size, margin: { top: 1418, right: 1418, bottom: 1418, left: 1418 } } }, children: makeCover(o.cover) });
  if (o.front && o.front.length) sections.push(sec(o.front, NumberFormat.LOWER_ROMAN));
  sections.push(sec(o.body, NumberFormat.DECIMAL));
  const doc = new Document({ creator: o.creator || 'Neuronworks Indonesia', title: o.title || (o.cover && o.cover.title) || 'Dokumen Neuron',
    description: o.description || '', features: { updateFields: !!(o.front && o.front.length) }, styles, numbering, sections });
  const buf = await Packer.toBuffer(doc);
  if (o.out) fs.writeFileSync(o.out, buf);
  return buf;
}

module.exports = { buildNeuronDoc, makeCover, makeHeader, makeFooter, tocBlock,
  t, rich, P, H1, H2, H3, B, N, cap, capT, note, table, img, spacer, tokens: { ACC, INK, MUTED, TEXT, RULE, HEAD_FILL, ZEBRA, FONT, W }, LOGO_PATH };
