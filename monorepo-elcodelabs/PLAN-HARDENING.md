# Rencana — Pengerasan fondasi (keamanan, data, mekanisme library)

> Disusun 26 Oktober 2026 dari tinjauan lima peninjau independen (arsitektur backend, keamanan,
> operasional, mekanisme library, frontend) yang setiap temuannya diverifikasi di kode.
> Tujuannya: setiap aplikasi yang dirakit dari library mewarisi fondasi yang aman, karena satu
> celah di modul bersama tersalin ke semua aplikasi klien.

## Keputusan

| # | Keputusan | Alasan |
|---|---|---|
| H1 | Pengerasan dulu, modul baru sesudahnya | Perbaikan di satu library lebih murah daripada di banyak project nanti |
| H2 | Perbaikan keamanan dirilis sebagai **kernel 4** | Modul boleh bergantung padanya (`Covers`, `ClientIP`), jadi kernel naik |
| H3 | Perlindungan CSRF tidak bergantung pada pola domain | Domain aplikasi bisa berbeda-beda; subdomain saudara (WordPress klien, aplikasi lain) dianggap satu "site" |
| H4 | Aplikasi yang mendeklarasikan izin wajib punya penyedia otorisasi di produksi | Tanpa `rbac`, "sudah login = boleh segalanya" tidak aman |
| H5 | Pengguna dinonaktifkan, tidak dihapus | Rujukan modul lain tetap sah; konvensi untuk semua data master |
| H6 | Backup terjadwal di server, rotasi 5 harian + 2 mingguan + 1 bulanan, hanya di VPS untuk sementara, notifikasi Telegram | Disepakati 26 Oktober; salinan di luar VPS menyusul (risiko VPS rusak diterima) |
| H7 | Yang belum dibutuhkan ditunda dengan pemicu jelas | Anti-overengineering: kategori katalog (~30 modul), i18n (klien non-Indonesia pertama), slot terbuka (modul pertama yang butuh), upgrade kernel otomatis (beberapa project produksi), `d.Jobs`/`d.Audit` (bersama `mailer`/`audit-log`) |

## Yang dikerjakan

**Kernel 4 (skill).** `DecodeJSON` hanya menerima JSON (415) dan tidak membocorkan error Go;
penulisan lintas situs ditolak (`Sec-Fetch-Site`/`Origin`); IP klien asli lewat
`TRUSTED_PROXIES`; `Authorizer.Covers`; nama izin ganda dan produksi tanpa penyedia ditolak;
`APP_ENV` wajib eksplisit di container; sesi database UTC; shutdown 25 detik; Go 1.26/1.27,
Alpine 3.24, `GOMEMLIMIT`; halaman error dan 404 di router; `withCredentials` untuk API terpisah;
tes unit kernel ikut ke setiap project.

**Modul.** `auth` 0.4.0: sesi di server (`auth_sessions`) — logout dan ganti password mencabut
token; cookie `__Host-session`; `jti`/`aud`; token di body hanya bila diminta; limiter berlapis
(email+IP, IP, email), atomik, memori dibatasi. `users` 0.4.0: `password_changed_at`, akun yang
lebih berhak tidak bisa disentuh (`Covers`), nonaktifkan bukan hapus, PUT tanpa `is_active` tidak
lagi menonaktifkan. `rbac` 0.3.0: `rbac.manage` bukan jalan menuju izin lebih, `Covers`, bootstrap
ulang bila tak ada admin aktif, izin dimuat ulang dengan aman. `ui-core` 0.3.0 (`useResource`),
`ui-data` 0.2.0 (fokus baris), `app-shell` 0.4.0 (placeholder nav).

**Deploy.** `deploy.sh`: `umask 077`, satu backup per deploy, cek `.env` terhadap image sebelum
apa pun berubah, rollback Go otomatis melewati migrasi, deteksi database *dirty*, log versi lama
disimpan, image lama dibersihkan. Skrip backup server (`scripts/server/`). CI project menjalankan
migrasi sungguhan (up → down semua → up) dan `check-migrations.mjs` menolak migrasi yang urutannya
lebih tua dari `main`. Aturan expand/contract, satu perubahan skema per file, waktu UTC.
Prosedur restore dan pemulihan migrasi gagal di `knowledge/DEPLOYMENT.md`.

**Library.** Hanya file yang di-track git yang dipasang; `upgrade` tidak menghapus file yang
pindah modul, tidak membangkitkan file yang dihapus project, dan menulis ulang registrasi yang
berubah; tag rilis `<id>/v<versi>` sebagai cadangan commit dasar; `module.mjs remove`; env modul
masuk ke contoh env produksi; `go_dependencies`; bentrok npm dilaporkan; CRLF dinormalisasi;
`promote` tidak lagi merusak kode Go project bernama pendek. `rules.mjs`: regex modul berlabuh,
import relatif, `.js/.jsx`, query sqlc hanya ke tabel sendiri, tabel tidak boleh diklaim dua
modul, `text-only`, `declared-go-deps`, import Go register; pemeriksaan riwayat tetap jalan untuk
CI manual dan branch baru.

## Belum (sengaja)

- Salinan backup di luar VPS (H6).
- Pemasangan skrip backup di server — perubahan server, menunggu izin terpisah.
- CI di GitHub — akun terkunci billing; semua gerbang sudah dijalankan lokal.
- CSP di nginx — perlu diuji dengan font dan aset tiap preset; ditunda.
- Item yang ditunda dengan pemicu (H7).

## Bukti

Diverifikasi 26 Oktober 2026, semuanya lokal (CI GitHub terkunci billing):

- **Testbed library, kelima skenario hijau** dengan MySQL dan golang-migrate sungguhan, termasuk
  pemeriksaan end-to-end baru: body `text/plain` → 415, penulisan *same-site* dan Origin asing
  → 403, error tipe tanpa detail Go, token hanya bila diminta, PUT tanpa `is_active` tidak
  menonaktifkan, ganti password mengakhiri sesi lama, operator tidak bisa mengambil alih atau
  menonaktifkan admin, `rbac.manage` tidak bisa menjadikan diri Administrator, cookie salinan dan
  token Bearer mati setelah logout, produksi tanpa penyedia otorisasi menolak start; mekanisme:
  `.DS_Store` tidak terpasang, dependensi Go terkunci, env masuk contoh produksi, file pindah modul
  selamat, registrasi web yang berubah ditulis ulang, file yang dihapus project tetap terhapus,
  upgrade memakai tag saat commit dasar hilang, `remove` menolak bila masih dipakai dan bersih bila
  tidak, `promote` menolak pelanggaran.
- **Bug yang ditemukan testbed dan diperbaiki**: perbandingan waktu ganti password vs sesi
  berpresisi detik (sesi di detik yang sama lolos) → kolom `TIMESTAMP(6)` dan perbandingan
  "pada atau sebelum"; dua run berturut-turut stabil, plus tes unit khusus.
- **Tes unit**: kernel (`server`, `shared/request`) dan modul (`auth` termasuk tebakan paralel,
  `users`, `rbac`).
- **Pelanggaran sengaja** di salinan library: 9 cara yang dulu lolos dari `rules.mjs` kini
  tertangkap semua.
- **deploy.sh** diuji dengan `docker` tiruan: normal, rollback (migrasi dilewati), database
  *dirty* (berhenti), env kurang / kosong (berhenti sebelum apa pun berubah); backup ber-izin 600.
- **Skrip backup** diuji terhadap MySQL lokal: rotasi 5/2/1, hardlink mingguan/bulanan, uji
  restore, dump gagal dan disk penuh dilaporkan tanpa menyentuh backup lama.
- **Skill**: `check-drift` bersih (kontrak modul kernel 4 diterima), smoke test tiga stack hijau
  (termasuk `dev:api` lewat `air`), paket `dist` sinkron.
- **Visual**: halaman 404 di dalam bingkai aplikasi, menu Nonaktifkan di daftar pengguna, tanpa
  peringatan React di console.
