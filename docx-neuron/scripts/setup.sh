#!/usr/bin/env bash
# Pemasang satu-perintah untuk docx-neuron (macOS).
#   bash setup.sh          -> memastikan Node.js (satu-satunya prasyarat wajib)
#   bash setup.sh --full   -> juga LibreOffice + Poppler (pratinjau visual), pandoc + Python defusedxml/lxml (edit dokumen)
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
HERE="$(cd "$(dirname "$0")" && pwd)"
FULL=0; [ "$1" = "--full" ] && FULL=1

node_ok() { command -v node >/dev/null && [ "$(node -p "process.versions.node.split('.')[0]")" -ge 18 ]; }

if node_ok; then echo "Node.js sudah ada: $(node -v)"
else
  if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null; then
    echo "Memasang Node.js lewat Homebrew..."; brew install node
  else
    echo "Node.js belum terpasang dan Homebrew tidak ditemukan."
    echo "Pasang Node.js LTS (klik-klik biasa) dari: https://nodejs.org  lalu jalankan skrip ini lagi."
    echo "Windows: winget install OpenJS.NodeJS.LTS"
    exit 1
  fi
fi

if [ $FULL -eq 1 ]; then
  if command -v brew >/dev/null; then
    command -v soffice  >/dev/null || brew install --cask libreoffice
    command -v pdftoppm >/dev/null || brew install poppler
    command -v pandoc   >/dev/null || brew install pandoc
    command -v python3  >/dev/null || brew install python
  else
    echo "Homebrew tidak ditemukan; LibreOffice, Poppler, dan pandoc dilewati (opsional)."
  fi
  # Modul Python untuk alat edit (merge_runs.py, comment.py, office/validate.py), dipasang di folder pengguna.
  if command -v python3 >/dev/null && ! python3 -c "import defusedxml, lxml" >/dev/null 2>&1; then
    echo "Memasang modul Python defusedxml dan lxml (folder pengguna)..."
    python3 -m pip install --user -q defusedxml lxml 2>/dev/null \
      || python3 -m pip install --user --break-system-packages -q defusedxml lxml
  fi
fi

echo; bash "$HERE/check_prereqs.sh"
