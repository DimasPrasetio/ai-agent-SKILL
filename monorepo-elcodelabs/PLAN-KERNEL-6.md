# Rencana — Kernel 6: fondasi untuk aplikasi bisnis apa pun

> Disusun 26 Oktober 2026; **dibangun** pada hari yang sama (lihat "Penyesuaian saat
> dibangun" dan "Bukti" di akhir). Dasar riset: laporan
> `reports/Cakupan kernel 6 platform modular.md` (ABP, Spring Modulith, Frappe, Odoo, Medusa,
> Laravel, Rails 8, NestJS, pola Go + MySQL, kebutuhan ERP/HRMIS/WMS Indonesia). Keputusan
> pemilik: lingkup organisasi **opsi B**, opsional per modul.

## Tujuan dan batas

Kernel 6 memberi modul semua yang **tidak bisa mereka buat sendiri di dalam folder modul** dan
yang **dibutuhkan banyak modul**, sehingga ERP, HRMIS, gudang, booking, POS, LMS, dan aplikasi
internal lain bisa dibangun hanya dengan menambah modul dan Go kit — tanpa kernel 7.

| Prinsip | Artinya di kernel 6 |
|---|---|
| Aditif | Modul kernel 5 tetap compile dan berperilaku sama. Antarmuka baru yang opsional diperiksa dengan type assertion |
| Satu MySQL, satu proses | Atomisitas lintas modul dari satu transaksi; antrean dan event di tabel MySQL; tanpa Redis, broker, atau engine saga |
| Default yang berjalan sendiri | Seperti `d.Auth`/`d.Audit`: tanpa modul penyedia, setiap slot punya perilaku aman (lingkup = perusahaan 1, dst.) |
| Eksplisit, bukan sihir | Tidak ada filter SQL tersembunyi, tidak ada listener sinkron di dalam transaksi |

**Di luar cakupan (pemicu kernel 7):** SaaS multi-tenant (banyak klien di satu aplikasi),
WebSocket dua arah, lebih dari satu container secara permanen, database selain MySQL.

## Ringkasan isi

| # | Kemampuan | API | File kernel (Go) |
|---|---|---|---|
| 1 | Transaksi bersama | `d.Tx.Do`, `d.Tx.Conn`, `d.Tx.AfterCommit` | `kernel/tx.go` |
| 2 | Tugas latar | `d.Tasks.Register`, `d.Tasks.Enqueue` | `kernel/tasks.go` |
| 3 | Event antarmodul | `d.Events.Publish`, `d.Events.On` | `kernel/events.go` |
| 4 | Jadwal kalender | `d.Jobs.Daily/Weekly/Monthly` | `kernel/jobs.go`, `kernel/calendar.go` |
| 5 | Waktu | `d.Clock`, `APP_TIMEZONE` | `kernel/clock.go`, `config.go`, `main.go` |
| 6 | Lingkup organisasi | `kernel.ScopeFrom(ctx)`, `d.Scope`, `d.Authz.Units` | `kernel/scope.go`, `kernel/authz.go` |
| 7 | Audit diperluas | `AuditEntry.Kind`, lingkup di record | `kernel/audit.go` |
| 8 | Respons berumur panjang | `request.AllowStream` | `shared/request/stream.go`, `main.go`, nginx |
| 9 | Titik pasang | `d.HTTP.Use`, `database.OpenWith` | `kernel/http.go`, `database.go` |
| 10 | Alat uji | `kerneltest` | `kernel/kerneltest/` |

`kernel.Deps` bertambah: `Tx *TxSlot`, `Tasks *TasksSlot`, `Events *EventsSlot`,
`Clock Clock`, `Scope *ScopeSlot`, `HTTP *HTTPSlot`.

---

## 1. `d.Tx` — transaksi bersama

### API

```go
// DBTX is what sqlc's generated Queries accept: a *sql.DB or a *sql.Tx.
type DBTX interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
	PrepareContext(context.Context, string) (*sql.Stmt, error)
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

// Do runs fn in a transaction carried by the returned ctx. Inside an existing one it joins it
// (no savepoint) and never commits; only the outermost Do commits, retries, and runs hooks.
func (t *TxSlot) Do(ctx context.Context, fn func(ctx context.Context) error, opts ...TxOption) error

// Conn is the transaction in ctx, or the pool when there is none. Repositories call it per
// operation: queries.New(d.Tx.Conn(ctx)).
func (t *TxSlot) Conn(ctx context.Context) DBTX

// AfterCommit runs fn once the outermost transaction commits; dropped on rollback or retry.
// Outside a transaction it runs at once. Best effort: fn must not be the only record of work
// (use d.Tasks for that).
func (t *TxSlot) AfterCommit(ctx context.Context, fn func(ctx context.Context))

func (t *TxSlot) InTx(ctx context.Context) bool

// Options: ReadCommitted() for heavy locking-read paths; NoRetry() when fn is not safe to repeat.
```

### Aturan perilaku

| Hal | Aturan |
|---|---|
| Bersarang | `Do` di dalam `Do` ikut transaksi luar. Error dari dalam dikembalikan; transaksi luar yang memutuskan rollback |
| Retry | Hanya `Do` terluar, pada MySQL **1213** (deadlock) dan **1205** (lock wait timeout). Maksimal 4 percobaan, backoff acak `0..25ms·2^n`. Pada 1205 transaksi **di-rollback utuh** dulu (MySQL hanya me-rollback statement-nya) |
| Panic | Rollback, lalu panic diteruskan |
| Isolasi | Default REPEATABLE READ (default MySQL). Penguncian eksplisit `SELECT … FOR UPDATE` pada baris induk, urutan konsisten (mis. menurut ID) |
| Larangan | Closure **tidak boleh memanggil API luar** (email, Coretax, bank): retry akan mengulanginya dan rollback tidak membatalkannya. Efek luar → `d.Tasks.Enqueue` di dalam closure |
| Kontrak antarmodul | Port menerima `ctx`. Bila `ctx` membawa transaksi, provider ikut di dalamnya — tanpa parameter tambahan |
| Durasi | Transaksi pendek: tidak ada sleep, tidak ada I/O jaringan. Batch besar dipecah menjadi tugas lanjutan |

### Contoh (modul `sales`, setelah ERP dibangun)

```go
err := s.tx.Do(ctx, func(ctx context.Context) error {
	if err := s.repo.MarkDelivered(ctx, id); err != nil { // queries.New(tx.Conn(ctx))
		return err
	}
	if err := s.stock.Issue(ctx, lines); err != nil { // port → inventory, same transaction
		return err
	}
	return s.events.Publish(ctx, "sales.delivery.posted", 1, payload) // written in the same commit
})
```

---

## 2. `d.Tasks` — tugas latar yang tahan crash

### API

```go
type Lane string // "short" (fast work, event delivery) | "long" (exports, payroll, reposting)

type TaskKind struct {
	Lane          Lane          // default short
	Concurrency   int           // max running at once for this kind; default: lane's worker count
	Timeout       time.Duration // default 60 s (short), 30 min (long)
	MaxAttempts   int           // default 5, then status failed
	NonTransactional bool       // long jobs that commit in batches themselves; handler must be idempotent
}

type Task struct {
	ID       int64
	Kind     string          // "<module>.<task>"
	Payload  json.RawMessage
	Attempt  int
}

// Register in New; kinds are unique app-wide (like permissions).
func (s *TasksSlot) Register(kind string, h func(ctx context.Context, t Task) error, k TaskKind)

// Enqueue writes through d.Tx.Conn(ctx): inside a transaction the task exists only if it commits.
func (s *TasksSlot) Enqueue(ctx context.Context, kind string, payload any, opts ...EnqueueOption) error
// Options: At(time) / After(dur), Dedupe(key) — at most one waiting task per (kind, key).

// For the ops module (admin UI) — read and act, never a second runner.
func (s *TasksSlot) List(ctx context.Context, f TaskFilter) ([]TaskInfo, int64, error)
func (s *TasksSlot) Retry(ctx context.Context, id int64) error
func (s *TasksSlot) Discard(ctx context.Context, id int64) error
```

Handler berjalan dengan `ctx` yang memulihkan **aktor, lingkup, dan request ID asal** dari
envelope, sehingga audit dan otorisasi di kode latar tidak menebak.

### Tabel

```sql
CREATE TABLE kernel_tasks (
  id BIGINT NOT NULL AUTO_INCREMENT,
  kind VARCHAR(100) NOT NULL,
  lane VARCHAR(10) NOT NULL,
  status VARCHAR(10) NOT NULL,            -- ready | running | done | failed
  payload JSON NOT NULL,
  envelope JSON NOT NULL,                 -- actor_id, company_id, branch_id, request_id
  dedupe_key VARCHAR(191) NULL,
  dedupe_active VARCHAR(191) GENERATED ALWAYS AS
    (CASE WHEN status = 'ready' THEN dedupe_key END) STORED,
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL,
  run_at DATETIME(6) NOT NULL,
  locked_until DATETIME(6) NULL,
  lease_token CHAR(32) NULL,
  last_error VARCHAR(1000) NOT NULL DEFAULT '',
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY kernel_tasks_dedupe (kind, dedupe_active),
  KEY kernel_tasks_due (lane, status, run_at),
  KEY kernel_tasks_status (status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### Siklus

| Tahap | Mekanisme |
|---|---|
| Enqueue | `INSERT … ON DUPLICATE KEY UPDATE id = id` (dedupe = no-op). `AfterCommit` mengirim sinyal ke worker jalur itu |
| Bangun | Sinyal in-process; polling cadangan tiap 1 detik (short) / 5 detik (long) |
| Klaim | Tx pendek: `SELECT id … WHERE lane=? AND status='ready' AND run_at<=? ORDER BY run_at, id LIMIT n FOR UPDATE SKIP LOCKED` → `UPDATE status='running', lease_token=?, locked_until=now+timeout, attempts=attempts+1` → commit. Eksekusi di luar tx klaim |
| Jalan (default) | Handler di dalam `d.Tx.Do`; di transaksi yang sama `UPDATE … SET status='done' WHERE id=? AND lease_token=?`. 0 baris (lease hilang) → rollback. **Efek database tepat sekali** |
| Jalan (`NonTransactional`) | Handler tanpa tx; selesai ditandai terpisah. Efek database at-least-once → handler wajib idempoten |
| Gagal | `attempts < max` → `ready` dengan `run_at = now + min(1 jam, 30 s·2^(attempts-1) + jitter)`; selain itu `failed` (disimpan sampai Retry/Discard) |
| Reaper | Job kernel tiap menit: `running` dengan `locked_until < now` → `ready`, atau `failed` bila itu percobaan terakhirnya |
| Purge | Job kernel tiap 6 jam: `done` lebih tua dari 7 hari dihapus |
| Worker | `short` 2, `long` 1, ditambah 2 slot `d.Jobs`: maksimal 5 dari 10 koneksi pool. Request tetap didahulukan |
| Shutdown | Berhenti mengklaim begitu SIGTERM datang; tugas berjalan selesai bersamaan dengan drain request (anggaran 25 detik); yang terputus langsung dikembalikan ke antrean, percobaannya tidak dihitung |

Efek luar (email, API) tetap **at-least-once**: handler memakai kunci idempoten pihak luar bila
ada (mis. `webhook-id`, nomor dokumen).

---

## 3. `d.Events` — event antarmodul yang durable

### API

```go
type Event struct {
	ID         string          // ULID
	Name       string          // "<module>.<thing>.<past-verb>", e.g. "sales.invoice.posted"
	Version    int             // payload schema version, from the publisher's contract
	OccurredAt time.Time
	Payload    json.RawMessage // consumers decode into their own struct
}

// Publish writes one task per subscriber ("event:<subscriber>") through d.Tx.Conn(ctx): the event
// exists only if the publisher's transaction commits. Outside a transaction it opens its own.
func (e *EventsSlot) Publish(ctx context.Context, name string, version int, payload any) error

// On is called only in the composition root (registry.go), before Start.
func (e *EventsSlot) On(name, subscriber string, h func(ctx context.Context, ev Event) error)
```

### Aturan

| Hal | Aturan |
|---|---|
| Pengiriman | Setiap pelanggan = satu tugas `short` di transaksinya sendiri. Gagal satu tidak menahan yang lain dan tidak me-rollback penerbit |
| Jaminan | Efek database pelanggan tepat sekali (lihat `d.Tasks`); efek luar at-least-once |
| Urutan | **Tidak dijamin** (retry bisa menyalip). Pelanggan memakai versi atau timestamp dokumen, tidak mengandalkan urutan |
| Sinkron | Tidak ada listener sinkron. Konsistensi kuat = panggilan port di dalam `d.Tx`; event = reaksi |
| Skema | Penerbit mendeklarasikan `emits` (nama, versi, field) di `module.json` dan README. Dalam satu versi hanya boleh **menambah** field. Perubahan lain = versi baru, versi lama tetap dipublikasikan selama masa transisi |
| Langganan | Pelanggan mendeklarasikan `listens` (event, nama pelanggan, handler) di `module.json`; installer menulis baris `d.Events.On(…)` ke registry. Penerbit yang tidak terpasang = langganan diam (tidak error) |
| Modul tidak saling import | Payload JSON di-decode ke struct milik pelanggan (kontrak dari sisi konsumen) — tanpa import `contracts/` penerbit |

Contoh baris registry (ditulis installer):

```go
d.Events.On("sales.invoice.posted", "accounting.post-ledger", accountingModule.OnInvoicePosted)
```

---

## 4. Jadwal kalender di `d.Jobs`

### API

```go
func (s *JobsSlot) Every(name string, interval time.Duration, fn JobFunc)            // sudah ada
func (s *JobsSlot) Daily(name, at string, fn JobFunc, opts ...ScheduleOption)        // "02:00"
func (s *JobsSlot) Weekly(name string, day time.Weekday, at string, fn JobFunc, opts ...ScheduleOption)
func (s *JobsSlot) Monthly(name string, day int, at string, fn JobFunc, opts ...ScheduleOption) // 1–28, or LastDay
// ScheduleOption: Timeout(d) (default 30 min), CatchUp(window) (default 24 h, 0 = off)
```

Waktu dihitung di `APP_TIMEZONE`, disimpan UTC. Tanpa parser cron (spesifikasi terbatas = tidak
ada salah tafsir).

### Tabel

```sql
CREATE TABLE kernel_schedules (
  name VARCHAR(100) NOT NULL,
  spec VARCHAR(50) NOT NULL,              -- "daily 02:00", "monthly last 23:00"
  last_success_at DATETIME(6) NULL,
  failures INT NOT NULL DEFAULT 0,        -- consecutive
  first_failure_at DATETIME(6) NULL,
  last_error VARCHAR(1000) NOT NULL DEFAULT '',
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE kernel_schedule_runs (
  name VARCHAR(100) NOT NULL,
  scheduled_for DATETIME(6) NOT NULL,     -- the tick, UTC
  started_at DATETIME(6) NOT NULL,
  finished_at DATETIME(6) NULL,
  ok BOOLEAN NULL,
  error VARCHAR(1000) NOT NULL DEFAULT '',
  PRIMARY KEY (name, scheduled_for)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### Aturan

| Hal | Aturan |
|---|---|
| Satu kali per tick | Container yang berhasil `INSERT` baris `(name, scheduled_for)` yang menjalankan; yang lain melewati. Aman saat deploy overlap |
| Catch-up | Saat start: tick terakhir yang jatuh tempo dalam jendela (24 jam) dan belum tercatat dijalankan **sekali**, bukan sebanyak tick yang terlewat |
| Timeout | Per run (default 30 menit); ctx dibatalkan saat habis |
| Kegagalan | Dihitung di `kernel_schedules`. Ambang peringatan: ≥5 kegagalan beruntun atau 3 timeout beruntun → status "failing" di log dan modul `ops`. **Tidak dinonaktifkan otomatis** (mematikan diam-diam job tutup periode lebih berbahaya) |
| DST | Waktu lokal yang tidak ada → instan valid berikutnya; yang terulang → kemunculan pertama saja. (Asia/Jakarta tanpa DST; aturan berlaku untuk zona lain) |
| Purge | Riwayat run > 90 hari dihapus job kernel harian |

---

## 5. Waktu: `d.Clock` dan `APP_TIMEZONE`

```go
type Clock interface {
	Now() time.Time           // UTC
	Location() *time.Location // APP_TIMEZONE
}
// Date is a calendar day without a time (year, month, day) — the kernel's own small type.
type Date struct{ Year int; Month time.Month; Day int }

// Today is the business date in the request's scope location (branch time zone when scoped).
func Today(ctx context.Context, c Clock) Date
```

- `APP_TIMEZONE` (default `Asia/Jakarta`) dimuat sekali dengan `time.LoadLocation`; nilai tidak
  valid → API menolak start. Tidak ada jatuh diam-diam ke zona server.
- `cmd/server/main.go`: `import _ "time/tzdata"` (±450 KB) agar zona waktu bekerja di image Alpine.
- Semua tambahan kernel 6 (`run_at`, `occurred_at`, audit `At`) memakai `d.Clock`.

### Konvensi kolom waktu (berlaku untuk tabel baru)

| Jenis | Tipe | Alasan |
|---|---|---|
| Instan (kapan sesuatu terjadi) | `DATETIME(6)` berisi UTC | Sesi DB sudah UTC (kernel 4). `TIMESTAMP` berakhir 19 Januari 2038 — terlalu dekat untuk data bisnis yang disimpan 10 tahun |
| Tanggal bisnis (tanggal faktur, hari absensi) | `DATE` | Dihitung dengan `Today(ctx, d.Clock)` di zona lokal |

Tabel modul yang sudah ada (`TIMESTAMP(6)`) tetap; pindah ke `DATETIME(6)` dengan migrasi
expand/contract saat modulnya disentuh berikutnya.

---

## 6. Lingkup organisasi (opsi B, opsional per modul)

### API (Go)

```go
type Scope struct {
	CompanyID int64          // always ≥ 1
	BranchID  int64          // 0: no branch / all of the company
	Location  *time.Location // branch time zone, else APP_TIMEZONE
}

func ScopeFrom(ctx context.Context) Scope // never zero: the default is company 1

// A scope provider (the organization module) resolves and validates the active scope.
type ScopeResolver interface {
	// Resolve returns the active scope for the signed-in user from the request's X-Scope header
	// ("<company>" or "<company>:<branch>"), refusing one the user is not placed in.
	Resolve(ctx context.Context, userID int64, requested string) (Scope, error)
	// Companies lists the active companies — for background work that runs per company.
	Companies(ctx context.Context) ([]Scope, error)
}
func (s *ScopeSlot) Provide(r ScopeResolver)

// Optional provider interface: which units a permission reaches, for list filters.
type ScopedAuthorizer interface {
	Units(ctx context.Context, permission string) (Units, error)
}
type Units struct {
	AllBranches bool    // every branch of the active company
	BranchIDs   []int64 // otherwise these
}
func (s *AuthzSlot) Units(ctx context.Context, permission string) (Units, error)
// Without a ScopedAuthorizer: AllBranches when Can(permission), none otherwise.
```

### Perilaku

| Hal | Aturan |
|---|---|
| Tanpa penyedia | Semua request = perusahaan 1, tanpa cabang, zona `APP_TIMEZONE`. Aplikasi satu perusahaan tidak melakukan apa-apa |
| Resolusi | Di dalam `d.Auth.Require`, setelah pengguna dikenali. Header `X-Scope` divalidasi server terhadap penempatan pengguna; tidak valid → 403. Tidak pernah dipercaya mentah |
| Rute publik | Lingkup default perusahaan 1 (atau resolver memutuskan, mis. dari subdomain) |
| Satu lingkup aktif | Tepat satu perusahaan aktif per request — menghindari data silang yang diperingatkan Odoo |
| Kode latar | Tugas dan event membawa lingkup di envelope (tanpa lingkup bila di-enqueue tanpa lingkup). Jadwal berjalan tanpa lingkup — `ScopeFrom` jatuh ke perusahaan 1, benar hanya untuk aplikasi satu perusahaan; job yang bekerja per perusahaan memanggil `d.Scope.Companies(ctx)` dan `kernel.WithScope`, `kernel.HasScope(ctx)` memberi tahu apakah ctx membawa lingkup |
| Audit | Record membawa `CompanyID`, `BranchID` |

### Modul yang *scoped*

Modul menyatakan `"scoped": true` di `module.json` bila menyimpan data milik perusahaan
(transaksi, master data bisnis). Hanya modul itu yang wajib:

- kolom `company_id BIGINT NOT NULL DEFAULT 1` di setiap tabelnya (plus `branch_id` bila bermakna);
- `company_id` di setiap kunci unik bisnis (nomor faktur unik **per perusahaan**);
- predikat `company_id = ?` **eksplisit** di setiap query sqlc ke tabelnya — di `WHERE` untuk
  SELECT/UPDATE/DELETE, di daftar kolom untuk INSERT (diperiksa `rules.mjs`); query sistem lintas
  perusahaan ditandai `-- all companies` dan bernama `System…`.

Modul yang tidak scoped (blog, CMS, sesi login) tidak menanggung apa pun.

### Web

| Tambahan | Isi |
|---|---|
| `shared/scope.ts` | `useScope()`, `setScope()` — tersimpan per tab, dikirim `http-client` sebagai header `X-Scope` |
| Slot `shell:scope` | Tempat pemilih perusahaan/cabang di header (diisi modul `organization`, dirender `app-shell`) |
| App event `scope:changed` | Halaman memuat ulang data saat lingkup berganti |

---

## 7. `d.Audit` diperluas

```go
type AuditKind string // "change" (default) | "access" | "export" | "security"

type AuditEntry struct {
	// …kernel 5 fields…
	Kind AuditKind // zero value = change
}
type AuditRecord struct {
	// …kernel 5 fields…
	CompanyID int64
	BranchID  int64
}
```

- `access`: membaca data pribadi sensitif (NIK, gaji, rekening); `export`: unduhan/ekspor data;
  `security`: login gagal, perubahan izin, pembukaan kunci. Dasar: UU PDP Pasal 46 — laporan
  kebocoran 3×24 jam harus menyebut data apa, kapan, bagaimana; tanpa catatan akses itu tidak
  bisa dijawab.
- Di dalam `d.Tx`, sink menulis lewat `d.Tx.Conn(ctx)` sehingga audit ikut commit atau rollback
  bersama perubahannya. Di luar transaksi perilakunya sama seperti kernel 5.

---

## 8. Respons berumur panjang (SSE)

```go
// AllowStream switches this request to a server-sent event stream: no write deadline,
// text/event-stream, no-cache, X-Accel-Buffering: no, a heartbeat comment every 20 s. Its
// context ends when the client leaves or the server starts shutting down.
func AllowStream(w http.ResponseWriter, r *http.Request) (*Stream, error)

func (s *Stream) Send(event string, data any) error // JSON data, flushed
func (s *Stream) Context() context.Context
```

- `main.go`: `srv.BaseContext` memberi context yang dibatalkan oleh `srv.RegisterOnShutdown`,
  sehingga stream berhenti saat shutdown dimulai dan tidak menghabiskan anggaran drain 25 detik.
- Templat nginx deploy: `location ~ ^/api/v1/[^/]+/stream` dengan `proxy_buffering off`,
  `proxy_read_timeout 1h`, `proxy_http_version 1.1`, `proxy_set_header Connection ""`.
  Konvensi: endpoint stream selalu `/api/v1/<modul>/stream…`.
- Stream **tidak memegang koneksi DB**. Isi event = petunjuk; klien mengambil ulang data saat
  tersambung kembali (termasuk setelah deploy).
- Hub topik dan filter per pengguna adalah modul `realtime`, bukan kernel.

---

## 9. Titik pasang middleware dan database

```go
// HTTPSlot lets kits add middleware from the composition root, before routes are mounted.
func (s *HTTPSlot) Use(name string, mw func(http.Handler) http.Handler) // after request ID + logging, before routes

// database.OpenWith lets main.go wrap the driver connector (metrics, tracing kits).
func OpenWith(dsn string, o Options) (*sql.DB, error) // Options{Wrap func(driver.Connector) driver.Connector}
```

Pembungkus DB dipasang di `main.go` (file milik project), karena DB dibuka sebelum modul
didaftarkan. Dengan dua titik ini, kit rate-limit, metrik Prometheus, dan OpenTelemetry bisa
ditambahkan kapan saja tanpa kernel baru.

---

## 10. `kerneltest`

```go
k := kerneltest.Deps(t)           // kernel tanpa database; jam mulai 2026-01-02 09:00 WIB
k.Clock.Advance(24 * time.Hour)   // jam yang digerakkan tes (Set juga ada)
k.RunTasks()                      // menjalankan tugas yang menunggu — termasuk pengiriman event
k.Enqueued()                      // tugas yang menunggu
k.Published()                     // event yang diterbitkan
k.Audit.Records()                 // catatan audit
ctx := kerneltest.In(ctx, 2, 5)   // bekerja di perusahaan 2, cabang 5
```

Untuk tes unit modul dengan port tiruan. Perilaku dengan MySQL sungguhan diuji di tes kernel
(`KERNEL_TEST_DSN`) dan testbed.

---

## Skema kernel dan migrasinya

Kernel 6 adalah kernel **pertama yang memiliki tabel**: `kernel_tasks`, `kernel_schedules`,
`kernel_schedule_runs`.

- **Project baru:** scaffold menulis migrasi `<ts>_kernel_6.up.sql` / `.down.sql` setelah baseline.
- **Project lama:** langkah upgrade menyalin migrasi itu dengan timestamp baru
  (`check-migrations.mjs` menolak migrasi yang lebih tua dari `main`).
- Nama tabel berawalan `kernel_`; `rules.mjs` melarang modul mengklaim atau menyentuh tabel
  berawalan itu (`own-tables-only`).
- Prasyarat server: `binlog_format=ROW` (default MySQL 8) — `SKIP LOCKED` tidak aman untuk
  replikasi berbasis statement. Diperiksa sekali di server elcodelabs sebelum rilis.

## Perubahan di skill (monorepo-elcodelabs)

| Area | Perubahan |
|---|---|
| Template Go | `kernel/tx.go`, `tasks.go`, `events.go`, `calendar.go`, `clock.go`, `scope.go`, `http.go`, `kerneltest/`; perluasan `jobs.go`, `audit.go`, `authz.go`, `auth.go` (resolusi lingkup); `shared/request/stream.go`; `database.go` (`OpenWith`, klasifikasi 1213/1205); `config.go` (`APP_TIMEZONE`); `main.go` (tzdata, Deps baru, start/stop urut: HTTP → tasks/events → jobs, BaseContext) — semuanya dengan tes |
| Template web | `shared/scope.ts`, `http-client` (header `X-Scope`), `app-events` (`scope:changed`), konvensi slot `shell:scope`, `shared/kernel.ts` = 6 |
| Scaffold | Migrasi kernel 6, `APP_TIMEZONE` di `.env.example` dan contoh produksi, location nginx stream, `KERNEL_VERSION = 6` |
| Dokumen | `backend-go.md` (API, aturan, baris "6" di Kernel versions + langkah upgrade), `frontend.md` (lingkup), `backend-modular-monolith.md` (transaksi bersama, event, scoped), `docker-deployment.md` (nginx stream, `binlog_format`), `module-library.md` (Go kit, `scoped`, `emits`/`listens`) |
| Pengaman | `module-contract.json` diterima ulang untuk kernel 6; `check-drift` (versi di tiga tempat); smoke test tiga stack |
| Rilis | Commit → hook membuat tag `monorepo-elcodelabs/kernel/v6.0` |

## Perubahan di library (elcodelabs-modules)

| Area | Perubahan |
|---|---|
| Kernel terkunci | `kernel:sync` ke `kernel/v6.0` (commit tersendiri) |
| Go kit | Jenis modul `gokit`: folder `lib/` dipasang ke `apps/api/internal/shared/<id>`; field `go_kits` di `module.json`; aturan `declared-go-kits` (modul yang meng-import kit wajib mendeklarasikannya) dan `gokit-pure` (kit hanya meng-import stdlib, dependensi Go yang dideklarasikan, dan kit lain — tanpa tabel, tanpa wiring) |
| Manifest | `scoped`, `emits`, `listens`; installer menulis baris `d.Events.On` ke registry |
| Aturan baru | `scoped-tables` (tabel modul scoped punya `company_id`), `scoped-queries` (`company_id` di `WHERE` setiap SELECT/UPDATE/DELETE ke tabelnya, di daftar kolom INSERT; pengecualian `-- all companies` wajib bernama `System…`), `tx-aware` (`sqlc.New(…Conn(ctx))` di semua berkas, `BeginTx`, `d.DB`, dan SQL mentah di luar `d.Tx.Conn(ctx)` dilarang), `kernel-tables` (modul tidak boleh memiliki tabel `kernel_*`; `own-tables-only` menjauhkannya dari query), `events-declared` (`Publish` dengan nama literal yang ada di `emits`; `listens` merujuk event yang ada di library), nama Go kit tidak boleh sama dengan paket `shared/` kernel |
| Testbed | Fixture `testbed/fixtures/` dua modul kecil (mis. `orders` + `ledger`) untuk skenario `kernel6` (lihat Pengujian) |

## Upgrade modul yang sudah ada

| Modul | Versi | Perubahan |
|---|---|---|
| `users` | 0.6.0 | Repository lewat `d.Tx.Conn`; tidak scoped (pengguna lintas perusahaan; penempatan di modul `organization`) |
| `auth` | 0.6.0 | Repository lewat `d.Tx.Conn`; audit `security` untuk login gagal dan reset; tidak scoped |
| `rbac` | 0.5.0 | Keanggotaan peran per unit (`company_id`, `branch_id` 0 = seluruh perusahaan); implementasi `ScopedAuthorizer.Units` |
| `settings` | 0.2.0 | Scoped: pengaturan per perusahaan (kunci `company_id, name`); profil perusahaan per perusahaan |
| `files` | 0.2.0 | Scoped; hash SHA-256 dipakai untuk mengunci lampiran dokumen yang sudah diposting |
| `audit-log` | 0.2.0 | Sink menulis di dalam transaksi; kolom `kind`, `company_id`, `branch_id`; filter halaman Log aktivitas per jenis dan lingkup |
| `mailer` | 0.2.0 | Pengiriman lewat `d.Tasks` (`mailer.deliver`, dedupe per percobaan); tabel outbox tetap sebagai riwayat dan halaman Kotak keluar; pekerja buatan sendiri dihapus; job penyelamat tiap 10 menit untuk pesan tanpa pengiriman berjalan (sisa pekerja lama, atau tugas yang gagal permanen) |
| `app-shell` | 0.5.0 | Merender slot `shell:scope` di header |

Semua modul di atas: `requires_kernel: 6`. Modul kit UI tidak berubah.

## Pengujian

### Tes unit kernel (ikut ke setiap project)

| Area | Yang dibuktikan |
|---|---|
| `tx` | Bersarang ikut transaksi luar; hanya terluar yang commit; `AfterCommit` dibuang saat rollback dan retry; panic → rollback |
| `calendar` | Tick harian/mingguan/bulanan di zona lokal (termasuk 31 → akhir bulan, Februari); aturan DST dengan zona ber-DST |
| `scope` | Default perusahaan 1; resolver menolak lingkup asing (403); envelope memulihkan lingkup |
| `stream` | Deadline per tulis (10 dtk), heartbeat, berhenti saat shutdown |
| `audit` | `Kind` default `change`; lingkup tercatat |

### Testbed library, skenario baru `kernel6` (MySQL sungguhan)

| Pemeriksaan | Cara |
|---|---|
| Atomisitas lintas modul | `orders` memanggil port `ledger` di satu `d.Tx`; error di `ledger` → tidak ada baris di keduanya |
| Retry deadlock (1213) | Dua goroutine mengunci dua baris berlawanan urutan → keduanya akhirnya berhasil, tepat sekali |
| Lock wait timeout (1205) | `innodb_lock_wait_timeout=1` di sesi uji → transaksi di-rollback utuh lalu berhasil diulang |
| Tugas tahan crash | Enqueue di transaksi yang di-rollback → tidak ada tugas; proses dimatikan saat handler berjalan → reaper mengembalikan, efek database tetap tepat sekali |
| Dedupe | Enqueue ganda dengan kunci sama → satu tugas |
| Event durable | Pelanggan gagal 2× lalu berhasil; pelanggan lain tidak tertahan; penerbit tidak ter-rollback; proses crash setelah commit → event tetap terkirim |
| Jadwal | Dua API pada satu database → tiap tick sekali; API mati melewati tick → catch-up sekali saat start |
| Lingkup | Data perusahaan 2 tidak terlihat dari perusahaan 1; `X-Scope` ke cabang yang tidak ditempatkan → 403; query tanpa `company_id` di modul scoped ditolak `rules.mjs` |
| SSE | Stream hidup melewati 60 detik; berhenti saat SIGTERM tanpa menahan shutdown |
| Upgrade | Project kernel 5 + modul lama → salin kernel 6 + upgrade modul → build, migrasi, semua skenario lama tetap hijau |

### Gerbang lain

`check-drift` bersih, smoke test tiga stack (Go dengan MySQL), `npm run check` di library,
testbed lengkap, uji penerimaan clone bersih (repo modules tanpa skill), dan tinjauan independen
(keamanan + arsitektur) sebelum commit.

## Urutan pengerjaan

1. **Skill — kernel 6 Go:** tx → clock/config → tasks → events → calendar → scope/authz/auth →
   audit → stream → http/database → kerneltest. Tes unit tiap langkah.
2. **Skill — web, scaffold, dokumen, nginx;** terima kontrak, smoke test.
3. **Library — mekanisme:** Go kit, manifest (`scoped`, `emits`, `listens`), aturan baru, fixture
   dan skenario `kernel6`; uji dengan `testbed --skill` (kernel belum dirilis).
4. **Library — upgrade modul** sesuai tabel di atas.
5. **Verifikasi penuh + tinjauan independen.**
6. **Rilis:** commit skill (tag `kernel/v6.0`), `kernel:sync` (commit tersendiri), commit library;
   push setelah disetujui.

## Yang harus diverifikasi sebelum dikunci

| Hal | Cara |
|---|---|
| Rollback hanya-statement pada 1205 (`innodb_rollback_on_timeout=OFF`) | Tes 1205 di testbed |
| Field error driver (`*mysql.MySQLError.Number`) | Tes unit klasifikasi |
| `binlog_format` di server elcodelabs | Perintah baca saja di server, dengan izin |
| Versi nginx di VPS (default `proxy_http_version`) | Diperiksa bersamaan |
| Generated column + unique untuk dedupe di MySQL 8 | Migrasi di testbed |

## Penyesuaian saat dibangun

| Rancangan | Yang dibangun | Alasan |
|---|---|---|
| `kerneltest.NewClock/NewTasks/NewEvents/NoTx` terpisah | `kerneltest.Deps(t)` → `Kit{Deps, Clock, Audit}` dengan `RunTasks()`, `Enqueued()`, `Published()`, `In(ctx, company, branch)`; slot kernel tanpa database menyimpan tugas dan event di memori | Satu pintu, slot asli (bukan tiruan) — perilaku sama dengan produksi kecuali penyimpanan |
| `kernel.Deps` dirakit di `main.go` | `kernel.NewDeps(cfg, db, lockPrefix, log, clock)` | `main.go` dan `kerneltest` memakai perakitan yang sama |
| Stream berhenti lewat `BaseContext` | Kanal shutdown lewat middleware (`request.WithShutdown`) | Membatalkan `BaseContext` ikut membatalkan request biasa yang sedang di-drain |
| `rbac` scoped | `rbac` tidak scoped: peran didefinisikan sekali untuk aplikasi; **keanggotaan** per perusahaan/cabang (`user_roles.company_id`, `branch_id`, 0 = seluruh perusahaan) | Definisi peran berlaku lintas perusahaan; yang berlingkup adalah siapa memegangnya di mana |
| `mailer` memakai `d.Tasks` | Satu tugas per percobaan (`mailer.deliver`, `NonTransactional`), percobaan berikutnya di-enqueue dengan `At` — jadwal 1m/5m/30m/2j/6j tetap | Backoff kernel (30 dtk berlipat dua) lebih pendek dari kebijakan mailer |
| — | `ui-core` 0.4.0: `useResource` memuat ulang saat `scope:changed` | Satu tempat; tidak ada halaman yang menampilkan data perusahaan lain setelah berganti lingkup |
| — | Penanda `-- all companies` untuk query sistem lintas perusahaan (purge) di modul scoped | Pengecualian eksplisit dan terlihat saat review, bukan celah diam-diam |
| — | Modul boleh meng-import `internal/kernel/kerneltest` di tesnya | Bagian dari kernel |
| `d.Tx` cukup mengulang saat 1213/1205 | Kait "fatal": setelah deadlock atau koneksi putus, statement berikutnya di transaksi itu ditolak dan `Do` gagal walau kodenya menelan error | MySQL menjalankan statement berikutnya dalam autocommit — perubahan setengah jadi bisa tercommit diam-diam |
| Catch-up jadwal untuk tick terakhir dalam jendela | Catch-up hanya untuk tick setelah job pertama kali terdaftar (`kernel_schedules.created_at`); tick yang terpotong shutdown dijalankan lagi saat start; tick yang ditinggal container mati diambil alih setelah timeout-nya | Job baru tidak menjalankan tick pagi tadi; tidak ada tick yang hilang karena deploy |
| Lingkup default selalu perusahaan 1 | `kernel.HasScope(ctx)`; envelope tugas tanpa lingkup bila di-enqueue tanpa lingkup; dengan resolver (beberapa perusahaan) `ScopeFrom` tanpa lingkup **panic**; audit tanpa lingkup = catatan sistem (perusahaan 0) | Data tidak pernah diam-diam masuk perusahaan 1 |
| Kait fatal di `txConn` | Kait di lapisan driver (`database.Watcher` lewat `database.WithWatcher`): galat dari Exec, `Scan` QueryRow, pembacaan baris, dan statement siap pakai semuanya terlihat | Deadlock paling sering muncul di `SELECT … FOR UPDATE` lewat QueryRow — tinjauan kedua |
| Dedupe untuk tugas `ready`/`running` | Dedupe hanya untuk tugas yang **menunggu**; tugas yang di-enqueue saat kembarannya berjalan mengantre di belakangnya; retry yang bertabrakan ditutup sebagai *superseded* | Tidak ada perubahan yang hilang untuk pekerjaan "hitung ulang dari keadaan terkini" |
| Shutdown berurutan | Request, tugas, dan job berhenti bersamaan dalam 25 detik; handler yang mengabaikan ctx ditinggal setelah 3 detik; jadwal kalender memeriksa ulang tiap menit | Tick yang terpotong atau ditinggal container mati tidak hilang |
| `rbac` per unit | Di tingkat perusahaan hanya peran seluruh-perusahaan yang berlaku; mengelola anggota butuh `rbac.manage` di unit itu; mengubah/menghapus peran butuh hak seluruh-perusahaan di setiap perusahaan tempat peran punya anggota; `Covers` melihat semua perusahaan; Administrator aktif terakhir dijaga dengan kunci baris | Hasil tinjauan keamanan: peran didefinisikan sekali untuk aplikasi, akun berlaku lintas perusahaan |

## Sengaja tidak dimasukkan

| Tidak | Alasan | Pengganti |
|---|---|---|
| Engine workflow/saga | Hanya perlu bila modul terisolasi sampai ke database (Medusa) | `d.Tx` + tugas idempoten |
| Redis / broker | Rails 8 menjalankan antrean di SQL dalam skala besar | `d.Tasks`, `d.Events` di MySQL |
| Listener sinkron dalam transaksi | Memperluas batas transaksi (Spring Modulith) | Port di dalam `d.Tx` |
| Savepoint default | Rollback parsial lintas modul membingungkan | Ikut transaksi luar |
| API lock generik | ABP sendiri menyebutnya terbatas | `FOR UPDATE` di `d.Tx` |
| Filter SQL otomatis | Jebakan ABP dan Odoo (default filter, global rule) | Predikat eksplisit + `rules.mjs` |
| Settings/feature flag di kernel | Modul `settings` sudah ada | Upgrade modul `settings` |
| Mesin status dokumen, penomoran, period lock | Butuh tabel sendiri | Kit `docstate`, modul `numbering`/`period` |
| Cache bersama | State milik modul | Cache per modul, invalidasi di `AfterCommit` |
| Event "waktu berlalu" (Moments) | Jadwal kalender sudah cukup | Pemicu: ≥3 modul memakai jadwal akhir bulan yang sama |

## Batasan yang diketahui sampai modul `organization` ada

Modul yang sengaja tidak scoped melihat lintas perusahaan. Dalam aplikasi satu perusahaan ini
tidak terlihat; begitu perusahaan kedua ada (pemicu: modul `organization` dipasang), perlu
diputuskan per modul:

| Modul | Batasan | Arah saat `organization` dibangun |
|---|---|---|
| `users` | Daftar pengguna menampilkan semua pengguna, dari perusahaan mana pun | Daftar disaring lewat penempatan (port `Placements` dari `organization`) |
| `mailer` | Kotak keluar menampilkan email semua perusahaan | Kolom `company_id` dari lingkup pengirim, atau izin khusus admin sistem |
| `auth` | Audit `security` dari rute publik (login gagal, reset) tercatat di perusahaan 1 | Resolver memutuskan lingkup rute publik (mis. dari subdomain), atau audit keamanan dianggap milik sistem |
| `rbac` | Administrator pertama perusahaan selain perusahaan 1 tidak bisa diangkat lewat API (hanya perusahaan 1 yang di-bootstrap) | `organization` mengangkatnya saat membuat perusahaan (kontrak rbac baru) |
| `rbac` + `users` | Akun tanpa peran bisa ditindak (reset sandi, nonaktif) oleh pemegang peran seluruh-perusahaan di perusahaan **mana pun** — rbac belum tahu di mana akun itu ditempatkan | Permintaan kernel: `ScopeResolver.PlacementsOf(user)`, lalu `Covers` mensyaratkan hak di perusahaan tempat akun ditempatkan |
| `rbac` + `users` | Dua administrator yang saling menonaktifkan bersamaan bisa menyisakan nol administrator aktif (penjaga terakhir hanya mengunci saat peran dicabut) | Bootstrap memulihkannya saat start bila `RBAC_BOOTSTRAP_ADMIN_EMAIL` diisi; port pengecekan di `users` bila jadi masalah |
| `rbac` | Pemegang `rbac.manage` di satu cabang bisa melihat daftar seluruh pengguna aplikasi (nama, email) saat mencari anggota | Pencarian disaring lewat penempatan dari `organization` |

## Belum (sengaja), dengan pemicu

- Go kit `money`, `fieldcrypt`, `docstate`, `httpx`, `dbx` — dibangun bersama modul pertama yang
  memakainya (mekanisme kit sudah ada di kernel 6/library).
- Modul `organization`, `numbering`, `period`, `approvals`, `timeline`, `realtime`, `ops` —
  bersama aplikasi pertama yang membutuhkannya.
- Idempotency-Key HTTP, modul `privacy` (UU PDP), `retention`, metrik/OTel, feature flag, OpenAPI —
  pemicu tercatat di laporan riset.

## Bukti

Diverifikasi 26 Oktober 2026 pada salinan kerja (belum di-commit), MySQL 8.0 lokal, Go 1.25:

| Gerbang | Hasil |
|---|---|
| Tes unit + MySQL kernel (`go test -race -count=2 ./...`, `KERNEL_TEST_DSN`) | Lulus — termasuk deadlock yang ditelan lewat `Scan` QueryRow (terbukti gagal tanpa watcher driver), 1205 rollback utuh, reclaim ke `failed`, rilis saat shutdown, dedupe di belakang tugas berjalan, *superseded*, catch-up hanya setelah job terdaftar, takeover tick yang ditinggal, mengalah pada takeover saat menunggu slot, scope tanpa default bila ada resolver |
| `check-drift.mjs` | Bersih; kontrak modul diterima untuk kernel 6 (42 berkas) |
| Smoke test tiga stack (Go dengan MySQL) | Lulus |
| `catalog.mjs --check` library | Lulus (13 modul) |
| Testbed library lengkap (6 skenario, `TESTBED_DB_DSN`) | 233 pemeriksaan lulus, 0 gagal — termasuk 23 mutasi yang harus ditolak aturan dan 1 yang harus diterima |
| Tinjauan independen | 4 putaran (kernel + library). Temuan tiap putaran diperbaiki dan diverifikasi di putaran berikutnya; putaran terakhir menyatakan semua perbaikan benar. Sisa yang diterima sadar: batasan di "Batasan yang diketahui", dan aturan statis membaca kode "yang ditulis wajar" (mis. `OR` di samping filter perusahaan) — sisanya tugas review |
