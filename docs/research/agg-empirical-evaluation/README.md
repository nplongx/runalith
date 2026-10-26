# AGG empirical evaluation (internal research artifact)

This directory contains the LaTeX source, bibliography, disclosed metric summaries, source-provenance manifest, and scripts for regenerating the six AGG figures used in the manuscript. It is a self-contained research source directory; the compiled PDF is a build output and is not checked in by this patch because this repository workstation does not currently provision XeLaTeX/Biber.

## Main research question and conclusion

**Question:** Do the AGG development phases show measurable benefits over their stated baselines, and what evidence is still missing?

The strongest measured benefit is a Phase 1 beam-width ablation on a frozen synthetic graph catalog: task-outcome correctness rises from 40% for AGG Beam width 1 to 100% for width 4 (+60 percentage points). The measured mean expansion count rises by about 70.6% and mean runtime rises by about 46.8%. Width 4 matches rather than exceeds the deterministic tree-search baseline's 100% observed correctness in this fixture. In the five-case Phase 2 paired search test, both methods succeed on all cases, so no success-rate lift is observed. The Phase 2 discriminator scores 40/40 on a synthetic holdout, but the labels have not been independently adjudicated. On Phase 3 goal-path tasks, Beam and MCTS both succeed on 100/100 paired trials; MCTS uses more expansions and observed runtime, and it is not an exhaustive no-solution prover. Phase 4 records one cross-goal node membership, but it is unverified and unavailable for planning; no downstream savings have been measured.

The evidence does **not** show that the full AGG roadmap improves real operational workflows. No prospective operational A/B study is present. The current release/readiness boundary remains separate from offline benchmark results.

## Files

- `agg_adaptive_goal_graph_research_paper_vi.tex`: manuscript source (Vietnamese; includes an English abstract).
- `agg_adaptive_goal_graph_references.bib`: references used by the manuscript.
- `agg_empirical_data_manifest.json`: primary artifact paths, SHA-256 values, verification level, exclusions, and limitations.
- `agg_phase1_algorithm_summary.csv`: Phase 1 aggregate algorithm metrics (700 raw trials are in the primary artifact, not synthesized here).
- `agg_phase2_holdout_metrics.csv` and `agg_phase2_holdout_calibration.csv`: aggregate holdout metrics and occupied reliability bins.
- `agg_phase2_paired_five_cases.csv`: the five paired Phase 2 search cases and observed runtimes.
- `agg_phase3_summary.csv`: Phase 3 summary separating goal-path discovery from exhaustive no-solution proof.
- `agg_phase4_reuse_status.csv`: observed goal-graph and knowledge-reuse counts.
- `agg_local_llm_pilot_exploratory_NOT_PRIMARY.csv`: historical pilot retained for transparency, excluded from primary inference due to a current-source hash mismatch and non-comparable conditions.
- `generate_agg_charts.py`: chart generator based on the CSV files in this directory; no trial rows are invented and no results from external papers are plotted.
- `fig1_...` through `fig6_...` (`.pdf` and `.png`): generated figures referenced by the manuscript.
- `SHA256SUMS.txt`: checksum inventory for the source and generated chart files. The PDF/source/BibLaTeX checksum file is created by `build-research.sh` when PDF compilation succeeds.

## Rebuild

Regenerate charts and validate Python syntax:

```sh
python3 -m py_compile generate_agg_charts.py
python3 generate_agg_charts.py
```

To compile the PDF, install XeLaTeX, Biber (or `latexmk` with its dependencies), and matplotlib, then run:

```sh
./build-research.sh
```

## Provenance and evidence limits

- **Phase 1:** `artifacts/agg-phase1-hardening-20261023T152010Z-verified-final-preserved-candidate/phase1-algorithm-raw.json`; SHA-256 `5fa2ce1d2927fe5ea34af6f275fa8535172c0797f9abd177159940e58c03f27c`. The ledger verifier returned `PASS_INTEGRITY_ONLY_NOT_ACCEPTANCE`, with 28 task templates, seven synthetic task-family clusters, 140 graph instances, and 700 method records. That verifies internal ledger/source consistency, not production effectiveness or independent truth of labels.
- **Phase 2 discriminator:** `artifacts/agg-phase2-workflow-20261024T102000Z-source-callpath-trust-anchor-hardening-successor/holdout-evaluation.json`; SHA-256 `67460827fd8b8b1dd6e329aca4c61ae092b4135f76b3c88966769ed3911184af`. The stored verifier reports holdout re-derivation passed; the corpus and labels remain synthetic and un-attested.
- **Phase 2 paired search:** `artifacts/agg-phase2-workflow-20261024T102000Z-source-callpath-trust-anchor-hardening-successor/paired-benchmark.json`; SHA-256 `a753fd1caf32f38a7436ac0928cea1f6002919b5c9a3a5439e099e295e70dd80`. Five pairs are insufficient to demonstrate a stable runtime improvement.
- **Phase 3:** `artifacts/agg-phase3-mcts-shadow-evidence-20261024T194000+0700-successor3/runs/phase3-paired-benchmark.json`; SHA-256 `f0a4e4a8707565ef625950636fe613a3e54af4522779a450e053cca9f21b723c`. Synthetic replay only; the corpus is imbalanced toward goal-path cases, and MCTS is non-exhaustive.
- **Phase 4:** the Phase 1 raw ledger records 28 goal graphs and one cross-goal reused node with `verified=false` and `usableForPlanning=false`. Membership does not establish saved time/cost.
- The historical local-LLM pilot is excluded from primary quantitative claims because its stored graph-runtime source identity does not match the current source tree; additionally, it mixes a one-shot prompted model method with deterministic search over a supplied graph.

SHA-256 integrity checks do not prove that benchmark labels are true, that an owner or independent evaluator approved the evidence, or that the software is production-ready. The manuscript therefore keeps the operational boundary explicit: `PARTIAL_NOT_ACCEPTED`, readiness `BLOCKED`, execution gate `CLOSED`.
