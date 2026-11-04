---
name: statechart
description: "Check a small model of a system that moves between states, such as a product flow, a protocol, a lock, a retry loop, or a sandbox decision, and draw it as an HTML statechart in the reader's words. The report gives the shortest path to each state that breaks a rule. Use for /skill:statechart, to explain a state machine, or to show a bug as a path through states."
---

# Statechart

The chart shows how a system moves between states, in the words of the person who reads it. That person, the reader, decides whether the behavior is right.

Adapted from [pstack `statechart`](https://github.com/cursor/plugins/tree/main/pstack/skills/statechart) (MIT, Lauren Tan). pstack checks a TLA+ spec with TLC. This version keeps the same rules, but it uses a small Python model and a breadth-first search in `model_template.py`. It needs only `python3`, and it installs nothing.

## What this check is and is not

The template visits every state that the model can reach from its start states, up to a bound, and it checks every rule in every state. Breadth-first order makes each reported bug path a shortest path. That is the same guarantee that TLC gives for safety rules on a finite model.

It does not check liveness ("something good eventually happens"), fairness, or temporal formulas. It checks only rules about one state at a time, plus deadlock. If the question is about liveness, or if the model needs more than about 100,000 states, say so and recommend TLA+ with TLC instead.

A pass covers the model and its bound, not the code. The model is only as true as its link to the code.

## Run

Work in a scratch folder outside the repo, such as `/tmp/statechart/<slug>/`. Copy the template, then edit only the MODEL and VIEW sections:

```sh
mkdir -p /tmp/statechart/<slug> && cp skill://statechart/model_template.py /tmp/statechart/<slug>/model.py
python3 /tmp/statechart/<slug>/model.py --out /tmp/statechart/<slug>/out
```

The template ships with a worked example (a checkout with a retry bug). Replace all of it. Never edit the ENGINE section. The guard rails below live there.

The exit code says what happened:

| Exit | Meaning |
|---|---|
| `0` | Every rule holds in every reachable state within the bound. |
| `1` | At least one rule breaks. The report gives each shortest path. |
| `2` | No rule broke, but the search stopped at `MAX_STATES`. Rules not found broken are **NOT CHECKED**. Never report this as a pass. |

The run writes `out/report.md` and, when a chart is possible, `out/chart.mmd` (the full Mermaid source with colors) and `out/chart.json` (the same graph as data, with each rule's verdict and the shortest path to each break, for `render.ts`).

## Write the model

- **State is a plain dict** of JSON-serializable values. Two states are the same state when their dicts are equal.
- **`INIT`** lists the start states.
- **`actions(s)`** yields `(ActionName, next_state)` for every step that can happen from `s`. Write one `if` block for each real code path, and put a comment on it with `file:line` and the function name. Every part of the model must point to code that a reviewer can open. What the code does as one indivisible step is one action. When the code awaits, yields, or releases a lock between two writes, that is two actions.
- **`RULES`** maps a name to `(sentence, predicate)`. The sentence is the rule in the reader's words, such as "You are charged at most once." Write each rule that the reader agrees to. A rule can be about a screen, a result, a stored value, or a message. If the model has no variable for a rule, add the variable. Never weaken a rule to make it hold.
- **`terminal(s)`** returns true for correct end states. Any other state with no step out breaks `NoDeadlock`.
- **`CONSTRAINT(s)`** bounds the search. The engine checks the rules in a state past the bound, but it does not explore that state or check it for deadlock. The report counts those states. Keep constants small (two clients, two retries, three messages) before you reach for a bigger bound.

## Pick the chart

You do the work that needs judgment: the words on each state and arrow, the phases and their colors, the title, and the report to the reader.

- **`state(s)`** returns the label of the chart state. Label each state with what the reader can see or cares about, such as "Paying" or "Lease held, write pending". Keep variable names out of labels. Several model states can share one label.
- **`step(action, s, t)`** returns the arrow label. Write it as the user sees it happen, such as "you press retry" or "the connect fails". Do not name the code or the action. Two actions that end the same in the chart get the same label, so that they share one arrow. Return `None` to hide a step.
- **Conditions.** When a step can occur only in some conditions, end its label with the condition in brackets, in the reader's words, such as `you press retry [while a charge is in flight]`. When a value that no label shows decides where a step goes, name the result in the label, such as "the roster read fails".
- **`group(s)`** returns a phase name, and **`COLORS`** maps each phase to a fill color. A chart state gets its phase color only when all the model states behind it are in the same phase.
- Make `state()`, `step()`, and `group()` depend only on their arguments.

Aim for about 20 arrows or fewer. First return coarser labels from `state()`: give one label to values that act the same, and leave out details that the reader does not need. Then hide steps the reader does not need by returning `None` from `step()`, such as a reset that every state has. Obey these rules when you coarsen or hide:

- Keep each state of a bug path. The engine warns when a bug path has a step that stays inside one label, because the chart cannot show that step. Split that label until the warning goes away.
- Do not merge two states that break different rules. The reader then cannot see which rule breaks where.
- When a merge changes a `breaks` state to `mayBreak`, it hides where a rule breaks. Split it again.
- Keep each chart state reachable by arrows from a start state, and keep at least one arrow out of each chart state that has a step out in the model. The engine warns about both.
- Hide all the steps of an arrow, or none of them. When you hide only some, the arrow's condition looks narrower than it is. The engine warns about this.
- In the hand-off, say which steps the chart hides. The report lists them.

## Read the report

- A chart state has the class `breaks` when every model state behind it breaks a rule, and `mayBreak` when only some do. The Legend names the rules of each mark. When two rules break in one state, say in the hand-off which state breaks which rule.
- The search goes past a state that breaks a rule, so the chart shows the states after a bug too.
- Above 500 distinct states, the chart draws only the paths to the rules that break. When no rule breaks, the run writes no `chart.mmd`. Make the model smaller to see the whole graph.
- "Steps that stay inside one chart state" counts steps that the chart cannot draw, because they do not change the label. Split a label when the reader must see such a step.

## Prove it can fail

A rule that you have never seen fail proves nothing. After the model passes, break it the way the rule guards against: remove a guard, reorder two steps, or split an atomic step. Then confirm that the run exits `1` with a path that makes sense. Undo the break. Report the break you used.

When the current code breaks a rule, report it. Do not weaken the rule, the model, or the bound until it passes, and do not change product code unless the user asks.

## Show the chart

Every run of this skill ends with a chart page. Build it without being asked, each time the model runs and writes `chart.json`, including after each "prove it can fail" break:

```sh
bun skill://statechart/render.ts /tmp/statechart/<slug>/out
```

It writes `out/chart.html` and prints its path and a `file://` link. Give the user that link. The page needs no server and loads nothing from the network. Exit `0` means the page was written. Exit `2` means bad input or no layout engine. It needs the `chart.json` from this template; if it says `rules` or `bugPaths` is missing, run the model again.

The page reads top to bottom: the start dot on top, then one layer per step, fanning out downward. It uses ELK's layered layout, the engine behind omp's Mermaid renderer. An arrow back to an earlier state is drawn dashed.

- **States:** a card that breaks a rule has a red border and a `BREAKS` badge. A card that may break one has an amber dashed border and a `MAY BREAK` badge. An end state has a green border and an `END` badge.
- **Bug paths:** the shortest path to each broken rule is drawn in red, with dots moving along it.
- **Below the chart:** each rule with its verdict, then each bug path step by step.

Do not paste `chart.mmd` or retype the chart into the chat. Give the `chart.mmd` path in the hand-off for people who want a Mermaid viewer.

The page's look (palette, cards, glyph chips, label pills, badges, markers, and pulses) is copied from `@coldtea/pr-lens-renderer` 0.4.0 (MIT, Copyright (c) 2026 Coldtea AI). Only the look is copied, not PR Lens's guidance on what to diagram.

## Hand off

Give the `chart.html` link for each chart, as **Show the chart** says, and the path to its `chart.mmd`. Add one line for each bug: the rule, the reader's sentence for that rule, and the path as the report numbers it. Say what the model leaves out, the bound, and which steps the chart hides. Give the commands that make the files again.

When the model describes code, replay each bug path against the real code, as a test or a live repro, one step for each action. If the bug does not occur, assume that the model is wrong until you show that it is not.