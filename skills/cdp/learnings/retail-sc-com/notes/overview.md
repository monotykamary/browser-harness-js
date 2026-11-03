# Standard Chartered SG online banking

Read-only access to Standard Chartered Singapore retail online banking (`retail.sc.com/sg/nfs/ibank/*`) through a CDP session: check the login state, list eStatements, download the PDFs. No transfer, payment or form-submit tool exists here on purpose.

```js
await learnings("retail-sc-com", "status")                                      // -> { state, path, loggedIn }
await learnings("retail-sc-com", "estatements")                                 // -> { count, rows:[{type, month, ...}] }
await learnings("retail-sc-com", "estatements", { dest: "/tmp/sc-statements" }) // -> { files:[{path, bytes, isPdf}] }
```

Log in by hand first (password plus OTP). Each call attaches to the already open `retail.sc.com` tab by explicit sessionId (`ctx.cdp`), never `session.use`, and detaches at the end. It never opens or closes a tab.

## The rule that matters: never navigate by URL

- Every in-app menu link is `javascript: blockUI(); window.location="<page>.htm?r=<session token>"`.
- Navigate by clicking the menu anchor in-page (find the `a` by `innerText`, call `.click()`).
- Never `Page.navigate` to a bare ibank URL. A direct navigation to `estatement_list_summary.htm` without the token dropped the session to `/sg/nfs/login.htm` and needed a fresh OTP login.
- The `?r=` token is a session secret. The tools report `location.pathname` only and never return a href.

## Pages

| Page | Path | Notes |
|---|---|---|
| Login | `/sg/nfs/login.htm` | `status` reports `loggedIn: false` here |
| Mailbox | `/sg/nfs/ibank/mailbox_list.htm` | reached from the menu |
| eStatements & eAdvices | `/sg/nfs/ibank/estatement_list_summary.htm` | the `estatements` tool lives here |
| Help & Services | `www.sc.com/retail/sg/service-requests/` | a separate SPA with CREATE REQUEST and STATUS tabs; status shows the last 90 days only |

## eStatements

- Each row carries a `View PDF` anchor: `estatement_download_pdf.htm?estatementSelectIndex=N&documentType=0&a=doDownloadLatestPDFviaKong&r=<token>`.
- The endpoint answers `application/octet-stream`. An in-page `fetch(href, {credentials: "include"})` works while logged in, so the tool pulls each PDF as base64 into node and writes `<type>-<month>.pdf` (names sanitized, a duplicate gets the select index appended).
- The result lists path, byte count and whether the file starts with `%PDF-`. A false `isPdf` usually means the session expired and the body is an HTML login page.
- The row layout (which cell holds the statement type, which the month) is inferred from the row's `td` cells plus a month pattern. Listing without `dest` returns the raw `cells` and `rowText`, so a layout change is visible before any download.

## Limits

- **No balance-confirmation letter in the portal.** That is a service request on the Help & Services SPA, not a download.
- **Session is fragile.** Idle timeout and any URL navigation end it. Re-login needs OTP, which no tool can supply.
- **Output is bank content.** Log counts and byte sizes, not statement text. Keep downloaded PDFs out of any repo.
- **Edit then restart.** The REPL caches imported modules; run `browser-harness-js --restart` after editing the tool, then reconnect.

## Provenance

Scaffolded with `browser-cdp learn new retail-sc-com --domains retail.sc.com`. Page paths, the menu-link shape, the PDF href pattern and the content type were observed on a live session. The tool code is syntax-checked and dry-run against a fake session. Its row parser was checked against the observed row shape (type cell, `dd/mm/yyyy` date cell, `View PDF`, `View`), not yet run end to end against the live bank.
