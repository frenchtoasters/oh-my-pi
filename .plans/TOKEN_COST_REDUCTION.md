# Token Cost Reduction Plan

## Objective

Reduce per-turn token costs (~$0.05/request at ~$1/M tokens) by adopting four cost-saving patterns from OpenCode's tool architecture, focused on the read and web search tools which are the highest cost drivers.

## Background

OMP sessions accumulate ~40-50K input tokens per turn. Tool results (especially read and web search) persist in context until compaction fires. The main cost drivers are:

1. **Read tool** outputs up to 500 lines with no per-line length cap — a single minified/log line can be thousands of chars
2. **Read tool** pagination hint encourages the model to make N more reads, compounding context
3. **Web search** `formatForLLM` includes `relatedQuestions` and `searchQueries` sections that add ~200-500 tokens of noise per search
4. **No per-line truncation** means worst-case files (minified JS, JSONL, logs) bloat context disproportionately

OpenCode addresses these with: per-line truncation at 2000 chars, save-to-disk + "delegate to Task tool" overflow messages, and provider-level context caps on search.

## Changes

### Change 1: Strip relatedQuestions and searchQueries from web search output

**Impact**: ~200-500 tokens saved per web search call, zero risk  
**File**: `packages/coding-agent/src/web/search/index.ts`

Remove the `relatedQuestions` block (lines 117-123) and `searchQueries` block (lines 125-130) from `formatForLLM`. These are noise — the model never acts on them.

### Change 2: Add per-line length truncation to read tool

**Impact**: Prevents worst-case blowouts (minified files, logs). A single 50KB minified line currently eats the entire byte budget. With 2000-char cap, worst case per line is bounded.  
**Files**: 
- `packages/coding-agent/src/tools/read.ts` (in `finalizeLine` or `decodeLine` within `streamLinesFromFile`)
- `packages/coding-agent/src/config/settings-schema.ts` (new `read.maxLineLength` setting)

In `streamLinesFromFile`, after `decodeLine()` at line 265, truncate the decoded line if it exceeds `maxLineLength` (default 2000 chars). Append `…[N chars truncated]` suffix. This matches OpenCode's approach exactly.

The setting should be:
```
"read.maxLineLength": {
    type: "number",
    default: 2000,
    ui: { tab: "editing", label: "Max Line Length", description: "..." }
}
```

**Implementation detail**: The truncation must happen at the *character* level after UTF-8 decode, not at the byte level. The `decodeLine()` function already returns a string, so `line.slice(0, maxLineLength)` is correct.

### Change 3: Add delegation hint to overflow message

**Impact**: Prevents the model from making 5-10 sequential reads to paginate through large files, which compounds context by 2500-5000 tokens per extra read.  
**Files**: 
- `packages/coding-agent/src/tools/read.ts` (line 1421, the inline pagination message)
- `packages/coding-agent/src/tools/output-meta.ts` (line 339-341, `formatTruncationMetaNotice`)

Current message (line 1421):
```
[${remaining} more lines in file. Use :${nextOffset} to continue]
```

New message:
```
[${remaining} more lines in file. Use :${nextOffset} to continue. Read artifact://${artifactId} for full output]
```

**Key design question**: The read tool's text-file path does NOT currently save to an artifact (unlike bash/eval which use `OutputSink`). To add `artifact://` reference, we need to:

1. Save the full file content to an artifact when truncated (like OpenCode's `truncate.ts` does)
2. Reference it in the overflow message

However, for read tool this is different than bash — the file already exists on disk at a known path. The model can already re-read it with `:offset`. The real value from OpenCode's approach isn't saving to disk (the file IS on disk), it's the **behavioral instruction**: "Delegate to Task tool to process this file — do NOT read the full file yourself."

**Recommended approach**: Change the overflow message to discourage self-pagination and suggest delegation:

```
[${remaining} more lines in file. Use :${nextOffset} to continue. For files this large, prefer delegating to Task tool — do NOT paginate the entire file yourself.]
```

For the `formatTruncationMetaNotice` path (used by bash/eval/ssh which DO have artifacts):
```
Showing lines X-Y of Z. Use :N to continue. Read artifact://ID for full output. For files this large, prefer delegating to Task tool — do NOT paginate the entire file yourself.
```

### Change 4: Lower FETCH_DEFAULT_MAX_LINES for URL reads (300 → 200)

**Impact**: Reduces URL read output by ~33%. URL content is less precise than file content — the model rarely needs 300 lines of a web page.  
**File**: `packages/coding-agent/src/tools/fetch.ts` (line 34)

Change:
```typescript
const FETCH_DEFAULT_MAX_LINES = 300;
```
To:
```typescript
const FETCH_DEFAULT_MAX_LINES = 200;
```

This still provides substantial content for documentation pages while reducing context accumulation when the model reads multiple URLs in a turn.

## Files Affected

| File | Change |
|------|--------|
| `packages/coding-agent/src/web/search/index.ts` | Remove relatedQuestions + searchQueries from `formatForLLM` |
| `packages/coding-agent/src/tools/read.ts` | Per-line truncation in `streamLinesFromFile`; updated overflow message |
| `packages/coding-agent/src/config/settings-schema.ts` | New `read.maxLineLength` setting |
| `packages/coding-agent/src/tools/fetch.ts` | Lower `FETCH_DEFAULT_MAX_LINES` to 200 |
| `packages/coding-agent/src/tools/output-meta.ts` | Updated `formatTruncationMetaNotice` to suggest delegation |

## Design Decisions

### Why not use OpenCode's "save to file" pattern for read tool?

OpenCode saves truncated output to a temp file and tells the model to delegate. For the *read tool*, the full content is already on disk — the file being read IS the source. Saving it again is redundant. Instead, we adopt the behavioral instruction ("delegate to Task tool") which achieves the same context-saving effect without extra I/O.

For bash/eval/ssh tools that already save artifacts via `OutputSink`, we enhance the existing message to also suggest delegation.

### Why 2000 chars for line truncation?

Matches OpenCode exactly. Covers the vast majority of real code lines (99.9%+ are under 200 chars). Only fires on minified files, JSONL blobs, SVGs, and similar machine-generated content that the model gains nothing from seeing in full.

### Why lower fetch lines to 200 instead of 150?

OpenCode doesn't have a separate URL-fetch line limit — they use the global 2000. OMP already caps at 300 which is lower. Going to 200 is a conservative step that still provides good coverage for documentation pages. Going lower risks cutting off important content on pages with headers/nav.

### Why not add contextMaxCharacters to Exa?

Exa's `context` parameter is **deprecated** (per their docs). OMP already requests `contents.summary` which returns per-result summaries — this is already more token-efficient than full text. The real savings come from stripping the noise fields from `formatForLLM`.

## Verification

1. **Web search noise removal**: Run web search and confirm output no longer contains "## Related" or "Search queries:" sections
2. **Per-line truncation**: Read a minified JS file (e.g., a bundled node_modules file) and verify lines are capped at 2000 chars with truncation suffix
3. **Overflow message**: Read a large file without explicit limit and verify the new message includes Task tool suggestion
4. **Fetch limit**: Read a URL and verify output is capped at 200 lines
5. **Type check**: `bun check:ts` passes
6. **Existing tests**: `bun test packages/coding-agent/test/tools/read` passes (if applicable)

## CHANGELOG Entry

```markdown
### Changed
- Reduced web search token output by removing relatedQuestions and searchQueries noise
- Added per-line length truncation (2000 chars) to read tool to prevent minified file bloat
- Updated read tool overflow message to suggest Task tool delegation for large files
- Reduced URL fetch default from 300 to 200 lines for tighter context usage
```
