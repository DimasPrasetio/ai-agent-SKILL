# Rencana — Library Modul Reusable (`elcodelabs-modules`)

> Status: **Fase 1 selesai (24 Oktober 2026)** — lihat [Hasil Fase 1](#hasil-fase-1). Fase 2–4 belum dimulai.
> Disusun 24 Oktober 2026 dari diskusi desain.
> `Plan.md` adalah riwayat pekerjaan sebelumnya dan tidak diubah oleh dokumen ini.

## Tujuan

Saat membangun aplikasi, AI tidak menulis ulang hal yang sama dari nol. AI mencari modul yang
relevan di library, memasangnya, lalu hanya **membuat** bagian yang custom atau yang belum
tersedia. Target jangka panjang: ratusan modul.

## Keputusan yang sudah dikunci

| # | Keputusan | Alasan singkat |
|---|---|---|
| K1 | Backend library fokus **Go** dulu | Satu stack menekan pekerjaan; NestJS/Express menyusul untuk modul inti saja |
| K2 | Mekanisme pasang: **salin ke project + lockfile + 3-way merge** (gaya shadcn/Copier) | AI bebas custom, struktur identik dengan modul buatan sendiri, upgrade tetap mungkin |
| K3 | Semua modul di **satu repo GitHub**, versi per modul lewat tag berawalan (`auth/v1.2.0`) | Satu katalog, satu CI, ketergantungan antarmodul mudah dicek |
| K4 | Modul punya `kind`: `fullstack` (api + web), `backend`, `ui` | Kontrak API dan frontend berubah bersama, jadi diberi versi bersama |
| K5 | **Konvensi shadcn/ui + Radix** jadi fondasi UI yang dikunci di skill | Komponen mini-erp-v2 memakai konvensi ini; tanpa nama token yang sama, komponen yang dipanen tidak jalan |
| K6 | Gaya **"Bingkai Navy"** (mini-erp-v2, ADR-0017) jadi **preset di library**, bukan default skill | Skill tetap mewajibkan riset desain per jenis aplikasi; preset dipakai bila cocok (ERP/back-office) |
| K7 | Urutan kerja: Fase 1 fondasi skill → Fase 2 repo library → Fase 3 installer → Fase 4 panduan di skill | Modul harus ditulis di atas pola scaffold yang sudah pasti |
| K8 | **Modul tidak saling meng-import** (ports & adapters, diputuskan 24 Oktober 2026): kebutuhan dinyatakan di `ports/` milik consumer, penawaran di `contracts/` milik provider, disambung hanya di composition root (`internal/modules/` di Go) lewat adapter kecil | Setiap modul bisa dipasang, diuji, di-upgrade, dan diganti sendiri; provider bisa modul library atau kode project sendiri. Mengubah aturan lama "hanya `contracts/` yang publik" |
| K9 | Dari mini-erp-v2 **hanya desainnya** yang diambil (nilai token, font, kepadatan, tampilan komponen), bukan sistem dan mekanismenya | Mekanisme dibangun baru di atas kernel dan standar skill ini |

## Tiga lapis desain

| Lapis | Isi | Rumah |
|---|---|---|
| Konvensi | nama token shadcn, `cn()`, `components.json`, struktur folder komponen | **Skill** (Fase 1) |
| Gaya | nilai token navy OKLCH, font, bingkai sidebar, kepadatan tabel | **Library** `themes/bingkai-navy/` (Fase 2) |
| Komponen | ui, patterns, layout aplikasi | **Library**, ditulis ulang dengan tampilan Bingkai Navy — tanpa mekanisme mini-erp-v2 (Fase 2) |

---

## Fase 1 — Fondasi di skill `monorepo-elcodelabs`

Tujuan: setiap project hasil scaffold punya **kernel** (API dasar yang stabil) dan **titik
pasang** yang bisa diandalkan modul library. Backend hanya Go; bagian frontend berlaku untuk
ketiga stack.

### A. Backend Go — kernel

1. **`internal/config/`**: `config.Load()` membaca env menjadi satu struct.
2. **`internal/database/`**: `database.Open(dsn)` → `*sql.DB`. `/readyz` benar-benar ping DB
   dan menjawab 503 bila DB tidak terjangkau (sekarang selalu "ready").
3. **`internal/shared/`**:
   - `response/`: `OK`, `Created`, `Fail`, format `{success, message, data}` sesuai
     `references/api-standard.md`.
   - `errors/`: `AppError` membawa kode error + status HTTP.
   - `logger/` (`log/slog` bawaan), `validator/`, `pagination/`.
4. **`internal/server/`**: middleware request-id, recover, logging. Health, readyz, dan static
   handler dipindah dari `main.go` ke sini; `main.go` tinggal merakit.
5. **`internal/kernel/`**: struct `Deps` (config, DB, logger) yang diterima setiap modul, plus
   konstanta `KERNEL_VERSION = 1`. `module.yaml` nanti menyatakan `requires_kernel: 1`.

### B. Backend Go — titik pasang modul

6. **`internal/modules/registry.go`** dengan penanda untuk installer:
   ```go
   func Register(mux *http.ServeMux, d *kernel.Deps) {
   	// elco:modules:begin
   	// elco:modules:end
   }
   ```
   Kontrak setiap modul: `New(d *kernel.Deps, <contract yang dibutuhkan>...)`,
   `Routes(mux *http.ServeMux)`, dan `Client()` bila modul menyediakan contract.
   Ketergantungan ditulis eksplisit sehingga dicek compiler.
7. **Router**: `http.ServeMux` bawaan Go 1.22+ dengan pola `"GET /api/v1/users/{id}"`.
8. **Migrasi pakai timestamp**: `migrate:create` tanpa `-seq`.
9. **`sqlc.yaml`** diberi penanda `# elco:sqlc:begin` / `# elco:sqlc:end`.

### C. Frontend — konvensi shadcn/ui (semua stack)

10. **Dependency fondasi** di `apps/web/package.json`: `radix-ui`, `class-variance-authority`,
    `cn`, `lucide-react`, `tw-animate-css`. (`sonner`, `cmdk`, `recharts`,
    font, dll. **tidak** di scaffold — ikut modul/preset yang membutuhkannya.)
11. **`components.json`** mengikuti mini-erp-v2, supaya `npx shadcn add` langsung bekerja:
    style `new-york`, css `src/theme/theme.css`, alias `ui` → `@/shared/components/primitives`,
    `utils` → `cn`, ikon `lucide`.
12. ~~`src/shared/lib/cn.ts`~~ — diganti paket `cn` (lihat Hasil Fase 1).
13. **Struktur komponen tiga tingkat**:
    ```txt
    shared/components/
    ├── primitives/   # shadcn apa adanya (button, input, dialog, …)
    ├── ui/           # komposisi generik (data-table, form-field, page-header, …)
    ├── patterns/     # pola halaman (toolbar, stepper, sticky-footer, …)
    └── feedback/
    ```
14. **`theme.css` ditulis ulang ke konvensi token shadcn** dengan **nilai netral** (bukan navy):
    `--background`, `--foreground`, `--card`, `--popover`, `--muted(-foreground)`,
    `--primary(-foreground)`, `--accent`, `--border`, `--input`, `--ring`, `--radius`,
    ditambah perluasan yang dipakai mini-erp-v2: `--primary-hover`, status
    `--success/-soft`, `--warning/-soft`, `--destructive/-soft`, `--info/-soft`,
    `--chart-1..5`, `--sidebar-*`, `--row-py`, `--shadow-card/-md/-pop`, lalu blok
    `@theme inline` yang memetakannya ke kelas Tailwind (`bg-card`, `text-muted-foreground`, …).
    **Nama token adalah kontrak; nilainya milik preset/proyek.**
15. **Primitives minimum di scaffold**: `button`, `input`, `label`, `card`, `badge`, `dialog`,
    `spinner`, `skeleton` — cukup untuk halaman login dan dashboard bawaan. Sisanya datang dari
    library (Fase 2).
16. **Halaman bawaan** (`LoginPage`, `DashboardPage`, `LoadingState`) dimigrasi dari
    `var(--color-…)` ke kelas semantik dan primitives di atas. `theme/colors.ts` dihapus atau
    diturunkan dari token (satu sumber warna).
17. **Registry route `app/routes/modules.ts`** dengan penanda `// elco:routes:begin/end`. Setiap
    modul mengekspor `routes.tsx` berisi `{ public, protected }`.
18. **Titik sambung `http-client.ts`**: `setAuthToken()` dan `onUnauthorized()`.

### D. Aturan, referensi, dan pengujian

19. **`references/frontend.md`**: kunci shadcn/ui + Radix sebagai fondasi UI; daftar dependency
    yang diizinkan; aturan "hanya kelas semantik, tanpa warna mentah"; struktur tiga tingkat;
    hubungan dengan `frontend-design` (skill itu tetap otoritas arah visual, shadcn adalah
    fondasi teknis). Ganti bagian "Theme color standard".
20. **`references/design-research.md`**: brief di `knowledge/DESIGN.md` boleh menyatakan
    "memakai preset `<nama>`" dan hanya mencatat penyesuaiannya. Riset tetap wajib untuk jenis
    aplikasi yang tidak cocok dengan preset mana pun.
21. **`references/backend-go.md`**: kernel, kontrak modul, registry, migrasi timestamp.
22. **`.claude/rules/modules.md`** (dibuat scaffold): kode custom di file terpisah, penanda
    `elco:*` tidak boleh dihapus, modul hanya didaftarkan lewat registry.
23. **`.claude/rules/frontend-react.md`**: tambahkan aturan kelas semantik + primitives.
24. **`smoke-test.mjs`**: `go vet` + `go build`; `/readyz` 503 tanpa DB dan 200 dengan DB (bila
    DB tersedia; dilewati secara eksplisit bila tidak); `build:web` dengan primitives baru.
    Hijau untuk ketiga stack.
25. **`check-drift.mjs`**: tambah pemeriksaan bahwa `theme.css` dan `components.json` di
    `references/frontend.md` sama dengan yang dihasilkan scaffold.

### Keputusan (sudah diambil)

| # | Keputusan | Hasil |
|---|---|---|
| T1 | Folder kosong `auth`, `users`, `order` + migrasi `users` di scaffold | Dihapus untuk Go. `LoginPage`/dashboard tetap sampai modul `auth` library siap (Fase 2). NestJS/Express tidak diubah |
| T2 | Router Go | `http.ServeMux` bawaan |

### Gerbang Fase 1

- `smoke-test.mjs` dan `check-drift.mjs` hijau untuk ketiga stack.
- Project Go hasil scaffold: `/readyz` mencerminkan status DB; `registry.go`, penanda `sqlc`,
  dan registry route ada.
- Satu primitive shadcn yang ditambahkan dengan `npx shadcn add <x>` langsung tampil benar
  tanpa edit manual.
- Satu komponen `ui` dari mini-erp-v2 (mis. `page-header`) yang disalin bisa di-build tanpa
  mengubah kodenya, selain mengganti import `@/shared/lib/cn` → `cn`.

### Hasil Fase 1

Dikerjakan sesuai rincian di atas, dengan penyesuaian berikut (alasannya ditemukan saat
implementasi):

- **`cn` dari paket npm resmi shadcn, bukan `clsx` + `tailwind-merge` + `cn.ts` lokal** (item
  10–12). shadcn CLI 4.22 kini menulis `import { cn } from "cn"` ke setiap komponen dan memasang
  paket `cn` (github.com/shadcn-ui/cn, pengganti drop-in keduanya). `components.json` mini-erp-v2
  (`utils: "@/shared/lib/cn"`) ternyata ikut menghasilkan `from "cn"`, jadi alias diset
  `utils: "cn"`. Dependency fondasi: `radix-ui`, `class-variance-authority`, `cn`,
  `lucide-react`, `tw-animate-css`. Saat panen di Fase 2, import `@/shared/lib/cn` di komponen
  mini-erp-v2 diganti `cn` — satu penggantian mekanis per file.
- **`theme.css` sekaligus entry Tailwind** (`@import "tailwindcss"`, seperti mini-erp-v2), karena
  `components.json` menunjuk ke file itu. `globals.css` hanya meng-import-nya.
- **Kode kernel dan primitives disimpan sebagai file nyata** di `scripts/templates/` (ikut
  terpaket di `.skill`), disalin scaffold dengan substitusi `__GO_MODULE__`.
- **Paket error Go bernama `shared/apperror`**, bukan `shared/errors`, agar tidak menutupi paket
  standar `errors`. Ditambah `shared/request` (`DecodeJSON`, `PathInt64`).
- **Migrasi baseline no-op** (`<timestamp>_baseline`) karena golang-migrate gagal `up` di
  direktori kosong — deploy pertama akan rusak tanpanya.
- **`sqlc generate` gagal ("no packages") sampai modul pertama masuk** — batasan sqlc,
  didokumentasikan di `backend-go.md` dan `sqlc.yaml`.
- **Path route milik modul** ada di `routes.tsx` modul itu; `route-paths.ts` hanya path tingkat
  aplikasi. `/` dialihkan ke `/dashboard`.
- **Aturan baru `.claude/rules/modules.md`** dibuat untuk ketiga stack (baris khusus Go hanya
  untuk Go).

Bukti gerbang:

- `check-drift.mjs` hijau, termasuk tiga pemeriksaan baru: kontrak token (53 nama, dua arah,
  plus pemetaan `@theme inline`), wiring shadcn (`cn`, `components.json`), dan penanda registry
  Go. Pemeriksaan kontrak token sudah diuji dengan sengaja menghapus token.
- `smoke-test.mjs` hijau untuk ketiga stack. Untuk Go: gofmt, modul contoh `ping` dipasang lewat
  penanda (`registry.go`, `sqlc.yaml`, migrasi) + `sqlc generate`, `go vet`, `go build`, lalu
  binary dijalankan: health 200, `/readyz` 503 tanpa DB dan 200 dengan
  `SMOKE_DB_DSN` (diuji ke MySQL lokal), 404 JSON untuk path API tak dikenal, route modul contoh
  terpasang. `dev:api` lewat `air` dilewati karena `air` tidak terpasang di mesin ini.
- `npx shadcn@latest add separator tooltip` langsung bekerja tanpa edit dan tanpa mengubah
  `package.json`. `page-header` mini-erp-v2 di-build apa adanya; `section-card` dan
  `summary-card` di-build setelah import `cn` diganti.
- Halaman login dan dashboard dicek di browser.

---

## Fase 2–4 (ringkas)

**Fase 2 — Repo `elcodelabs-modules`**
- Struktur: `modules/<id>/{module.yaml, README.md, api/, migrations/, web/, tests/}`,
  `themes/`, `testbed/`, `CATALOG.md` + `catalog.json` (dibuat CI).
- Format `module.yaml`: `id`, `version`, `kind`, `stacks`, `requires_kernel`, `provides`
  (contract yang ditawarkan), `ports` (kebutuhan dari luar + apakah wajib atau opsional),
  `owns_tables`, `env`, `routes`, `when_to_use`, `when_not_to_use`. Tidak ada daftar modul lain
  yang wajib dipasang — sebuah port bisa dipenuhi modul mana pun atau kode project.
- Preset `themes/bingkai-navy/`: nilai token navy untuk `theme.css`, font, dan `DESIGN.md`
  ringkas — **hanya desain** dari mini-erp-v2.
- Komponen `ui`/`patterns`/layout aplikasi: tampilannya mengikuti Bingkai Navy, tetapi kodenya
  ditulis ulang di atas primitives shadcn dan kontrak token. Perilaku dan mekanisme mini-erp-v2
  (saved views, draft storage, alur data, dsb.) tidak dibawa.
- Modul pilot: `users` dan `auth`, **masing-masing berdiri sendiri**. `auth` menyatakan port
  `UserStore`; `users` menawarkan `UserClient`. Testbed membuktikan tiga hal: `auth` jalan
  dengan adapter ke `users`, `auth` jalan dengan implementasi `UserStore` buatan project, dan
  setiap modul lolos tes sendirian.

**Fase 3 — Installer `module.mjs`** (di repo library): `list`, `add` (ganti import path,
nomori migrasi, tambah blok sqlc, daftarkan registry dan route, buat adapter bila provider port-nya modul library yang dikenal
(selain itu laporkan port yang belum terpenuhi), tulis
`modules.lock.json`, perbarui `MODULE_MAP.md`), lalu `outdated`, `upgrade` (3-way merge),
`detach`, `promote`.

**Fase 4 — Kembali ke skill**: `references/module-library.md` dan langkah perakitan di
`SKILL.md` (baca katalog → pakai / adaptasi / buat baru → konfirmasi sekali → pasang → buat
sisanya → uji).
