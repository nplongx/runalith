#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "$0")"

write_bundle_checksums() {
  python3 - <<'PY'
from pathlib import Path
import hashlib
root = Path('.')
excluded = {'SHA256SUMS.txt'}
files = sorted(p for p in root.iterdir() if p.is_file() and p.name not in excluded)
(root / 'SHA256SUMS.txt').write_text(
    ''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in files),
    encoding='utf-8',
)
PY
}

python3 generate_agg_charts.py
write_bundle_checksums

if command -v latexmk >/dev/null 2>&1; then
  latexmk -xelatex -interaction=nonstopmode -halt-on-error agg_adaptive_goal_graph_research_paper_vi.tex
elif command -v xelatex >/dev/null 2>&1 && command -v biber >/dev/null 2>&1; then
  xelatex -interaction=nonstopmode -halt-on-error agg_adaptive_goal_graph_research_paper_vi.tex
  biber agg_adaptive_goal_graph_research_paper_vi
  xelatex -interaction=nonstopmode -halt-on-error agg_adaptive_goal_graph_research_paper_vi.tex
  xelatex -interaction=nonstopmode -halt-on-error agg_adaptive_goal_graph_research_paper_vi.tex
else
  echo "Charts and source checksums generated. PDF not rebuilt: install XeLaTeX and Biber, or latexmk with these dependencies." >&2
  exit 2
fi

sha256sum agg_adaptive_goal_graph_research_paper_vi.pdf \
  agg_adaptive_goal_graph_research_paper_vi.tex \
  agg_adaptive_goal_graph_references.bib \
  > agg_adaptive_goal_graph_research_paper_vi.sha256
write_bundle_checksums
