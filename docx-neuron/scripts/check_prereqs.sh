#!/usr/bin/env bash
# Cek prasyarat docx-neuron. Yang WAJIB hanya Node.js 18+ (pustaka docx sudah dibundel di skill).
# LibreOffice dan Poppler bersifat opsional: hanya untuk pratinjau/verifikasi visual.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"   # PATH pengguna (nvm) didahulukan
HERE="$(cd "$(dirname "$0")" && pwd)"
miss=0
ok()  { printf "  [OK]       %-20s %s\n" "$1" "$2"; }
bad() { printf "  [HILANG]   %-20s %s\n" "$1" "$2"; miss=1; }
opt() { printf "  [opsional] %-20s %s\n" "$1" "$2"; }

echo "WAJIB"
if command -v node >/dev/null; then
  major=$(node -p "process.versions.node.split('.')[0]")
  if [ "$major" -ge 18 ]; then ok "Node.js" "$(node -v)"; else bad "Node.js" "versi $(node -v) terlalu lama; butuh 18+ (jalankan: bash scripts/setup.sh)"; fi
else bad "Node.js" "belum terpasang (jalankan: bash scripts/setup.sh)"; fi
if command -v node >/dev/null && node -e "require('$HERE/vendor/docx.bundle.cjs')" >/dev/null 2>&1; then ok "pustaka docx" "bawaan skill (tanpa npm)"; else bad "pustaka docx" "scripts/vendor/docx.bundle.cjs hilang atau rusak; salin ulang folder skill lengkap"; fi
[ -f "$HERE/../assets/logo_neuron.png" ] && ok "logo Neuron" "assets/logo_neuron.png" || bad "logo Neuron" "assets/logo_neuron.png hilang; salin ulang folder skill lengkap"

echo; echo "OPSIONAL: edit/baca dokumen yang sudah ada (merge_runs, comment, validate, pandoc)"
if command -v python3 >/dev/null; then
  ok "Python 3" "$(python3 --version 2>&1)"
  for m in defusedxml lxml; do
    python3 -c "import $m" >/dev/null 2>&1 && ok "python: $m" "terpasang" || opt "python: $m" "belum ada -> bash scripts/setup.sh --full"
  done
else opt "Python 3" "belum ada -> bash scripts/setup.sh --full"; fi
command -v pandoc >/dev/null && ok "pandoc" "$(pandoc --version | head -1)" || opt "pandoc" "belum ada -> bash scripts/setup.sh --full"

echo; echo "OPSIONAL: pratinjau visual"
command -v soffice  >/dev/null && ok "LibreOffice" "$(soffice --version 2>/dev/null | head -1 | cut -c1-40)" || opt "LibreOffice" "belum ada -> bash scripts/setup.sh --full"
command -v pdftoppm >/dev/null && ok "Poppler" "$(pdftoppm -v 2>&1 | head -1)" || opt "Poppler" "belum ada -> bash scripts/setup.sh --full"

echo
if [ $miss -eq 0 ]; then echo "Siap dipakai: dokumen Neuron bisa dibuat."; else echo "Belum siap: perbaiki item WAJIB di atas."; fi
exit $miss
