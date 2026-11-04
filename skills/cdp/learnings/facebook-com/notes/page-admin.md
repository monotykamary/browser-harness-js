# facebook.com (Page admin: bio, category, contact, images, username)

Hand-proven on the running Helium while rebranding a managed Page. No node-tool yet; these are the recipes.

## Act as the Page first

- Open the Page URL. A "Switch" button sits in the left column. Click it, then click "Switch" again in the "Switch profiles" dialog. The session then acts as the Page across every tab.
- Switch back afterwards: the top-right "Account, your profile" avatar opens a dialog with "Switch to <member name>". Leaving the session as the Page means the member's next post goes out as the Page.
- Trusted `Input.dispatchMouseEvent` clicks work here, unlike the composer (see overview). Set `Emulation.setFocusEmulationEnabled({enabled: true})` on the target first.
- Target tabs by targetId, never by URL substring: Facebook rewrites URLs, and a substring match can hit another tab (a stray click landed on a group post that way).

## About tab edits (`?sk=about`)

- Section links sit in the left list: Intro, Category, Links, Contact info, Names.
- Bio: "Edit bio" opens a textarea; select all, `Input.insertText`, then the visible "Save".
- Category: "Edit categories" opens an input with chips. Type, pick the `[role=option]`, then click the chip's `aria-label="Remove  <name>"` (two spaces). Compare labels after `.trim()`.
- Email: find the "Edit" button nearest the email text by vertical distance; the input carries the old value.
- Social links: "Edit social links" lists one input per network with "Remove <network> username" buttons, then "Save".

## Images

- Profile picture: "Profile picture actions" -> "Choose profile picture" -> `DOM.setFileInputFiles` on the `input[type=file]` INSIDE the dialog (index 2 of 3 at the time) -> "Save" in the dialog. The dialog closes several seconds after the click.
- Cover: use the "Edit cover photo" button of about 163x36 px in the header. A second element with the same aria-label opens the photo viewer instead. Its menu offers "Upload photo"; set files on the first `input[type=file]` whose parent text is "Edit cover photo".
- After the upload the header shows "Save changes" and "Cancel" twice. Hit-test with `document.elementFromPoint` before clicking: the first rect found was Cancel.
- Both saves publish an automatic "updated their cover photo / profile picture" post.

## Username (vanity URL)

- It lives in a cross-origin-looking but same-origin iframe at `/settings/?tab=profile` (the "Page setup" settings tab). Read it through `iframe.contentDocument`.
- Click "Edit" on the Username row, type into `input[name=username]`, wait about 5 s for "Username is available".
- "Save changes" opens a "Please re-enter your password" dialog inside the iframe. That needs the member's password, so hand it to the human. The URL then serves at `facebook.com/<username>`.

## What did not work

- Deleting an old cover photo: the photo page's "Actions for this post" -> "Delete photo" -> "Delete" dialog accepted both trusted and DOM clicks three times, yet the photo stayed in the album. A human deleting it in the GUI worked at once. Verify by re-listing `media/set/?set=<album>` afterwards; never trust the closed dialog.
