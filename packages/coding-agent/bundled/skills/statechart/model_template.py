#!/usr/bin/env python3
# Statechart model. Fill in MODEL and VIEW; leave ENGINE as is.
# Run: python3 model.py [--out DIR]
import json
import os
import sys
from collections import deque

# ===== MODEL: one entry per real code path; cite file:line for each =====
# Example: checkout with a retry button. Bug: retry is allowed while a charge is in flight.
INIT = [{"phase": "idle", "inflight": 0, "charges": 0}]


def actions(s):
	# checkout.ts:12 pay()
	if s["phase"] == "idle":
		yield "Pay", {**s, "phase": "paying", "inflight": s["inflight"] + 1}
	# checkout.ts:30 onChargeOk()
	if s["inflight"] > 0:
		yield "ChargeOk", {**s, "phase": "paid", "inflight": s["inflight"] - 1, "charges": s["charges"] + 1}
	# checkout.ts:41 onChargeFail()
	if s["inflight"] > 0 and s["phase"] == "paying":
		yield "ChargeFail", {**s, "phase": "failed", "inflight": s["inflight"] - 1}
	# checkout.ts:55 retry(): no inflight check
	if s["phase"] in ("paying", "failed"):
		yield "Retry", {**s, "phase": "paying", "inflight": s["inflight"] + 1}


RULES = {
	"ChargedOnce": ("You are charged at most once.", lambda s: s["charges"] <= 1),
}


def terminal(s):
	return s["phase"] == "paid" and s["inflight"] == 0


CONSTRAINT = lambda s: s["inflight"] <= 2  # bound: states past it are checked, not explored

# ===== VIEW: the reader's words =====
TITLE = "Checkout"


def state(s):
	if s["phase"] == "paying":
		return "Paying, 2 charges in flight" if s["inflight"] > 1 else "Paying"
	if s["phase"] == "paid":
		return "Paid, a charge still in flight" if s["inflight"] > 0 else "Paid"
	return {"idle": "Cart", "failed": "Payment failed"}[s["phase"]]


def step(action, s, t):
	return {
		"Pay": "you press pay",
		"ChargeOk": "the charge succeeds",
		"ChargeFail": "the charge fails",
		"Retry": "you press retry",
	}[action]


def group(s):
	return None


COLORS = {}  # group name -> fill color, e.g. {"checkout": "#d1e7dd"}

# ===== ENGINE: do not edit =====
MAX_STATES = 100_000
CHART_BUDGET = 500


def _key(s):
	return json.dumps(s, sort_keys=True)


def _q(text):
	return str(text).replace('"', "'").replace("\n", " ")


def _main():
	out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else "out"
	os.makedirs(out, exist_ok=True)
	states, parent, edges, broken, first_break = {}, {}, [], {}, {}
	steps_out = {}
	queue = deque()
	for s in INIT:
		k = _key(s)
		if k not in states:
			states[k], parent[k] = s, None
			queue.append(k)
	truncated = False
	bounded_count = 0
	while queue:
		k = queue.popleft()
		s = states[k]
		bad = {name for name, (_, pred) in RULES.items() if not pred(s)}
		bounded = not CONSTRAINT(s)
		bounded_count += bounded
		nxt = [] if bounded else list(actions(s))
		if not bounded and not nxt and not terminal(s):
			bad.add("NoDeadlock")
		broken[k] = bad
		for r in bad:
			first_break.setdefault(r, k)
		steps_out[k] = len(nxt)
		for a, t in nxt:
			tk = _key(t)
			if tk not in states:
				if len(states) >= MAX_STATES:
					truncated = True
					continue
				states[tk], parent[tk] = t, (k, a)
				queue.append(tk)
			edges.append((k, a, tk))

	label = {k: state(s) for k, s in states.items()}
	grp = {k: group(s) for k, s in states.items()}
	arrow_steps = {}
	hidden = set()
	warnings = []
	for k, a, tk in edges:
		if label[k] == label[tk]:
			continue
		lbl = step(a, states[k], states[tk])
		if lbl is None:
			hidden.add(f"{a} ({label[k]} -> {label[tk]})")
		arrow_steps.setdefault((label[k], label[tk]), []).append(lbl)
	for (src, dst), lbls in arrow_steps.items():
		if None in lbls and any(l is not None for l in lbls):
			warnings.append(f"Arrow {src} -> {dst} hides only some of its steps, so its condition looks narrower than it is.")
	for r, k in first_break.items():
		while parent[k] is not None:
			pk, a = parent[k]
			if label[pk] == label[k]:
				warnings.append(
					f"The {r} bug path has a step that stays inside '{label[k]}' ({step(a, states[pk], states[k]) or a}), "
					"so the chart cannot show it. Split that label in state()."
				)
			k = pk

	def path(k):
		seq = []
		while parent[k] is not None:
			pk, a = parent[k]
			seq.append((a, k))
			k = pk
		seq.reverse()
		lines = [f"1. Start in **{label[k]}** `{_key(states[k])}`"]
		for i, (a, sk) in enumerate(seq, 2):
			prev = parent[sk][0]
			lines.append(f"{i}. {step(a, states[prev], states[sk]) or a} (`{a}`) -> **{label[sk]}** `{_key(states[sk])}`")
		return "\n".join(lines)

	all_rules = list(RULES) + ["NoDeadlock"]
	report = [f"# {TITLE or 'Model'}", "", f"Distinct states: {len(states)}. Steps: {len(edges)}.", ""]
	if bounded_count:
		report += [f"States past CONSTRAINT (rules checked, not explored, no deadlock check): {bounded_count}.", ""]
	if truncated:
		report += [f"Stopped at {MAX_STATES} states. Rules with no break found are NOT CHECKED.", ""]
	for r in all_rules:
		desc = RULES[r][0] if r in RULES else "Every state that is not an end state has a step out."
		if r in first_break:
			report += [f"## {r}: BREAKS", desc, "", "Shortest path:", path(first_break[r]), ""]
		elif truncated:
			report += [f"## {r}: NOT CHECKED", desc, ""]
		else:
			report += [f"## {r}: holds", desc, ""]

	chart_keys = set(states)
	if len(states) > CHART_BUDGET:
		chart_keys = set()
		for r, k in first_break.items():
			while k is not None:
				chart_keys.add(k)
				k = parent[k][0] if parent[k] else None
		report += [f"Chart shows only bug paths: {len(states)} states is over the budget of {CHART_BUDGET}.", ""]

	labels = sorted({label[k] for k in chart_keys})
	ids = {l: f"s{i}" for i, l in enumerate(labels)}
	members = {l: [k for k in chart_keys if label[k] == l] for l in labels}
	lines = ["---", f"title: {_q(TITLE)}", "---", "stateDiagram-v2"] if TITLE else ["stateDiagram-v2"]
	for l in labels:
		lines.append(f'\tstate "{_q(l)}" as {ids[l]}')
	arrows = []
	starts = sorted({label[_key(s)] for s in INIT} & set(labels))
	for l in starts:
		lines.append(f"\t[*] --> {ids[l]}")
	drawn = set()
	for k, a, tk in edges:
		if k not in chart_keys or tk not in chart_keys or label[k] == label[tk]:
			continue
		lbl = step(a, states[k], states[tk])
		if lbl is None or (label[k], label[tk], lbl) in drawn:
			continue
		drawn.add((label[k], label[tk], lbl))
		lines.append(f"\t{ids[label[k]]} --> {ids[label[tk]]}: {_q(lbl)}")
		arrows.append({"from": ids[label[k]], "to": ids[label[tk]], "label": str(lbl)})
	ends = []
	for l in labels:
		if any(terminal(states[k]) for k in members[l]):
			lines.append(f"\t{ids[l]} --> [*]")
			ends.append(ids[l])
	legend = []
	marks = {}
	for l in labels:
		bad = [broken[k] for k in members[l]]
		rules = sorted(set().union(*bad))
		if not rules:
			g = {grp[k] for k in members[l]}
			if len(g) == 1 and None not in g and next(iter(g)) in COLORS:
				lines.append(f"\tclass {ids[l]} g_{_q(next(iter(g))).replace(' ', '_')}")
			continue
		cls = "breaks" if all(bad) else "mayBreak"
		marks[l] = {"mark": cls, "rules": rules}
		lines.append(f"\tclass {ids[l]} {cls}")
		legend.append(f"- **{l}** {cls}: {', '.join(rules)}")
	for name, fill in COLORS.items():
		lines.append(f"\tclassDef g_{_q(name).replace(' ', '_')} fill:{fill}")
	lines += ["\tclassDef breaks fill:#f8d7da,stroke:#b02a37,stroke-width:2px", "\tclassDef mayBreak fill:#fff3cd,stroke:#b58105,stroke-dasharray:4"]

	reach = {l for l in labels if l in {label[_key(s)] for s in INIT}}
	frontier = list(reach)
	adj = {}
	for src, dst, _ in drawn:
		adj.setdefault(src, set()).add(dst)
	while frontier:
		for d in adj.get(frontier.pop(), ()):
			if d not in reach:
				reach.add(d)
				frontier.append(d)
	for l in labels:
		if l not in reach:
			warnings.append(f"Chart state {l} has no arrow path from a start state.")
		if any(steps_out[k] for k in members[l]) and l not in adj and not all(
			label[tk] == l for k, _, tk in edges if label.get(k) == l
		):
			warnings.append(f"Chart state {l} has steps out in the model but no arrow out in the chart.")
	if len(drawn) > 20:
		warnings.append(f"Chart has {len(drawn)} arrows. Aim for 20 or fewer: coarsen state() or hide repeated steps.")
	inside = sum(1 for k, _, tk in edges if label[k] == label[tk])
	if inside:
		report += [f"Steps that stay inside one chart state and are not drawn: {inside}.", ""]
	if hidden:
		report += ["## Hidden steps (step() returned None)", *[f"- {h}" for h in sorted(hidden)], ""]
	if legend:
		report += ["## Legend", *legend, ""]
	if warnings:
		report += ["## Chart warnings", *[f"- {w}" for w in warnings], ""]

	chart = "\n".join(lines) + "\n"
	with open(f"{out}/report.md", "w") as f:
		f.write("\n".join(report))
	print("\n".join(report))
	for stale in ("chart.mmd", "chart.json", "chart.html"):
		if os.path.exists(f"{out}/{stale}"):
			os.remove(f"{out}/{stale}")
	if len(states) > CHART_BUDGET and not first_break:
		print(f"No chart: {len(states)} states is over the budget of {CHART_BUDGET} and no rule breaks. Make the model smaller to see it.")
	else:
		with open(f"{out}/chart.mmd", "w") as f:
			f.write(chart)
		# Each rule's verdict and the shortest path to each break, in chart ids, for displays that draw them.
		bug_paths = []
		for r, k in first_break.items():
			seq = []
			while parent[k] is not None:
				pk, a = parent[k]
				if label[pk] != label[k]:
					seq.append({"from": ids[label[pk]], "to": ids[label[k]], "label": str(step(a, states[pk], states[k]) or a)})
				k = pk
			seq.reverse()
			bug_paths.append({"rule": r, "start": ids[label[k]], "steps": seq})
		view = {
			"title": TITLE or "",
			"states": [{"id": ids[l], "label": l, **marks.get(l, {"mark": None, "rules": []})} for l in labels],
			"arrows": arrows,
			"starts": [ids[l] for l in starts],
			"ends": ends,
			"rules": [
				{
					"name": r,
					"sentence": RULES[r][0] if r in RULES else "Every state that is not an end state has a step out.",
					"verdict": "breaks" if r in first_break else "not checked" if truncated else "holds",
				}
				for r in all_rules
			],
			"bugPaths": bug_paths,
		}
		with open(f"{out}/chart.json", "w") as f:
			json.dump(view, f, indent=1)
		print(f"Wrote {out}/chart.mmd and {out}/chart.json. Build the page with render.ts (see SKILL.md); do not paste chart.mmd.")
	# 1 = a rule breaks; 2 = no break found but the search stopped early; 0 = every rule holds in the explored space
	sys.exit(1 if first_break else 2 if truncated else 0)


if __name__ == "__main__":
	_main()
