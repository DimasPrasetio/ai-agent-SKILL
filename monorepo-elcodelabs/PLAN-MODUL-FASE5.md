# Rencana — Kernel 5 dan lima modul berikutnya

> Disusun 26 Oktober 2026. Mengikuti urutan yang disepakati setelah pengerasan
> (PLAN-HARDENING.md): `mailer` → `auth`/`users` (akun sendiri, lupa kata sandi) → `settings`
> → `audit-log` → `files`. Setiap fondasi kernel dibangun bersama modul pertama yang
> memakainya, tidak lebih dulu.

## Prinsip yang dijaga

1. **Modul tidak saling meng-import.** Kebutuhan antarmodul lewat port milik konsumen, disambung
   adapter di composition root. Setiap port baru **opsional**, sehingga modul tetap bisa dipasang
   sendiri dan adapter yang sudah ditulis project tidak rusak.
2. **Kernel hanya untuk yang dibutuhkan hampir semua modul**, dan punya default yang membuat
   modul tetap berjalan sendiri (seperti `d.Auth`, `d.Authz`).
3. **Satu container, tanpa Redis.** Antrean memakai tabel MySQL milik modulnya.
4. **Setiap pemilik data memegang tabelnya.** Tidak ada JOIN atau FK lintas modul.

## Kernel 5

| Tambahan | Rancangan | Alasan masuk kernel |
|---|---|---|
| `d.Jobs` | `d.Jobs.Every(name, interval, fn)`. Satu penjadwal untuk seluruh aplikasi: batas 2 tugas berjalan bersamaan, jitter di awal, tugas yang sama tidak pernah tumpang tindih, panic ditangkap. Setiap putaran memegang **kunci bernama MySQL** (`GET_LOCK`, diberi awalan nama database), sehingga saat deploy dua container sempat hidup bersamaan, tugas tetap berjalan di satu tempat. Mulai setelah registry, berhenti setelah HTTP, dalam 25 detik total. | Hanya `main.go` yang mengatur siklus hidup proses |
| `d.Audit` | `d.Audit.Record(ctx, Entry{Module, Action, Target, Summary, Data})`. Pelaku, IP, dan request ID diambil otomatis dari ctx. Tanpa penyedia: satu baris log. Penyedia (`audit-log`) menulis langsung setelah perubahan berhasil, sinkron dengan batas waktu singkat; kegagalan dicatat di log dan tidak menggagalkan permintaan. | Dibutuhkan hampir setiap modul yang mengubah data; port per modul berarti N adapter per project |
| Konteks request | `request.RequestID(ctx)`, `request.ClientIPFrom(ctx)` | Dibutuhkan audit dan limiter tanpa `*http.Request` |
| Waktu transfer | `request.AllowTransfer(w, bytes)`: tenggat baca/tulis diperpanjang sesuai ukuran (dengan asumsi koneksi lambat 512 kbit/s) | Timeout server (30/60 detik) dibuat untuk panggilan API; unggah/unduh file butuh lebih, dan dipakai lebih dari satu modul |
| Folder data | `config.DataDir` (`DATA_DIR`, default `data` di dev, `/app/data` di image). Compose produksi memasang `./data:/app/data`; `deploy.sh` membuat folder dan menyerahkannya ke uid 10001; backup server ikut mencadangkannya (snapshot `rsync --link-dest`, rotasi yang sama). | Container `read_only`: satu-satunya tempat menulis yang selamat dari deploy |
| Slot terbuka (web) | `SlotName` menjadi string bebas dengan konvensi `<pemilik>:<tempat>` (contoh `user-menu:items`, `settings:sections`); dua slot lama tetap. | Dipicu kebutuhan nyata: menu pengguna dan halaman pengaturan diisi beberapa modul |

## Modul

### `mailer` 0.1.0 (baru)
- **Tabel** `mail_outbox`: status `pending → sending → sent | failed`, `attempts`, `next_attempt_at`, `locked_until`, `last_error`.
- **Contract** `MailClient.Send(ctx, Message)`: pesan divalidasi lalu dicatat di tabel. Request pengguna tidak menunggu SMTP.
- **Pekerja** (`d.Jobs`, tiap 10 detik):
  - Klaim batch dengan `FOR UPDATE SKIP LOCKED`, kirim, tandai.
  - Jeda coba ulang 1 m, 5 m, 30 m, 2 j, 6 j; setelah 6 percobaan berstatus `failed`.
  - Baris `sending` yang macet dikembalikan ke `pending`.
  - Pembersihan berkala: `sent` setelah 30 hari, `failed` setelah 90 hari.
- **Transport:**
  - SMTP dengan STARTTLS (587), TLS langsung (465), atau `none` untuk server uji lokal.
  - Format MIME `multipart/alternative`, dengan header yang benar (Date, Message-ID, nama ber-encoding).
- **Transport log:** tanpa `SMTP_HOST`, email hanya ditulis ke log, untuk development. Di **produksi**, `SMTP_HOST` kosong membuat API menolak start, supaya email tidak hilang diam-diam.
- **Layout HTML seragam:** nama aplikasi di atas, footer di bawah. Isi email ditulis modul pengirim.
- **Halaman "Kotak keluar"**: daftar, filter status, kirim ulang. Izin `mailer.read` dan `mailer.manage`.
- **Env:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_TLS`, `MAIL_FROM`, `MAIL_FROM_NAME`.

### `users` 0.5.0
- **Profil sendiri:** `GET/PUT /api/v1/account/profile` (nama). Email tetap diubah admin, karena mengganti email sendiri adalah jalur pengambilalihan akun.
- **Contract `SetPassword(ctx, id, password)`:** `users` memvalidasi, meng-hash, dan mencatat `password_changed_at`. Dipakai `auth` lewat port.
- **Audit:** buat, ubah, nonaktifkan, aktifkan, dan reset kata sandi oleh admin.
- **Web:** halaman `/account` ("Profil saya") dan tautan di slot `user-menu:items`.

### `auth` 0.5.0
- **Dua port baru, opsional:**
  - `PasswordWriter` (← `users`): tanpa ini, ganti kata sandi dan reset nonaktif.
  - `Mailer` (← `mailer`): tanpa ini, lupa kata sandi nonaktif.
- **`POST /auth/password`** (sudah login): kata sandi lama diverifikasi, kata sandi baru disimpan. Sesi lain berakhir (lewat `password_changed_at`), dan perangkat ini langsung mendapat sesi baru.
- **`POST /auth/forgot`** (publik):
  - Jawaban selalu sama, sehingga tidak bisa dipakai menebak email terdaftar.
  - Dibatasi per IP dan per email.
  - Token acak 32 byte; hanya hash-nya yang disimpan di `auth_password_resets`.
  - Berlaku 30 menit, sekali pakai, dan token lama otomatis batal.
  - Tautan dibangun hanya dari `APP_URL`, bukan header Host, untuk mencegah *host-header injection*. `APP_URL` wajib di produksi jika `Mailer` tersambung.
- **`POST /auth/reset`:** memvalidasi token, menyimpan kata sandi baru, dan menandai token terpakai; semua sesi berakhir.
- **`GET /auth/options`:** memberi tahu frontend fitur mana yang aktif.
- **Audit:** masuk, gagal masuk, keluar, ganti kata sandi, minta reset, reset selesai.
- **Web:** `/forgot-password`, `/reset-password`, `/account/password`. Tautan "Lupa kata sandi?" hanya muncul bila tersedia. Menu pengguna merender slot `user-menu:items`.

### `settings` 0.1.0 (baru)
- **Tabel** `settings`: kunci → JSON, pencatat perubahan, waktu.
- **Profil perusahaan:** nama, nama legal, alamat, telepon, email, NPWP, zona waktu (default `Asia/Jakarta`).
- **Contract** `SettingsClient.Company(ctx)` untuk modul lain, misalnya kop dokumen.
- **API:**
  - `GET /settings/company` untuk semua yang sudah login.
  - `PUT /settings/company` butuh izin `settings.manage`.
  - Logo lewat endpoint milik `settings` sendiri, didukung port opsional `FileStore` (← `files`); tanpa `files`, unggah logo disembunyikan.
  - `GET /settings/company/logo` publik, supaya halaman login bisa menampilkannya.
- **Halaman `/settings`:** bagian Perusahaan, plus slot `settings:sections` untuk modul lain.
- **Audit** setiap perubahan.

### `audit-log` 0.1.0 (baru)
- **Mengisi `d.Audit`.**
- **Tabel** `audit_log`: hanya tambah, tidak ada endpoint ubah atau hapus. Indeks waktu, modul+aksi, target, pelaku.
- **API** `GET /api/v1/audit` dengan filter modul, pelaku, target, dan rentang tanggal (izin `audit-log.read` — nama izin wajib berawalan id modul).
- **Nama pelaku:** lewat port opsional `UserDirectory` (← `users`); tanpa itu, ditampilkan "Pengguna #12".
- **Retensi:** `AUDIT_RETENTION_DAYS` (default 365), dibersihkan harian lewat `d.Jobs`.
- **Halaman "Log aktivitas":** filter, tabel, dan detail perubahan.

### `files` 0.1.0 (baru)
- **Tabel** `files`. Isinya disimpan di `DATA_DIR/files/<yyyy>/<mm>/<id-acak>`.
- **Contract** `FileClient`: Save, Get, Open, Delete. Modul lain melayani file miliknya lewat endpoint mereka sendiri, sehingga hak akses ditentukan pemilik data.
- **Unggahan:**
  - Ditulis langsung ke disk lewat streaming, bukan ke `/tmp` di RAM.
  - Batas ukuran `FILES_MAX_BYTES` (default 10 MiB).
  - Tenggat baca diperpanjang khusus untuk endpoint unggah.
  - Jenis file ditentukan dari isinya: gambar (tanpa SVG), PDF, dan dokumen kantor.
  - Hash SHA-256 dicatat.
- **Unduhan:** `nosniff`, `Content-Disposition` yang aman, dan CSP `sandbox`.
- **Hapus = soft delete;** file fisik dibersihkan setelah 30 hari oleh `d.Jobs`.
- **Halaman admin "Berkas":** daftar, unduh, hapus (izin `files.read` dan `files.manage`).

### `rbac` 0.4.0
- Mencatat audit untuk perubahan peran dan keanggotaan.

## Pengujian

- **Tes unit** setiap modul dengan port tiruan.
- **Testbed end-to-end** dengan MySQL dan **penerima SMTP buatan testbed**:
  - email benar-benar terkirim dan bisa dibaca;
  - alur lupa → reset → masuk;
  - ganti kata sandi sendiri;
  - audit tercatat;
  - settings dengan logo;
  - unggah dan unduh file, termasuk SVG dan ukuran berlebih yang ditolak;
  - **dua API pada database yang sama mengirim setiap email tepat sekali**.
- **`auth-alone`:** tetap berjalan tanpa `users` dan `mailer`, dan fitur reset dilaporkan nonaktif.
- **Tinjauan independen** di akhir.

## Tinjauan independen dan perbaikannya

Dua peninjau terpisah (keamanan; arsitektur dan kebenaran) membaca seluruh perubahan. Setiap
temuan diperiksa di kode sebelum diperbaiki; tidak ada temuan kritis.

| Temuan | Perbaikan |
|---|---|
| Email teks polos terkirim tanpa isi (`buf.Bytes()` dievaluasi sebelum isi ditulis) | Urutan diperbaiki; tes memeriksa isi tiba |
| Backup berkas membeku setelah hari ke-5: snapshot diurutkan menurut waktu modifikasi, yang sama untuk semua snapshot | Diurutkan menurut nama (tanggal), juga untuk dump; disimulasikan dengan waktu identik |
| Limiter penuh menolak semua orang (`MaxKeys`), IPv6 dihitung per alamat | Kunci paling lama dibuang; limiter terpisah untuk alur kata sandi; IPv6 per /64 |
| Token reset tetap berlaku setelah ganti kata sandi atau ganti email | Token terikat ke email tujuan dan waktu pembuatannya; ditolak bila salah satunya berubah |
| Tautan reset tersimpan di `mail_outbox` 30 hari; token di query string (log nginx) | Isi email dikosongkan setelah terkirim; token di fragmen `#token=` dan dihapus dari address bar |
| Login yang bertepatan dengan ganti kata sandi mendapat sesi | Sesi dimulai saat kata sandi diperiksa; perubahan sesudahnya mengakhirinya |
| Waktu jawaban "lupa kata sandi" membedakan email terdaftar | Pencarian dan pengiriman berjalan setelah jawaban |
| Gagal masuk mencatat teks yang diketik (bisa jadi kata sandi) | Email tak terdaftar dicatat tersamar (`b***@example.com`) |
| Token reset terpakai sebelum kata sandi tersimpan | Dikembalikan bila penyimpanan gagal |
| Mailer: kegagalan mencatat hasil diabaikan; lease 5 menit lebih pendek dari batch terburuk | Error dicatat dan menghentikan putaran; batch 10 × 1 menit, lease 11 menit; pencatatan tetap jalan saat shutdown |
| SMTP mengabaikan pembatalan saat shutdown | `context.AfterFunc` memutus koneksi |
| Ubah profil sendiri menulis ulang `is_active`/email (bisa mengaktifkan akun yang baru dinonaktifkan) | Query khusus `UPDATE users SET name` |
| Upgrade `auth` dengan `users` lama tidak ter-compile | `requires` di adapter (`users` ≥ 0.5.0), ditolak installer, diperiksa `rules.mjs` |
| Unggah/unduh besar terpotong timeout server | `request.AllowTransfer` di kernel 5, dipakai `files` dan `settings` |
| Kunci job tertinggal bila `RELEASE_LOCK` gagal; job tak dihentikan di jalur error | Koneksi dibuang (`driver.ErrBadConn`); `Jobs.Stop` di setiap jalur keluar |
| Aplikasi lain memegang nama kunci yang sama | Peringatan di log setelah 5 putaran berturut-turut terlewat |
| Simpan pengaturan pertama bersamaan bisa deadlock (gap lock) | Baris dibuat dulu (`INSERT … ON DUPLICATE KEY`) sebelum dikunci |
| Pesan kata sandi lemah terbungkus tiga kali | Hanya aturan yang dilanggar, misalnya "minimal 8 karakter" |
| `deploy.sh` gagal bila `sudo chown` tidak diizinkan | Menjadi peringatan; aplikasi yang menyimpan file menolak start dengan pesan jelas |
| Dokumen: interval mailer, langkah upgrade kernel 5, slot terbuka tanpa cek ejaan | Diperbarui |

## Belum (sengaja)

- Mengganti email sendiri, 2FA, refresh token, SSO.
- Lampiran email.
- Pratinjau gambar dan thumbnail.
- Batas kuota per pengguna.
- Antivirus untuk file unggahan.

## Bukti

Diverifikasi 26 Oktober 2026, semuanya lokal (CI GitHub masih terkunci billing):

- **Testbed library, kelima skenario hijau (174 pemeriksaan)** dengan MySQL, golang-migrate, dan
  penerima SMTP buatan testbed. Termasuk:
  - email reset benar-benar tiba lewat SMTP, dikirim pekerja latar belakang;
  - jawaban "lupa kata sandi" sama untuk email terdaftar dan tidak;
  - lupa → reset → masuk, token sekali pakai;
  - isi email terkirim dikosongkan;
  - **dua API pada database yang sama mengirim setiap email tepat sekali**;
  - ganti kata sandi sendiri, profil sendiri, pengaturan dengan logo, unggah/unduh file (SVG dan ukuran berlebih ditolak), jejak audit;
  - `auth-alone` tetap berjalan dengan fitur kata sandi nonaktif (501);
  - mekanisme: port yang disambung belakangan memindahkan baris registry, adapter yang butuh provider lebih baru ditolak.
- **Tes unit** setiap modul dengan port tiruan, termasuk:
  - token reset mati setelah ganti kata sandi atau ganti email;
  - simpan gagal tidak menghabiskan token;
  - login yang bertepatan dengan ganti kata sandi;
  - limiter yang penuh tidak mengunci orang baru;
  - IPv6 per /64;
  - email tersamar di audit;
  - email teks polos tiba dengan isinya;
  - SMTP berhenti saat dibatalkan;
  - `AllowTransfer` mengalahkan timeout server.
- **Kernel:** tes `jobs`, `audit`, `server`, `shared/request`.
- **Smoke test** tiga stack hijau, termasuk `/readyz` Go terhadap MySQL.
- **`check-drift`** bersih; kontrak modul kernel 5 diterima.
- **Katalog** lolos `--check --since HEAD`. `adapter-requires` terbukti menolak versi yang belum dirilis.
- **Skrip backup:** urutan pemangkasan disimulasikan dengan waktu modifikasi identik; lima terbaru tetap ada.
- **Tinjauan independen** keamanan dan arsitektur; temuannya di tabel di atas.
