# accounts-delawareregisteredagent-com (A Registered Agent, Inc. client portal)

The client portal at `accounts.delawareregisteredagent.com` is an SPA. It has no scrape-friendly DOM, but it serves a JSON API under `/api/v3/client/`. Everything here is read-only GETs.

## Auth

- The portal is logged in through the browser's own cookies.
- `fetch(path, {credentials: "include"})` from a page on the portal origin works. No token in localStorage is needed.
- A new background tab opened straight to the portal can land on an auth redirect (`#state=...`). The tools reuse an already-open portal tab (found by URL host via `Target.getTargets`). Otherwise they open one and poll until the API answers 200.
- A 401/403 means the browser is logged out; sign in by hand, then retry.

## Endpoints

| GET | Returns |
|---|---|
| `/api/v3/client/client_documents?limit=200&offset=0` | `{success, timestamp, result:[...]}`. Each document: `id`, `title`, `type`, `company_id`, `company_name`, `pages` (array of page ids), `status`. |
| `/api/v3/client/client_documents/<docId>/page/<pageId>` | `{result:{url}}`: a short-lived presigned S3 link to a PNG of that page. |
| `/api/v3/client/companies?limit=500&offset=0` | The account's companies (name, id, entity type). |

Seen `type` values: `Initial Filing`, `State Compliance`, `BOI Initial`, `Filing Document`.

## Tools

```js
await learnings("accounts-delawareregisteredagent-com", "listDocuments")
await learnings("accounts-delawareregisteredagent-com", "pageUrls", { docId: "<docId>" })  // omit docId for all
await learnings("accounts-delawareregisteredagent-com", "listCompanies")
```

## Gotchas

- **A long async loop inside one `Runtime.evaluate` can make the CLI print nothing.** `pageUrls` starts the loop, stores the result on `window.__draPages`, and polls with short evaluates. Use the same pattern for any new bulk call.
- **The presigned URLs expire quickly.** Download right after `pageUrls` returns.
- **Documents are page images, not PDFs.** One PNG per page id; there is no text layer.

## Downloading and reading pages (the caller's job)

The S3 link works from any client, so download outside the browser. Do not send the portal cookies anywhere.

```python
import urllib.request
for d in urls:  # [{docId, title, i, url}] from pageUrls
    urllib.request.urlretrieve(d["url"], f"{OUT}/doc{d['docId']}-p{d['i']:02d}.png")
```

or `curl -sSo page.png "<url>"`.

OCR with tesseract by piping the bytes in: `tesseract stdin stdout < page.png`. In the sandbox this was written in, tesseract could not open files under /tmp by path, but stdin worked.

## Privacy

This repo is public. Keep company names, company/document ids, EINs, file numbers and emails out of notes, tests and commits. Use placeholders like `<companyId>` and `<docId>`.
