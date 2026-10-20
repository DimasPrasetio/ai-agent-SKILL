---
name: docx-neuron
description: "Gunakan skill ini untuk membuat, membaca, atau mengedit dokumen Word (.docx) bergaya Neuron / Neuronworks: laporan, proposal, penelitian, SOP, notulen, atau dokumen resmi apa pun yang harus memakai template desain Neuron (logo Neuron di header dan sampul, garis aksen merah B3121B, heading Arial, tabel header gelap, footer 'Halaman N'). Pakai saat pengguna menyebut 'dokumen Neuron', 'docx-neuron', 'format Neuron', atau meminta dokumen Word untuk Neuronworks. Semua dokumen BARU wajib lewat scripts/neuron_theme.js agar desain dan logo konsisten. Untuk Word generik non-Neuron, pakai skill docx biasa."
license: Proprietary. Lihat LICENSE.txt dan THIRD_PARTY_NOTICES.txt
---

# DOCX Neuron: membuat, mengedit, dan membaca dokumen

Skill ini turunan skill `docx` dengan satu aturan tambahan: **setiap dokumen baru memakai desain Neuron**. Yang diambil dari template hanya desainnya; isinya selalu dari pengguna.

Semua path skrip di bawah relatif terhadap folder skill ini (`~/.claude/skills/docx-neuron`).

## Prasyarat

| Kebutuhan | Untuk | Cek / pasang |
|---|---|---|
| Node.js 18+ (**wajib**) | membuat dokumen baru | `bash scripts/check_prereqs.sh` |
| pustaka `docx` | sudah dibundel di `scripts/vendor/` | tidak perlu `npm install` |
| Python 3 + `defusedxml`, `lxml` | `merge_runs.py`, `comment.py`, `office/validate.py` | `bash scripts/setup.sh --full` |
| pandoc | membaca isi .docx | `bash scripts/setup.sh --full` |
| LibreOffice + Poppler | pratinjau visual | `bash scripts/setup.sh --full` |

Jalankan `bash scripts/check_prereqs.sh` dulu. Bila yang wajib belum ada, minta pengguna menjalankan `bash scripts/setup.sh`; jangan memasang paket sendiri tanpa izin. Bila alat opsional tidak ada, lewati langkahnya dan sampaikan ke pengguna apa yang belum diperiksa (misalnya "tampilan belum diperiksa secara visual").

## Aturan desain Neuron (jangan diubah per dokumen)

| Elemen | Ketentuan |
|---|---|
| Halaman | A4, margin 2,5 cm, lebar isi 9070 DXA |
| Font | Arial 10,5 pt, warna teks `111111`, rata kiri-kanan (justified) |
| Warna | Aksen merah logo `B3121B`, judul `1F2937`, sekunder `5B6470`, garis `C9CDD3` |
| Heading 1 | 15 pt tebal, garis bawah merah, mulai halaman baru |
| Heading 2 / 3 | 12 pt / 11 pt tebal |
| Header | Logo Neuron kanan atas (116 px) + garis bawah merah, semua halaman setelah sampul |
| Footer | Label dokumen kiri, "Halaman N" kanan, garis abu di atas |
| Sampul | Logo besar tengah (330 px), label jenis dokumen merah huruf kapital, garis merah, judul, penyusun, unit, perusahaan, tanggal, klasifikasi; tanpa header/footer |
| Penomoran | Bagian awal (info dokumen, abstrak, daftar isi) angka romawi; isi utama angka 1, 2, 3 |
| Tabel | Header `2B3440` teks putih, baris selang-seling `F4F5F7`, border `C9CDD3`, font 8,5 pt; judul tabel di atas ("Tabel 2.1 ..."), keterangan gambar di bawah, tengah ("Gambar 2.1 ...") |
| Logo | `assets/logo_neuron.png` (jangan diganti, jangan diregangkan, rasio 612:176) |

Perubahan desain dilakukan sekali di `scripts/neuron_theme.js`, bukan per dokumen.

## Membuat dokumen baru (wajib lewat neuron_theme.js)

Jangan menulis gaya dari nol dan jangan `require('docx')` langsung. Titik awal tercepat: salin `scripts/example.js` (contoh lengkap yang siap dijalankan) lalu ganti isinya.

```js
const T = require(process.env.HOME + '/.claude/skills/docx-neuron/scripts/neuron_theme.js');
const { P, H1, H2, H3, B, N, capT, cap, note, table, img, spacer, tocBlock, buildNeuronDoc } = T;

const body = [
  H1('1. Pendahuluan'),
  H2('1.1 Latar Belakang'),
  P('Isi paragraf dengan bagian **tebal**.'),
  B('Poin bullet'), B('Sub-poin', 1),
  N('num1', 'Butir bernomor'),                       // num1..num10: ref berbeda tiap daftar agar mulai dari 1
  capT('Tabel 1.1', 'Judul tabel'),
  table(['Kolom A', 'Kolom B'], [['a', '**b tebal**']], [4000, 5070], ['l', 'r']),   // jumlah lebar = 9070
  note('Sumber: ...'),
  img('grafik.png', 600, 400, 'Grafik'), cap('Gambar 1.1', 'Keterangan gambar'),
];

await buildNeuronDoc({
  cover: { type: 'Laporan Penelitian Internal', title: 'Judul Dokumen', subtitle: '...', author: 'Nama', authorRole: 'Jabatan',
           unit: 'Divisi Research and Technology', company: 'Neuronworks Indonesia', date: 'Oktober 2026',
           classification: 'Klasifikasi: Internal — tidak untuk didistribusikan di luar perusahaan' },
  front: [...tocBlock()],                             // opsional: daftar isi, Informasi Dokumen, Abstrak
  body, footerLabel: 'Laporan Penelitian Internal  |  Divisi Research and Technology',
  creator: 'Nama', title: 'Judul Dokumen', out: 'output.docx',
});
```

Referensi helper:

| Helper | Fungsi |
|---|---|
| `P(teks, opsi)` | paragraf isi; `**...**` menjadi tebal |
| `H1(teks, { pageBreak })` / `H2` / `H3` | heading; H1 mulai halaman baru kecuali `pageBreak: false` |
| `B(teks, level)` | bullet level 0 atau 1 |
| `N('numK', teks)` | daftar bernomor; pakai `num1`..`num10` berbeda untuk tiap daftar |
| `table(head, rows, widths, align)` | lebar DXA berjumlah 9070 (ada peringatan bila tidak); align `'l' / 'c' / 'r'` |
| `capT(label, teks)` / `cap(label, teks)` | judul tabel (atas) / keterangan gambar (bawah) |
| `img(file, maxW, maxH, alt)` | PNG atau JPEG, rasio dijaga |
| `note(teks)` | catatan kecil miring (sumber, keterangan) |
| `spacer(n)` | n paragraf kosong |
| `tocBlock()` | daftar isi level 1-2 |
| `t(teks, opsi)` / `rich(teks, opsi)` | TextRun mentah / TextRun dengan dukungan `**tebal**` |

Aturan pemakaian:
- Tanpa `cover`: dokumen langsung isi, tetap berlogo di header. Tanpa `front`: sampul + isi.
- Jenis dokumen lain (proposal, SOP, notulen) memakai modul yang sama; ubah hanya `cover.type`, `footerLabel`, dan isi.
- Teks berbaris banyak: buat satu `P()` per paragraf; jangan memakai `\n`.
- Bila `front` memakai `tocBlock()`, Word akan menanyakan "update fields" saat dibuka; beri tahu pengguna untuk memilih Yes agar daftar isi terisi.

## Verifikasi hasil

Setelah membuat atau mengedit `.docx`, render dan lihat hasilnya:

```bash
bash scripts/render.sh output.docx render/     # menghasilkan render/output.pdf dan render/page-*.jpg
```

Baca gambar halamannya dan periksa: logo muncul di header dan sampul, tidak ada halaman kosong, tabel tidak terpotong, tanda `**` tidak bocor, daftar bernomor mulai dari 1. Bila `render.sh` keluar dengan kode 2 (LibreOffice/Poppler tidak ada), sampaikan bahwa tampilan belum diperiksa secara visual.

## Mengedit dokumen yang sudah ada

- **Dokumen Neuron**: pertahankan header, footer, logo, dan gaya apa adanya; jangan menyuntik gaya baru.
- **Dokumen non-Neuron yang diminta "dijadikan format Neuron"**: buat ulang lewat `neuron_theme.js`; ambil teks dan gambarnya, bukan gaya lamanya.
- **Membaca isi**: `pandoc -t markdown file.docx`. Tanpa pandoc: `unzip -p file.docx word/document.xml` lalu ambil teks dari elemen `<w:t>`.
- Berkas `.doc` lama dikonversi dulu: `python3 scripts/office/soffice.py --headless --convert-to docx file.doc`.

docx-js tidak bisa membuka berkas yang sudah ada, jadi pengeditan dilakukan langsung pada XML:

```bash
unzip -q doc.docx -d unpacked/
find unpacked -type l -delete               # buang symlink: docx dari pihak luar tidak tepercaya
python3 scripts/merge_runs.py unpacked/     # gabungkan run yang terpecah agar teks bisa dicari
# edit unpacked/word/document.xml di tempat; JANGAN diformat ulang / pretty-print
(cd unpacked && rm -f ../out.docx && zip -Xr ../out.docx .)
python3 scripts/office/validate.py out.docx --original doc.docx   # cek XSD; --auto-repair memperbaiki masalah umum
```

Word memecah teks ke banyak `<w:r>` (id revisi, penanda ejaan), sehingga frasa yang terlihat sering tidak utuh di XML. `merge_runs.py` menggabungkan run bersebelahan yang formatnya sama tanpa mengubah isi atau tampilan; bisa juga langsung ke berkas: `python3 scripts/merge_runs.py doc.docx -o merged.docx`.

### Tracked changes (redlining)

- Bungkus run dengan `<w:ins>` / `<w:del>` beratribut `w:id`, `w:author`, `w:date`. Di dalam `<w:del>`, teks memakai `<w:delText>`, bukan `<w:t>`.
- Validasi dengan `--author "<nama penyunting>"` (butuh `--original`): skrip melaporkan teks yang berubah tanpa `<w:ins>`/`<w:del>`, kesalahan yang tidak terlihat di tampilan "accepted".
- Menghapus satu paragraf utuh = `<w:del>` di setiap run + tanda paragraf terhapus: `<w:pPr><w:rPr><w:del w:id=".." w:author=".." w:date=".."/></w:rPr></w:pPr>`. `<w:del/>` harus menjadi anak pertama `rPr` (urutan diatur skema).
- Salinan bersih dengan semua perubahan diterima: `python3 scripts/accept_changes.py in.docx out.docx`.
- Bullet kosong setelah menerima perubahan biasanya artefak alat, bukan cacat dokumen: `pandoc --track-changes=accept` tidak pernah menggabungkan paragraf, dan `accept_changes.py` (LibreOffice) gagal bila paragraf terhapus diikuti paragraf kosong. Periksa penghapusan paragraf langsung di XML.

### Komentar

Komentar butuh enam berkas yang saling terhubung; pakai helper:

```bash
python3 scripts/comment.py unpacked/ "Batas biaya terlalu rendah"          # mode folder (bila juga mengedit document.xml)
python3 scripts/comment.py unpacked/ "Setuju" --parent 0                   # balasan
python3 scripts/comment.py kontrak.docx "Batas terlalu rendah" -o beranotasi.docx   # langsung ke .docx
```

Skrip menulis `comments.xml`, `commentsExtended.xml`, `commentsIds.xml`, `commentsExtensible.xml`, relasi, dan content type, lalu mencetak potongan `<w:commentRangeStart>` / `<w:commentRangeEnd>` / `<w:commentReference>` yang harus dipasang di `word/document.xml`. Sebelum penanda itu dipasang, komentar ada tetapi tidak terlihat.

## Jebakan docx-js (bila memakai primitif langsung)

`neuron_theme.js` sudah menangani semua ini. Berlaku bila menambah elemen di luar helper (impor primitif lewat bundel: `require('<skill>/scripts/vendor/docx.bundle.cjs')`):

- Ukuran halaman default A4. Landscape: beri dimensi portrait + `orientation: PageOrientation.LANDSCAPE` (docx-js menukar lebar/tinggi sendiri).
- Tabel butuh dua lebar: `columnWidths` di tabel DAN `width` di setiap sel, keduanya `WidthType.DXA` (PERCENTAGE rusak di Google Docs).
- Shading tabel: `ShadingType.CLEAR`, jangan `SOLID` (menjadi hitam).
- Bullet: jangan menulis `•` langsung; pakai konfigurasi `numbering` dengan `LevelFormat.BULLET`.
- `ImageRun` wajib punya `type:` (`'png'`, `'jpg'`, ...).
- `PageBreak` harus di dalam `Paragraph`. Jangan memakai `\n`.
- Daftar isi: heading harus memakai `HeadingLevel.*`; gaya heading kustom wajib punya `outlineLevel`.
- Garis horizontal: pakai border bawah paragraf, bukan tabel.
- Titik-titik penuntun / teks rata kanan sebaris: `PositionalTab` (`alignment: RIGHT`, `leader: DOT`), bukan titik atau spasi manual.

## Pemeliharaan skill

Folder master: `~/Documents/SKILL/docx-neuron`. Edit hanya di master, lalu salin ke Claude dengan `bash scripts/sync.sh`.
