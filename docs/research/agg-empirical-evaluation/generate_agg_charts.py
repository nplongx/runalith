#!/usr/bin/env python3
"""Rebuild the six AGG research figures from the bundled CSV data.

The script deliberately plots only observations summarized from project artifacts.
It does not generate synthetic trial rows or combine external-paper results with
AGG measurements. Run from any directory; outputs are written beside this file.
"""

from __future__ import annotations

import csv
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np


HERE = Path(__file__).resolve().parent


def read_csv(name: str) -> list[dict[str, str]]:
    with (HERE / name).open("r", encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def number(row: dict[str, str], key: str) -> float:
    value = row.get(key, "")
    if value in ("", None):
        raise ValueError(f"Missing numeric field {key!r} in row {row!r}")
    return float(value)


def save(fig: plt.Figure, stem: str) -> None:
    fig.savefig(HERE / f"{stem}.pdf", bbox_inches="tight")
    fig.savefig(HERE / f"{stem}.png", dpi=190, bbox_inches="tight")
    plt.close(fig)


def phase1_accuracy() -> None:
    rows = read_csv("agg_phase1_algorithm_summary.csv")
    expected = {"AGG Beam width 1", "AGG Beam width 2", "AGG Beam width 4",
                "Tree-search baseline", "Linear baseline"}
    if {r["method"] for r in rows} != expected:
        raise ValueError("Unexpected Phase 1 methods in summary CSV")
    rows.sort(key=lambda r: [
        "AGG Beam width 1", "AGG Beam width 2", "AGG Beam width 4",
        "Tree-search baseline", "Linear baseline",
    ].index(r["method"]))

    labels = [r["method"] for r in rows]
    accuracy = [number(r, "accuracy_pct") for r in rows]
    correct = [int(number(r, "correct_outcomes")) for r in rows]
    totals = [int(number(r, "runs")) for r in rows]
    y = np.arange(len(rows))

    fig, ax = plt.subplots(figsize=(9.2, 4.8))
    bars = ax.barh(y, accuracy)
    ax.set_yticks(y, labels)
    ax.invert_yaxis()
    ax.set_xlim(0, 112)
    ax.set_xlabel("Task-outcome đúng (%)")
    ax.set_title("Phase 1 — độ đúng trên benchmark đồ thị tổng hợp")
    ax.grid(axis="x", alpha=0.25)
    ax.set_axisbelow(True)
    for bar, pct, n, total in zip(bars, accuracy, correct, totals):
        ax.text(min(pct + 1.4, 101.5), bar.get_y() + bar.get_height() / 2,
                f"{pct:.1f}% ({n}/{total})", va="center", fontsize=9)
    fig.text(0.01, -0.015, "n = 140 lượt/phương pháp; 28 template, 7 cụm family, 5 seed.",
             ha="left", fontsize=8)
    fig.tight_layout()
    save(fig, "fig1_phase1_outcome_accuracy")


def phase1_cost() -> None:
    rows = read_csv("agg_phase1_algorithm_summary.csv")
    labels = [r["method"] for r in rows]
    expansions = [number(r, "mean_expansions") for r in rows]
    runtimes = [number(r, "mean_runtime_ms") for r in rows]
    y = np.arange(len(rows))

    fig, (left, right) = plt.subplots(1, 2, figsize=(11, 4.9))
    a = left.barh(y, expansions)
    left.set_yticks(y, labels)
    left.invert_yaxis()
    left.set_xlabel("Số successor-edge examinations trung bình")
    left.set_title("Số lần mở rộng")
    left.grid(axis="x", alpha=0.25)
    left.set_axisbelow(True)
    for bar, val in zip(a, expansions):
        left.text(val + 0.35, bar.get_y() + bar.get_height() / 2,
                  f"{val:.2f}", va="center", fontsize=8)

    b = right.barh(y, runtimes)
    right.set_yticks(y, labels)
    right.invert_yaxis()
    right.set_xlabel("Thời gian đồng bộ trung bình (ms)")
    right.set_title("Thời gian quan sát")
    right.grid(axis="x", alpha=0.25)
    right.set_axisbelow(True)
    for bar, val in zip(b, runtimes):
        right.text(val + max(runtimes) * 0.012, bar.get_y() + bar.get_height() / 2,
                   f"{val:.3f}", va="center", fontsize=8)
    fig.suptitle("Phase 1 — đánh đổi giữa kết quả và chi phí tìm kiếm", y=1.02)
    fig.text(
        0.01, -0.03,
        "Lưu ý: bộ đếm expansion không phải tổng compute; tree search có tiền xử lý riêng "
        "(trung bình 48.14 edge visits), đo riêng và không trừ vào cap 80.",
        ha="left", fontsize=8, wrap=True,
    )
    fig.tight_layout()
    save(fig, "fig2_phase1_cost_tradeoff")


def phase2_reliability() -> None:
    rows = read_csv("agg_phase2_holdout_calibration.csv")
    metrics = read_csv("agg_phase2_holdout_metrics.csv")
    if len(metrics) != 1:
        raise ValueError("Expected one aggregate Phase 2 holdout metrics row")
    n = int(number(metrics[0], "n"))
    if sum(int(number(r, "count")) for r in rows) != n:
        raise ValueError("Calibration bin counts do not sum to holdout size")

    x = [number(r, "mean_predicted_probability") for r in rows]
    y = [number(r, "observed_positive_rate") for r in rows]
    counts = [int(number(r, "count")) for r in rows]
    fig, ax = plt.subplots(figsize=(6.5, 5.3))
    ax.plot([0, 1], [0, 1], linestyle="--", label="Hiệu chuẩn lý tưởng")
    ax.scatter(x, y, s=[70 + 10 * c for c in counts], zorder=3, label="Bin quan sát")
    for xx, yy, c in zip(x, y, counts):
        ax.annotate(f"n={c}", (xx, yy), xytext=(7, 7), textcoords="offset points", fontsize=9)
    ax.set_xlim(-0.04, 1.04)
    ax.set_ylim(-0.04, 1.04)
    ax.set_xlabel("Xác suất positive trung bình dự đoán")
    ax.set_ylabel("Tỷ lệ positive quan sát")
    ax.set_title("Phase 2 — reliability trên holdout tổng hợp (n=40)")
    ax.grid(alpha=0.25)
    ax.legend(loc="upper left")
    fig.text(0.01, -0.02,
             "Chỉ có 2 bin được lấp đầy; 20 mẫu mỗi bin. Nhãn synthetic, chưa adjudicate độc lập.",
             ha="left", fontsize=8)
    fig.tight_layout()
    save(fig, "fig3_phase2_reliability")


def phase2_paired_latency() -> None:
    rows = read_csv("agg_phase2_paired_five_cases.csv")
    if len(rows) != 5:
        raise ValueError("Paired Phase 2 data must contain exactly five cases")
    x = np.arange(len(rows))
    width = 0.36
    base = [number(r, "baseline_runtime_ms") for r in rows]
    phase2 = [number(r, "phase2_runtime_ms") for r in rows]

    fig, ax = plt.subplots(figsize=(8.4, 4.8))
    a = ax.bar(x - width / 2, base, width, label="Baseline")
    b = ax.bar(x + width / 2, phase2, width, label="Phase 2")
    ax.set_xticks(x, [r["case_id"].replace("synthetic-case-", "Ca ") for r in rows])
    ax.set_ylabel("Thời gian quan sát (ms)")
    ax.set_title("Phase 2 — latency từng ca trong benchmark ghép cặp")
    ax.legend()
    ax.grid(axis="y", alpha=0.25)
    ax.set_axisbelow(True)
    for bars in (a, b):
        for bar in bars:
            ax.annotate(f"{bar.get_height():.3f}",
                        (bar.get_x() + bar.get_width() / 2, bar.get_height()),
                        xytext=(0, 3), textcoords="offset points",
                        ha="center", fontsize=8)
    fig.text(0.01, -0.02,
             "Cả hai phương pháp đúng 5/5; mỗi case đo một lần. Không suy ra speed-up ổn định từ n=5.",
             ha="left", fontsize=8)
    fig.tight_layout()
    save(fig, "fig4_phase2_paired_latency")


def phase3_beam_mcts() -> None:
    rows = read_csv("agg_phase3_summary.csv")
    if len(rows) != 1:
        raise ValueError("Expected one Phase 3 summary row")
    r = rows[0]
    labels = ["Tìm đường đích", "Chứng minh vô nghiệm"]
    beam_success = [number(r, "goal_path_beam_success_pct"),
                    number(r, "no_solution_beam_exhaustive_proof_pct")]
    mcts_success = [number(r, "goal_path_mcts_success_pct"),
                    number(r, "no_solution_mcts_exhaustive_proof_pct")]

    fig, (left, middle, right) = plt.subplots(1, 3, figsize=(12, 4.5),
                                               gridspec_kw={"width_ratios": [1.1, 1, 1]})
    x = np.arange(2)
    w = 0.35
    bars1 = left.bar(x - w / 2, beam_success, w, label="Beam")
    bars2 = left.bar(x + w / 2, mcts_success, w, label="MCTS")
    left.set_xticks(x, labels, rotation=12, ha="right")
    left.set_ylim(0, 115)
    left.set_ylabel("Tỷ lệ đúng / proof (%)")
    left.set_title("Outcome, theo loại ca")
    left.legend(fontsize=8)
    left.grid(axis="y", alpha=0.25)
    left.set_axisbelow(True)
    for bars, ns in [(bars1, [100, 20]), (bars2, [100, 20])]:
        for bar, n in zip(bars, ns):
            val = bar.get_height()
            left.text(bar.get_x() + bar.get_width() / 2, val + 2,
                      f"{val:.0f}%\n(n={n})", ha="center", va="bottom", fontsize=7)

    expansions = [number(r, "goal_path_mean_beam_expansions"),
                  number(r, "goal_path_mean_mcts_expansions")]
    exbars = middle.bar(["Beam", "MCTS"], expansions)
    middle.set_title("Mở rộng trên ca có lời giải")
    middle.set_ylabel("Cạnh được mở rộng trung bình")
    middle.grid(axis="y", alpha=0.25)
    middle.set_axisbelow(True)
    for bar, val in zip(exbars, expansions):
        middle.text(bar.get_x() + bar.get_width() / 2, val + 0.2, f"{val:.0f}",
                    ha="center", fontsize=9)

    runtime = [number(r, "goal_path_mean_beam_runtime_ms"),
               number(r, "goal_path_mean_mcts_runtime_ms")]
    rt_bars = right.bar(["Beam", "MCTS"], runtime)
    right.set_title("Latency trên ca có lời giải")
    right.set_ylabel("Thời gian trung bình (ms)")
    right.grid(axis="y", alpha=0.25)
    right.set_axisbelow(True)
    for bar, val in zip(rt_bars, runtime):
        right.text(bar.get_x() + bar.get_width() / 2, val + 0.012,
                   f"{val:.3f}", ha="center", fontsize=9)
    fig.suptitle("Phase 3 — tách tìm đường khỏi chứng minh không có lời giải", y=1.03)
    fig.text(0.01, -0.045,
             "24 đồ thị tổng hợp, 5 seed, 120 trial. Trên 20 đồ thị có đường đích (100 trial), "
             "cả Beam và MCTS đúng 100/100. MCTS không phải thuật toán chứng minh vét cạn.",
             ha="left", fontsize=8, wrap=True)
    fig.tight_layout()
    save(fig, "fig5_phase3_beam_mcts")


def phase4_reuse_status() -> None:
    rows = read_csv("agg_phase4_reuse_status.csv")
    values = {r["metric"]: int(number(r, "count")) for r in rows}
    required = {
        "Goal graphs observed", "Distinct cross-goal reused knowledge nodes",
        "Verified reused nodes", "Reusable for planning",
    }
    if set(values) != required:
        raise ValueError(f"Unexpected Phase 4 reuse rows: {sorted(values)}")
    labels = ["Goal graphs", "Cross-goal node", "Verified", "Usable for planning"]
    metric_names = [
        "Goal graphs observed", "Distinct cross-goal reused knowledge nodes",
        "Verified reused nodes", "Reusable for planning",
    ]
    counts = [values[name] for name in metric_names]

    fig, ax = plt.subplots(figsize=(8.2, 4.5))
    bars = ax.bar(labels, counts)
    ax.set_ylim(0, max(counts) + 5)
    ax.set_ylabel("Số lượng được ghi nhận")
    ax.set_title("Phase 4 — trạng thái reuse được quan sát trong ledger")
    ax.grid(axis="y", alpha=0.25)
    ax.set_axisbelow(True)
    ax.tick_params(axis="x", labelrotation=10)
    for bar, val in zip(bars, counts):
        ax.text(bar.get_x() + bar.get_width() / 2, val + 0.5, f"{val}",
                ha="center", va="bottom")
    fig.text(0.01, -0.025,
             "Node reuse chưa verified và chưa usable for planning; số lượng membership không đo tiết kiệm chi phí.",
             ha="left", fontsize=8)
    fig.tight_layout()
    save(fig, "fig6_phase4_reuse_status")


def main() -> None:
    phase1_accuracy()
    phase1_cost()
    phase2_reliability()
    phase2_paired_latency()
    phase3_beam_mcts()
    phase4_reuse_status()
    print("Generated 6 figures (PDF + PNG) from the bundled AGG CSV summaries.")


if __name__ == "__main__":
    main()
