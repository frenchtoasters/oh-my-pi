# pi-daybook

Generate Obsidian-style **daily / weekly session notes** summarizing the work
you did across all your repos with Pi.

The `/daybook` command scans your session history over a chosen period, asks the
active model to write a narrative summary (Summary / Highlights / Sessions
grouped by repo), appends a full token/cost usage breakdown, and writes an
Obsidian note with frontmatter and topical `#tags`.

## Usage

```
/daybook               # pick a period interactively (defaults to today)
/daybook today
/daybook yesterday
/daybook week          # this ISO week → YYYY-Www.md
/daybook last-week
/daybook 3d            # last 3 days
```

## Output

- **Daily** notes are written to `YYYY-MM-DD.md`.
- **Weekly** notes are written to `YYYY-Www.md` (ISO week) with a date-range
  subtitle and `type: weekly-note` frontmatter.

Notes are written to `~/Obsidian/Daily Notes/` by default. Override with:

- the `--daybook-dir <path>` CLI flag, or
- the `OMP_DAYBOOK_DIR` environment variable.

`~` is expanded and the directory is created if missing. If a note already
exists you'll be asked to confirm before overwriting (interactive mode only).

## Note layout

```markdown
---
date: 2026-06-11
type: daily-note
tags: [daybook, refactor, testing]
---
# 2026-06-11

## Summary
...

## Highlights
- ...

## Sessions
### my-repo
- **Session title** — one-line recap

## Usage
| Model | Sessions | Msgs | Cost | Tokens | Cache Hit |
|---|---|---|---|---|---|
| ... | ... | ... | ... | ... | ... |
| **Total** | ... | ... | ... | ... | ... |

## Tags
#daybook #refactor #testing
```