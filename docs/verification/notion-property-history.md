# app-notion-com: pagePropertyHistory

`skills/cdp/learnings/app-notion-com/tools/pages.mjs` adds `pagePropertyHistory` (manifest tool `page_property_history`): who changed which property of a page or row, from the internal activity log.

## Green run

Command: `node --test skills/cdp/learnings/app-notion-com/tools/workspace.test.mjs`
Exit: 0
Output:
```
# tests 12
# pass 12
# fail 0
```
Verdict: PASS

Command: `pagePropertyHistory({session}, {pageId: "40b64b29b84c81838782fde586c4f4a6"})` in the logged-in app.notion.com tab, 2026-11-03 (read-only)
Exit: 0
Output (title noise filtered):
```
2026-11-03T04:26:14.733Z  authors ["39c64b29-b84c-81a3-83f9-00278c4a8344"]  Status: "Pending Approval" -> "Approved"
2026-11-01T00:06:04.374Z  authors ["00000000-0000-0000-0000-000000000003"]  Status: "Draft" -> "Pending Approval"
```
Verdict: PASS (property names resolved from the collection schema; bot authors stay raw ids)

The live run found one bug the fixture missed: `start_time` arrives as a string of milliseconds, so `new Date(string)` threw. Fixed with `Number()`, and the fixture now uses a string time.

## Negative control

Command: `git checkout main -- tools/pages.mjs` (drop the tool), then the same `node --test` command
Exit: 1
Output:
```
SyntaxError: The requested module './pages.mjs' does not provide an export named 'pagePropertyHistory'
# tests 1
# fail 1
```
Verdict: PASS (restored with `git checkout HEAD --`, back to 12 pass)
