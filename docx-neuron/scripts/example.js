// Contoh dokumen Neuron lengkap, siap dijalankan:  node scripts/example.js [keluaran.docx]
// Salin berkas ini sebagai titik awal; ganti isi, bukan gayanya.
const T = require('./neuron_theme.js');
const { P, H1, H2, H3, B, N, capT, cap, note, table, img, tocBlock, buildNeuronDoc, LOGO_PATH } = T;

(async () => {
  const out = process.argv[2] || 'contoh-neuron.docx';
  const body = [
    H1('1. Pendahuluan'),
    H2('1.1 Latar Belakang'),
    P('Paragraf isi rata kiri-kanan. Bagian **tebal** ditulis dengan dua bintang, berlaku juga di bullet dan sel tabel.'),
    B('Butir bullet pertama'), B('Sub-butir', 1), B('Butir **penting**'),
    H3('1.1.1 Langkah'),
    N('num1', 'Langkah pertama'), N('num1', 'Langkah kedua'),
    H2('1.2 Ringkasan Data'),
    capT('Tabel 1.1', 'Contoh tabel Neuron'),
    table(['Indikator', 'Target', 'Realisasi'],
      [['Uptime', '99,5%', '**99,8%**'], ['Tiket selesai', '200', '214'], ['Waktu respons', '< 2 jam', '1,4 jam']],
      [4270, 2400, 2400], ['l', 'r', 'r']),            // jumlah = 9070
    note('Sumber: data internal, Oktober 2026.'),
    img(LOGO_PATH, 300, 200, 'Contoh gambar'), cap('Gambar 1.1', 'Contoh keterangan gambar'),
    H1('2. Penutup'),
    N('num2', 'Daftar bernomor baru memakai ref berbeda (num2) agar mulai dari 1.'),
  ];
  await buildNeuronDoc({
    cover: { type: 'Laporan Penelitian Internal', title: 'Contoh Dokumen Neuron', subtitle: 'Template desain standar',
      author: 'Nama Penyusun', authorRole: 'Jabatan', unit: 'Divisi Research and Technology',
      company: 'Neuronworks Indonesia', date: 'Oktober 2026',
      classification: 'Klasifikasi: Internal — tidak untuk didistribusikan di luar perusahaan' },
    front: [...tocBlock()],
    body, footerLabel: 'Laporan Penelitian Internal  |  Divisi Research and Technology',
    creator: 'Nama Penyusun', title: 'Contoh Dokumen Neuron', out,
  });
  console.log('Tersimpan: ' + out);
})();
