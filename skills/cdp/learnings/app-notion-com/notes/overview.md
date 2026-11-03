# app.notion.com developer portal (internal connections)

Portal: `https://app.notion.com/developers/connections?spaceId=<uuid>` (the old `www.notion.so/profile/integrations` redirects here). It acts on the current workspace.

## Gotchas

- **Own session.** app.notion.com needs its own login; a www.notion.so session does not carry. Signed out, the page renders cached with "You don't have permission to create connections in this workspace" and `/api/v3` returns UnauthorizedError. Every tool throws "not signed in to app.notion.com" instead of clicking.
- **List.** Rows are `<tr>` with no links. Click the `<tr>` whose innerText lines include the exact name; the URL becomes `/developers/connections/<uuid>`.
- **Create.** "New connection" opens `[role=dialog]`: name text input, radios `input[value=integrationToken]` (API token) / `oauth`, button "Create connection". Native value setter + `input` event fills the name.
- **Capabilities** (Configuration tab). Each is `<button aria-pressed>` wrapping a leaf div with the label: Read content, Update content, Insert content, Read comments, Insert comments, View sessions and interact with agents. User info is three plain buttons (No user information / ...without email addresses / ...including email addresses); the selected one has a nested `span>span` dot.
- **Content access** (`[role=tab]`) -> "Edit access" -> dialog "Manage page access". The native setter does NOT trigger the search. Use CDP: `Emulation.setFocusEmulationEnabled`, focus + select the input, `Input.dispatchKeyEvent` Backspace, `Input.insertText`. Results are `[role=menu] [role=menuitem]`; match on `textContent` (SVG children have no innerText), e.g. `🏢ClientsDatabases/US Operating`. A picked item reads "Already added". `el.click()` on the menuitem works. Escape, then the dialog's "Save". The page then shows "Teamspaces (N pages)".
- **Token.** Configuration shows it masked. Button `aria-label="Show or hide API token"` reveals it (`ntn_[A-Za-z0-9]{30,}`); click again to re-hide. `createConnection` never reveals it. `revealToken` returns the raw string: capture it into a variable, never print it.
- **Rename.** Display information "Edit" turns the name into the ONLY `input[type=text]` on the page. Set it, click "Save". Internal connections have no description field (name + icon only).

## Autosave vs Save

| Change | Persists how |
|---|---|
| Capabilities, user info | Autosave on click. No Save button. Verify by reload. |
| Page access | Explicit "Save" in the dialog. |
| Rename | Explicit "Save" next to the input. |

## Verify through the public API

`GET https://api.notion.com/v1/users/me` with the token and `Notion-Version: 2022-06-28` returns the connection name as `.name` and `.bot.workspace_name`. Use it to confirm a rename or a new token.

## Tools

`listConnections`, `openConnection({name})`, `createConnection({name})`, `setCapabilities({read,update,insert,readComments,insertComments,sessions,userInfo})`, `sharePages({queries,exact})`, `renameConnection({newName})`, `revealToken()`. The mutating tools act on the connection currently open: call `openConnection` first.

## Internal API (any workspace)

Use it when the official API token is not enough. A token is bound to one workspace. The internal API runs as the signed-in user, so it reaches every workspace that user belongs to.

It is a same-origin `fetch("/api/v3/<endpoint>", {method:"POST", headers:{"content-type":"application/json"}, body})` evaluated in a logged-in app.notion.com tab. The tools live in `tools/workspace.mjs`: `list_spaces`, `get_records`, `query_collection`, `save_transaction`. Each call re-pins the session to an app.notion.com tab and opens one if none exists.

Endpoints proven: `getSpaces`, `syncRecordValuesSpace`, `queryCollection`, `search` (type `BlocksInSpace`), `saveTransactionsFanout`. Records come back as `{value:{value:{...},role}}`. Errors come back as `{isNotionError:true, debugMessage}`.

### Gotchas

- **Top-level pages need permissions.** The FIRST `set` op of a page with `parent_table:"space"` must carry `permissions` (a `user_permission` with role `editor` per user). Without it the page is a role-none orphan that nobody can edit again, the creator included. `save_transaction` refuses this before sending.
- **Collection schema edits are rejected.** A raw `set` on a schema fails with "Collection schema updates must use high-level schema operations". Add data in the existing properties instead.
- **Automation records reject status "paused".** Use `alive:false` and bump `last_edited_time`.
- **Personal-plan workspaces.** Other people are page guests there. `removeUsersFromSpace` does nothing. Strip access with `setPermissionItem` and role `none`.
- **The REPL is shared across sessions.** Another session can switch the active tab between your calls. Pin the target inside every call. The tools do this; do the same in any hand-written snippet.
- **One bare expression per snippet.** A multi-statement REPL snippet runs but prints nothing. Print a single expression.

## Pages and databases (`tools/pages.mjs`)

`readCollection({pageId, spaceId?, limit?})`: schema `[{name,type}]` and rows as `{_id, <property name>: plain value}`. Read-only.
`createPage({spaceId, parentAfter?, title, blocks, editors})`: a top-level page plus blocks in one transaction. `blocks` is `[[type, text]]`, or `["table", [[cell,...],...]]` with the first row as header. `editors` is required.
`recreateRows({pageId, spaceId?, changes:[{rowId, set:{Property: value}}], dryRun?})`: row property updates. Take `rowId` from `readCollection` `_id`. A value is a string or a raw rich-text array: people `[["‣",[["u",id]]]]`, date `[["‣",[["d",{type:"date",start_date:"2026-01-31"}]]]]`.
`pagePropertyHistory({pageId, limit?})`: who changed which property and when, newest first, as `[{time, type, authors[name|id], changes[{prop,before,after}]}]`. Read-only. It uses `syncRecordValues` (block, for `space_id`) then `getActivityLog`; `last_edited_by` on the public API is overwritten by an automation actor, the activity log keeps the real author. Bot authors (integrations, automations) are not in `notion_user`, so they stay raw ids. Property keys are short ids; the parent collection schema maps them to names. Called as a node tool, the whole script runs inside one `Runtime.evaluate`, so the CLI-argument trap does not apply. A hand snippet passed as a CLI argument with a semicolon in it is dropped and prints nothing: base64 it and run `eval(atob("..."))` as the one expression.

### More gotchas

- **Rows cannot be updated in place.** A `set` on `["properties", key]` fails with "Block property value updates must use high-level property operations". `recreateRows` writes a NEW row with the merged properties and sets the old row `alive:false`. The row id changes, child content under the old row stays behind it.
- **Orphan pages.** `createPage` throws without `editors`. Same rule as `save_transaction`: the first `set` of a `parent_table:"space"` page carries `permissions`.
- **Return plain JSON built in-page.** The REPL can print nothing for values derived from `fetch`, even a returned string; stash the JSON on `globalThis` and read it in a second call. The tools do all fetches inside one `Runtime.evaluate` and return a plain object; a hand snippet should end in one `JSON.stringify(...)` expression.
- **Pin inside each call.** The REPL is shared across sessions, so another session can switch the active tab between calls. Every tool calls `pin` first.
- **Navigation wipes in-page globals.** Nothing is cached on `window`; each tool rebuilds its helpers per call, so a reload mid-task is safe.
- **Raw collection schema edits are rejected** ("Collection schema updates must use high-level schema operations"). Write into existing properties.
- **Bring no ids into the learning.** Workspace, user and page ids are always arguments. `readCollection` finds the workspace from `pageId` when `spaceId` is omitted. A wrong `spaceId` makes Notion error ("Cross-cell memcached access is not allowed") instead of returning null.
