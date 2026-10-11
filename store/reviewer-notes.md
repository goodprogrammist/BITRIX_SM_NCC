# Notes for reviewers (AMO "Notes for Reviewers")

No account, server or build step is needed. The package contains plain, non-minified source files
(identical to https://github.com/goodprogrammist/BITRIX_SM_NCC).

How to test:
1. Open any http(s) site, e.g. https://example.com/.
2. Click the toolbar icon: the popup shows the "Disable composite cache" switch.
3. Turn it on: the cookie BITRIX_SM_NCC=Y is set for the site
   (visible in DevTools → Storage → Cookies), the icon gets the "N" badge.
4. Turn it off: the cookie is removed.
5. "Open without composite (?ncc=1)" reloads the current tab with the ?ncc=1 parameter.

1C-Bitrix sites do not use their composite (full page) cache for requests with this cookie.
Bitrix deletes the cookie for anonymous visitors, so while the user keeps the switch on, the extension
sets the cookie again when the site deletes it (cookies.onChanged).

Permissions: "cookies" and host permissions for http/https are needed to set and remove this cookie
for the current site; "storage" keeps the settings. The extension makes no network requests
and collects no data.
