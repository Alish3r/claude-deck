## Summary

<!-- 1-3 bullet points describing what this PR does -->

- 

## Issue retraceability

<!-- After merge, the linked issue should still tell the story. -->

- [ ] Linked issue body already had enough context **or** I added an **implementation comment** on the issue (what shipped, key commits/PRs) so a future reader can retrace **what and why**

## Linked Issue

<!-- REQUIRED: Every PR must reference an issue. No issue → create one first. -->

Closes #

## Related issues (overlap check)

- [ ] Searched open/recent issues for **duplicate scope**; linked **epics / dependencies / split tasks** — or documented **`Related: none`** with search terms

Related:

## Changes

<!-- What was changed and why? -->

## Verification evidence

<!-- REQUIRED — this repo has no CI; this section IS the merge gate.
     Paste the exact commands run and their observed output/result. -->

- [ ] `node spike/verify-anchors.mjs` (when anchors/patch files touched) — exit code pasted
- [ ] Unit tests pass (when testable code touched) — command + result pasted
- [ ] Live bridge verification (when injected code touched) — heartbeat/state-file evidence pasted
- [ ] Manual verification (describe what you tested)

## Patch safety (when applicable)

- [ ] Pristine backups untouched and marker-free (`grep -c __CLAUDE_DECK_v1__ spike/pristine/*` = 0)
- [ ] Apply is atomic (both files or neither); revert path exercised
- [ ] Every settings/state mutation is closed-loop (write → read back → verify)
- [ ] Cannot leave the Claude extension broken (explain why)

## Checklist

- [ ] PR title is under 70 characters
- [ ] No hardcoded secrets or credentials
- [ ] No extension bundles (pristine or patched) added to git
- [ ] No debug output left behind
