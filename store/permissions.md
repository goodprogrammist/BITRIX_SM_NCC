# Permission justifications (for store review forms)

**Single purpose:** toggle the 1C-Bitrix _NCC cookie (BITRIX_SM_NCC=Y) for the current site
to disable the Bitrix composite cache for the developer's own requests.

| Permission | Why it is needed |
|---|---|
| `cookies` | Set and remove the _NCC cookie for the current site; watch cookie changes to show the actual state on the toolbar icon and to set the cookie again when the site deletes it (Bitrix deletes it for anonymous visitors) while the user keeps it turned on. |
| `storage` | Save extension settings (cookie name, icon colors) and per-site choices (cookie domain, cookie name for the site). |
| Host permissions `http://*/*`, `https://*/*` | The cookies API works only for sites the extension has host permission for; the same permission gives the URL of the current tab (to know which site the cookie is for, to show the state on the toolbar icon and to reload the page with ?ncc=1). Developers work with arbitrary Bitrix sites (local, test and production domains), so the list of sites cannot be fixed in advance. Only http and https are requested. |
| Remote code | Not used. All code is in the package. |
| Data collection | None. |
