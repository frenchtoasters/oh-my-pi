# Plan: Disable Browser and Notebook Tools

## Objective
Disable the `browser` and `notebook` tools to save ~3,500 tokens of tool definition from every session context. They are unused 99.9% of the time and can be re-enabled via config when needed.

## Approach
Add `browser.enabled: false` and `notebook.enabled: false` to the user settings file. The coding-agent already has built-in support for these flags — they're checked in `packages/coding-agent/src/tools/index.ts` (lines 437, 443) and defined in `settings-schema.ts` (lines 1780, 1871) with `default: true`.

## Change

**File:** `/Users/tfrench/.omp/agent/config.yml`

Add two settings entries (following the existing `renderMermaid.enabled` pattern):

```yaml
browser:
  enabled: false
notebook:
  enabled: false
```

## Token Savings
- `browser` tool definition: ~2,400 tokens
- `notebook` tool definition: ~400 tokens
- Total saved: ~2,800 tokens per session

## Re-enabling
To re-enable either tool, change `false` to `true` in the same config file:
```yaml
browser:
  enabled: true
```

## Verification
- Start a new session and confirm `browser` and `notebook` are not listed in available tools
- Confirm other tools still work normally
