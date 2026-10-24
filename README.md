# ai-agent-SKILL

Kumpulan skill untuk Claude (Claude Code / Claude desktop).

| Skill | Fungsi |
|---|---|
| [docx-neuron](docx-neuron/) | Membuat, membaca, dan mengedit dokumen Word (.docx) dengan template desain Neuron |
| [monorepo-elcodelabs](monorepo-elcodelabs/) | Scaffold/audit monorepo standar Dimas (React 19 + Go/NestJS/Express) yang siap deploy ke VPS elcodelabs |

## Instalasi

```bash
git clone https://github.com/DimasPrasetio/ai-agent-SKILL.git ~/Documents/SKILL
bash ~/Documents/SKILL/docx-neuron/scripts/sync.sh      # salin ke ~/.claude/skills/docx-neuron
bash ~/Documents/SKILL/docx-neuron/scripts/setup.sh     # pasang prasyarat (tambah --full untuk pratinjau & alat edit)
```

`monorepo-elcodelabs` dipasang dari paket bawaannya:

```bash
bash ~/Documents/SKILL/monorepo-elcodelabs/install.sh     # ke ~/.claude/skills/monorepo-elcodelabs
```

Detail tiap skill ada di README di foldernya.

## Mengubah skill

Aktifkan hook pre-commit sekali setelah clone — hook ini menolak commit yang membuat
`monorepo-elcodelabs` tidak selaras dengan referensinya, kontrak modulnya, atau paketnya:

```bash
git config core.hooksPath .githooks
```

Aturan mengubah `monorepo-elcodelabs` ada di [monorepo-elcodelabs/AGENTS.md](monorepo-elcodelabs/AGENTS.md).
