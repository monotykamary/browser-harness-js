# linkedin.com (profile experience and company page admin)

Hand-proven on the running Helium. No node-tool yet; these are the recipes.

## Background tabs

- Open each page with `Target.createTarget({url, background: true})` and set `Emulation.setFocusEmulationEnabled({enabled: true})`. Pickers and typeaheads stay dead without it.
- The harness session can drop mid-flow ("Session with given id not found"). A raw `ws://127.0.0.1:<port>/devtools/page/<id>` connection per step survives that.

## Profile experience entry

- Add: `/in/<id>/add-edit/POSITION/` redirects to `/edit/forms/position/new`. Edit: the entry's link `/details/experience/edit/forms/<positionId>/`.
- Text inputs carry placeholders ("Example: Senior Product Manager", "Example: Microsoft", "City or region"). Focus, select, `Input.insertText`.
- The organization and location typeaheads need a real pick: ArrowDown then Enter, or a trusted click on the `[role=option]` rect. Typed text alone does not link the company page.
- Selects (location type, employment type, start month and year) take the native value setter plus `input` and `change` events.
- The description is a ProseMirror `[contenteditable]`. A DOM range select does not replace it; use Cmd+A (`Input.dispatchKeyEvent` with `modifiers: 4, commands: ['selectAll']`) then Backspace, then one `insertText`.
- A new position shows "Update your profile headline" radios, preselecting the new title. Pick the current-headline radio to keep it.
- "Notify network" is off by default on the form. After Save LinkedIn lands on a share or people-you-may-know page; nothing posts.

## Company page admin (`/company/<numeric id>/admin/edit/`)

- Tabs (Page info, Details, Workplace...) are buttons that answer only to `element.click()`; a trusted click on them did nothing.
- Fields have labels: Name, LinkedIn public URL (input aria-label "Edit LinkedIn public URL ..."), Tagline, Overview, Website URL, Industry (typeahead), Company size, Year founded, "Add a specialty" (confirm with the "Confirm new specialty value" button; old chips have "Remove <x> specialty").
- A field off screen has a zero rect; switch to its tab first.
- Save is the top-right "Save". Expect a "Share your page edits" dialog (answer "No thanks") or an upsell modal (dismiss).
- Changing the public URL keeps a redirect from the old slug.
- Locations: the HQ edit form requires a city, and has no delete control for the primary location. Replace the city instead of clearing it.
- Logo: `DOM.setFileInputFiles` on `input[type=file]` labelled "Upload logo", then Save. Cover: the "Edit background" button -> "Edit cover image" -> set files on the dialog's `input[accept="image/*"]` -> "Apply" (scroll it into view first). Apply saves on its own.
- The member view caches images for minutes. Confirm a new logo or cover from the admin page's `media.licdn.com` image URLs.

## Profile photo at full size

- Page `<img>` tags carry only the 100 px crop. Same-origin `fetch('/voyager/api/me')` with the `csrf-token` header (the JSESSIONID cookie value) returns `rootUrl` plus `shrink_400_400` and `shrink_800_800` path segments.
