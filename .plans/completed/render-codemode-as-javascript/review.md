## Findings

### [P2] Preserve carriage returns in the clipboard fallback

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-tau-web-server/src/public/javascript-code-block.ts:60-66`

When `navigator.clipboard` is unavailable, such as when opening Tau over plain HTTP on a non-loopback host, assigning the source to a textarea normalizes CRLF and standalone carriage returns to LF. The fallback therefore copies different source while reporting “Copied!”. A browser check with CRLF source confirmed that the displayed code preserves the original characters but the textarea value does not. Preserve the original source in the fallback copy operation and add a test for this path; the existing clipboard test only exercises `navigator.clipboard.writeText`.

## User feedback

The user considers the clipboard fallback issue too niche to warrant a fix and accepts the current behavior. No code change is planned for this finding.

## Overall assessment

**Verdict:** Patch is incorrect.

**Explanation:** Reviewed the last three commits, excluding the requested AGENTS.md note. The shared renderer, safe highlighting fallback, asset packaging, and nested-call simplification make sense, but the clipboard fallback does not preserve exact source. Typecheck, all 247 unit tests, and all 58 browser tests passed; the added tests do not cover this fallback copy path.
