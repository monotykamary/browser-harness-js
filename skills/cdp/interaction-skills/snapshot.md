# Scoped accessibility snapshots

Use `page.snapshot()` for page reading. It owns native AX collection, projection,
refs and diff state; callers do not assemble or parse a separate ref map.

```js
const shot = await page.snapshot();
return { tree: shot.tree, diff: shot.diff, truncated: shot.truncated, omissions: shot.omissions };
```

Typical tree:

```text
url: "https://example.com/"
- RootWebArea "Fares" [ref=sAb3dEf6hJk9m_2e1]
  - textbox "Destination" [ref=sAb3dEf6hJk9m_2e2] value="Paris"
  - group "Outbound" [ref=sAb3dEf6hJk9m_2e3]
    - button "Select" [ref=sAb3dEf6hJk9m_2e4]
  - table "Prices" [ref=sAb3dEf6hJk9m_2e5]
    - row [ref=sAb3dEf6hJk9m_2e6]
      - cell "100" [ref=sAb3dEf6hJk9m_2e7]
```

## Options

| Option | Default | Contract |
|---|---|---|
| `interactive` | `false` | Keep controls and their meaningful ancestors; omit reading text |
| `maxDepth` | `50` | 0–100 emitted levels; truncation is explicit |
| `maxChars` | `50000` | 1–1000000 characters; overflow throws and publishes no new refs |
| `selector` | none | Exactly one standard CSS subtree in the main frame, or specified `frameId` |
| `ref` | none | Subtree rooted at a ref from the immediately preceding snapshot |
| `frameId` | all permitted | One frame; also available as `page.frame(frameId).snapshot(options)` |

`ref` and `selector` are mutually exclusive. `timeoutMs` and `signal` bound
operations. A scoped snapshot replaces the previous snapshot/ref generation,
just like a full snapshot. The URL header remains the top-level page's URL.

Projection is **CDP-native**, not a second DOM accessibility implementation. It
reads `AXNode.value` (including numbers and false/empty values), keeps named
structure and table relations, traverses ignored wrappers, and handles forests
without dropping query-result siblings. Redundant text is suppressed only when
the equivalent parent name is actually emitted. Protected/password-like values
and their descendants are redacted; labels remain. This is conservative
redaction, not a promise to detect all secrets in page content.

## Frame scope

`page.frames()` returns permitted frames with IDs and attachment metadata.
Snapshots include same-process frames and OOPIFs (cross-process iframes).
OOPIF attachment requires a frame owner in an already-authorized renderer;
unrelated iframe targets elsewhere in the browser are not attached. Each
frame's origin is checked separately. Denied/unavailable frames appear in
`omissions` and set `truncated:true`, rather than silently disappearing.

Limits include 64 readable frames, 128 iframe targets examined during
discovery, 50,000 AX nodes per frame and 512 source nesting levels. These are
deliberate bounds. Denied frames (cross-origin ads, trackers) are listed in
`omissions` but never read, so they do not count toward the frame limit.
Current subtree/interactive options reduce rendered output, **not the initial
full-frame AX transfer**. Huge native responses can still hit transport limits;
use explicit scoped raw AX queries when wire size is the problem.

## Refs are evidence, not authority

```js
return await page.locator('sAb3dEf6hJk9m_2e4').click({
  verify: next => next.tree.includes('Selected')
});
```

Refs include a snapshot generation and optional frame prefix. Their backend node
IDs stay private. Another snapshot, action, raw call or lifecycle invalidation
expires them. Before any effect, the locator checks the current document and
semantic identity, then the guard creates and revalidates a separate one-use
action handle. A replaced, disabled, private, occluded or unsupported target
does not become a coordinate click; the blocked reason says which it was and
the next move. Frame refs currently support reading only;
actions return `frame_actions_unsupported`.

Use `page.getByRole('button', {name:'Select', context:'group: Outbound'})`
when the intended semantics should be resolved anew. Role matching is exact by
default and requires exactly one match across the requested, complete scope;
it never selects the first candidate. Resolution reads that scope up to the
1,000,000-character maximum, so role locators work on pages larger than the
50,000-character snapshot default. Frames nothing can read or act in (denied
cross-origin ads and trackers, frames not yet committed) cannot hold a match, so
they do not make the scope incomplete; a depth-cut render or an allowed frame
that could not be read still refuses as incomplete. CSS is strict within one frame and does
not pierce shadow roots; native AX role lookup can see through them.

## Managed diffs

The first snapshot (or a changed scope) returns the full tree as `diff`. Later
matching scopes produce added/removed lines; printed ref churn is ignored using
private frame/node identity. Duplicate counts and reorder-only changes remain
visible. An unchanged snapshot returns `(no changes)`. Diffs are not patches and
are not evidence that an action achieved its goal.

A snapshot cannot expose a canvas editor's internal document or decide whether
a consent wall is the intended page. Use an explicit screenshot/read-back for
those cases; see [rich-editors.md](rich-editors.md).
