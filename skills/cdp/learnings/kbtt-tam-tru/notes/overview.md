# kbtt-tam-tru (tbltkbtt.bocongan.gov.vn)

The Bộ Công an portal where a lodging facility declares a foreigner's temporary residence (khai báo tạm trú). Notes only: no node or browser tools. Drive it with plain `session` calls. The old host kbtt.xuatnhapcanh.gov.vn redirects here. The unified site went live on 2026-05-21. Old accounts keep their username, now with a province prefix such as `hcm_`.

The site is a Vue 3 + Ant Design Vue SPA. Facts below were verified live on 2026-10-31.

## Login

- Fields: username, password, a 6-digit image captcha, then a Google Authenticator TOTP code.
- The captcha is a `data:image/png` img, 240x100. Read it visually.
- A new account gets a 3-step setup wizard on first login. Step 2 shows only a QR, with no text key.
- Decode the QR in the page: `new BarcodeDetector({formats:['qr_code']}).detect(img)`. The result holds the `otpauth` URI.
- Store that URI in the password manager at once. Never print it or log it.

## Routes

| Path | Use |
| --- | --- |
| `/auth/login`, `/auth/register` | sign in, sign up |
| `/temporary-residence-declaration-management/temporary-residence-declaration` | the declare form |
| `.../history-declare-manager` | history and print |
| `.../foreign-temp-stay-manager` | current stays; buttons Gia hạn, Checkout/Trả phòng, Thêm mới, Tải file lên |
| `.../branch` and `.../branch/form-modal` | branches (chi nhánh) |
| `/settings/profile-settings/profile` | facility info, read-only text |

## Account model

- One account is ONE facility (cơ sở lưu trú). Its declarations go to that facility's ward police.
- A second property needs a branch. File from the branch's own login. Each branch has its own login and its own TOTP.
- The main login has no branch selector on the declare form. Check the facility name at the top right before you file.
- Facility types include "Nhà dân không kinh doanh" and "Chung cư". For those, the ANTT certificate fields are optional.

## Declare form

Field ids:

- `form_item_anhHoChieu`: passport photo upload. OCR fills passport number, nationality, name, DOB and sex. It takes 15 to 25 seconds.
- `form_item_soHoChieu`, `form_item_hoTen`, `form_item_ngayThangNamSinh`, `form_item_gioiTinh`.
- `form_item_quocTich`: antd select. Search with a short code such as "IND".
- `form_item_ngayDenCslt`: arrival date. The picker disables every day before yesterday, so backdating is impossible.
- `form_item_ngayDiDuKien`: planned end of stay.
- `form_item_soPhong`: room. A hidden duplicate input has the same id. Target the visible one.
- `form_item_thoiHanTamTru`: permitted stay end. Use the visa or TRC expiry.
- `form_item_assure`: checkbox, pre-checked.

## Gotchas

- **Date pickers ignore native-setter writes.** Focus the input, type with trusted `Input.insertText`, then press Enter with `Input.dispatchKeyEvent`.
- **Antd selects need a trusted mouse click** on `.ant-select-selector`. The dropdown sometimes needs a second click.
- **"Thêm hồ sơ khác" (add another profile) is unreliable.** It kept answering "Vui lòng nhập đủ thông tin" even when every field showed a value. Save each person alone with "Lưu thông tin". That works and says "Khai báo tạm trú thành công".
- **Status starts "Chưa xác nhận".** Per the portal FAQ, the facility's duty ends at a successful declaration. The ward confirms. Re-enter only on "Từ chối" or "Xác minh lại".
- **A floating support widget** (class `floating-support`, position fixed) covers modal OK buttons near the bottom right. Hide it, or press the button by keyboard.
- **Locked Mac screen.** Every tab reports `visibilityState` hidden. Modals, hover menus and pickers stay dead. Fix it with `Emulation.setFocusEmulationEnabled({enabled:true})` on the target.
- **Background tabs throttle `setTimeout`.** Never await an in-page sleep. Split click and read into separate evaluate calls.

- **History filters default to yesterday and today.** Older rows show "Trống" until you widen "Ngày bắt đầu". In the open range picker, a JS `.click()` on `td[title="YYYY-MM-DD"] .ant-picker-cell-inner` picks a date reliably. Click the start, then the end, then "Tìm kiếm".
- **The extension relay cannot attach to this site's tabs.** It fails with "Cannot access a chrome-extension:// URL of different extension". Use a separate `new Session()` connected to the remote-debugging `wsUrl`.
- **A confirmed row reads "Đã xác nhận".** Its printout then adds "Ngày xác nhận".

## Print

The history row's printer button opens a modal "XEM TRƯỚC". It holds a `blob:` iframe with a 1-page PDF. Run `fetch(iframe.src)` in the page and base64 the bytes out. The PDF shows the facility address and ward. Check it before you hand it to anyone.

## Branch map picker

The branch form has "Vị trí trên bản đồ", a Leaflet map. Its search box returns nothing. Pan and zoom with trusted mouse events, then click to drop the pin. OK fills `form_item_toaDo` with "lat,lng".

## Privacy

Declarations hold passport data and a home address. Keep all of it out of repos. Credentials and the TOTP URI belong in the password manager only.
