# Rich editors — Docs, Sheets, Lark/Feishu, Notion, Figma, maps, whiteboards

Apps that render their editable surface into a canvas or virtualized DOM
are hostile to the accessibility tree: the tree faithfully renders the
toolbars, focus traps, hidden textareas, and offscreen iframes — none of
which represent the user-editable document. Acting on that tree lands
typing in a search box or hidden input instead of the document.

## The pattern

For the main editing surface in a rich editor:

1. **Inspect a screenshot.** `Page.captureScreenshot()`. Identify the
   viewport coordinates of the editable surface visually.
2. **Click into the surface.** `Input.dispatchMouseEvent` at those coords —
   this moves the caret into the editor's own focus.
3. **Write probe.** Type a short, unique token via `Input.insertText`
   (one CDP call, no per-keystroke timing).
4. **Verify** the probe lands in the document via another screenshot,
   an export path, or another reliable visual / state check.
5. **If the probe is elsewhere** (title bar, toolbar search, hidden textarea)
   STOP using `axView` / DOM helpers for this surface — switch fully to
   screenshot-guided mouse + real keyboard.
6. **Bulk content** only after the probe is verified to land in the right
   place.

## Why the DOM is wrong here

The editor keeps the document in its OWN virtual model. The DOM around it is
app chrome: toolbars, menus, focus traps (for accessibility compliance),
caret indicators, hidden textareas for IME
— none of it maps to the glyph positions the agent wants to type at.
`axView` will show a `textbox` for the hidden focus-trap input; `axType` will
fill it; the text vanishes from view.

Toolbar search boxes, title inputs, and dialog fields (NOT inside the
document body) DO work via the accessibility tree — use `axType(ref, refs,
text)` for those.

## Traps

- **A clean `axView` doesn't mean the editor is targetable.** It means the
  toolbars are. Always probe before bulk content.
- **After an in-app modal / dialog, refocus the surface with a coordinate
  click** — the focus trap may have changed.
- **Sheet / canvas coordinates are virtual.** Google Sheets, Figma, and
  similar move DOM/AX references under you during scroll / zoom. Re-screenshot
  before coordinate clicking if the workspace scrolled.
- **`Runtime.evaluate` on the document body** may dispatch editor-specific
  events that put state in unexpected places. `Input.dispatchKeyEvent` /
  `Input.insertText` goes through the real input path — safer for typing
  characters.

## See also

- [`agent-operating-loop.md`](agent-operating-loop.md) — the visual workflow
  as one of three, and the per-round observe->act->verify->return loop.
- [`screenshots.md`](screenshots.md) — `Page.captureScreenshot` formats,
  region options.
- [`drag-and-drop.md`](drag-and-drop.md) — mouse dragging for canvas surfaces.