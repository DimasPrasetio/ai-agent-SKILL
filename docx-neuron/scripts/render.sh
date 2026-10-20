#!/usr/bin/env bash
# Pratinjau visual dokumen: .docx -> PDF -> JPEG per halaman.
#   bash scripts/render.sh dokumen.docx [folder-keluaran] [dpi]
# Hasil: <folder>/dokumen.pdf dan <folder>/page-1.jpg, page-2.jpg, ... (dicetak di akhir).
# Butuh LibreOffice dan Poppler (bash scripts/setup.sh --full).
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
HERE="$(cd "$(dirname "$0")" && pwd)"
IN="$1"; OUT="${2:-$(dirname "$IN")/render}"; DPI="${3:-80}"
[ -f "$IN" ] || { echo "Pemakaian: bash render.sh dokumen.docx [folder] [dpi]"; exit 1; }
command -v soffice  >/dev/null || { echo "LibreOffice belum ada: tampilan tidak bisa diperiksa (bash scripts/setup.sh --full)."; exit 2; }
command -v pdftoppm >/dev/null || { echo "Poppler belum ada: tampilan tidak bisa diperiksa (bash scripts/setup.sh --full)."; exit 2; }
mkdir -p "$OUT"; rm -f "$OUT"/page-*.jpg
python3 "$HERE/office/soffice.py" --headless --convert-to pdf --outdir "$OUT" "$IN" >/dev/null 2>&1
PDF="$OUT/$(basename "${IN%.*}").pdf"
[ -f "$PDF" ] || { echo "Konversi ke PDF gagal."; exit 3; }
pdftoppm -jpeg -r "$DPI" "$PDF" "$OUT/page"
echo "PDF: $PDF"; ls -1 "$OUT"/page-*.jpg
