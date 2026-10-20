# docx-neuron

Skill Claude untuk membuat dokumen Word (.docx) dengan **template desain Neuron** yang konsisten: logo Neuron di sampul dan header, garis aksen merah `B3121B`, heading Arial, tabel berheader gelap, footer "Halaman N", penomoran romawi lalu angka.

Desain Neuron sudah tertanam di skill (token warna, gaya heading, header/footer, sampul, tabel, logo); skill tidak membutuhkan file template eksternal apa pun.

## Prasyarat (preinstalled)

**Yang wajib hanya satu: Node.js 18 atau lebih baru.** Pustaka pembuat .docx (`docx`) sudah dibundel di dalam skill (`scripts/vendor/`), jadi tidak perlu `npm install`.

| Komponen | Status | Fungsi | Pasang |
|---|---|---|---|
| Node.js 18+ | **wajib** | menjalankan skrip pembuat dokumen | `bash scripts/setup.sh` |
| pustaka `docx` | sudah bawaan skill | membuat file .docx | tidak perlu dipasang |
| LibreOffice | opsional | pratinjau visual (.docx ke PDF) | `bash scripts/setup.sh --full` |
| Poppler | opsional | PDF ke gambar per halaman | `bash scripts/setup.sh --full` |
| pandoc | opsional | membaca isi .docx | `bash scripts/setup.sh --full` |
| Python 3 + `defusedxml`, `lxml` | opsional | mengedit dokumen yang sudah ada (merge, komentar, validasi) | `bash scripts/setup.sh --full` |

Tanpa komponen opsional, dokumen baru tetap terbuat dengan desain yang sama; yang hilang hanya pratinjau visual dan alat edit dokumen lama.

### Pemasangan untuk karyawan (satu perintah)

macOS, buka Terminal lalu jalankan:

```bash
bash ~/.claude/skills/docx-neuron/scripts/setup.sh
```

- Jika Node.js sudah ada, skrip hanya melapor siap pakai.
- Jika belum ada dan Homebrew tersedia, Node.js dipasang otomatis.
- Jika Homebrew tidak ada, skrip menampilkan tautan pemasang Node.js LTS (https://nodejs.org, klik-klik biasa) lalu jalankan skrip lagi.
- Tambahkan `--full` untuk pratinjau visual dan alat edit (LibreOffice, Poppler, pandoc, modul Python `defusedxml` dan `lxml`; sekitar 750 MB).

Windows: pasang Node.js dengan `winget install OpenJS.NodeJS.LTS` (skrip `setup.sh` ditulis untuk macOS dan belum diuji di Windows). Di lingkungan sandbox Claude/Cowork, Node.js biasanya sudah tersedia.

Cek kapan saja:

```bash
bash ~/.claude/skills/docx-neuron/scripts/check_prereqs.sh
```

## Instalasi skill

Dari folder skill hasil salinan/unduhan (mis. `~/Documents/SKILL/docx-neuron`):

```bash
bash ~/Documents/SKILL/docx-neuron/scripts/sync.sh
```

Skrip menyalin skill ke `~/.claude/skills/docx-neuron` (tanpa `.DS_Store`). Skill terdeteksi di sesi Claude berikutnya. Letakkan di luar folder `synced/` karena isi `synced/` dikelola aplikasi.

**Satu sumber kebenaran:** edit hanya di folder master (`~/Documents/SKILL/docx-neuron`), lalu jalankan `sync.sh` lagi. Jangan mengedit salinan di `~/.claude/skills` langsung, agar keduanya tidak menyimpang.

## Isi folder

```
docx-neuron/
├── README.md               ← berkas ini
├── SKILL.md                ← instruksi dan aturan desain untuk Claude
├── LICENSE.txt
├── THIRD_PARTY_NOTICES.txt ← lisensi pustaka open-source yang dibundel
├── assets/logo_neuron.png  ← logo resmi (612x176, jangan diregangkan)
└── scripts/
    ├── neuron_theme.js     ← modul desain Neuron (buildNeuronDoc, P, H1.., table, img, ...)
    ├── example.js          ← contoh dokumen lengkap siap jalan (titik awal dokumen baru)
    ├── render.sh           ← pratinjau: .docx -> PDF -> JPEG per halaman
    ├── setup.sh            ← pemasang satu perintah (Node.js; --full untuk pratinjau & alat edit)
    ├── check_prereqs.sh    ← pengecek prasyarat
    ├── sync.sh             ← salin master ke ~/.claude/skills/docx-neuron
    ├── vendor/docx.bundle.cjs ← pustaka docx dibundel (lisensi: THIRD_PARTY_NOTICES.txt)
    └── office/, comment.py, merge_runs.py, accept_changes.py  ← alat bawaan skill docx
```

## Pemakaian singkat

Minta Claude: "buat laporan dengan docx-neuron tentang ...". Untuk jenis dokumen lain (proposal, SOP, notulen) ubah hanya `cover.type`, `footerLabel`, dan isi. Aturan desain lengkap dan contoh kode ada di `SKILL.md`.

## Tips agar optimal

- Selalu buat dokumen baru lewat `neuron_theme.js`; jangan menulis gaya dari nol.
- Coba dulu: `node scripts/example.js` menghasilkan `contoh-neuron.docx`.
- Periksa visual setelah membuat dokumen: `bash scripts/render.sh file.docx render/`.
- Teks **tebal** ditulis `**seperti ini**` di paragraf, bullet, daftar bernomor, dan sel tabel.
- Bila memakai daftar isi, buka di Word dan pilih "Yes" pada pertanyaan update fields.
- Gambar boleh PNG atau JPEG; rasio dijaga otomatis.
- Jangan ubah logo atau token warna per dokumen; ubah di `neuron_theme.js` (di master), lalu `sync.sh`, agar semua dokumen berikutnya ikut konsisten.
