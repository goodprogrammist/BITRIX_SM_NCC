// Shared code for background script, popup and options (Firefox + Chrome, Manifest V3).
// Bitrix _NCC cookie extension (the same structure as the Xdebug cookies extension by the same author).
// Firefox exposes `browser`, Chrome exposes `chrome` (both return promises in MV3).
const api = globalThis.browser || globalThis.chrome;
const LOG_PREFIX = '[NCC]';

// --- Safe access to WebExtension APIs ---
// Browsers support different sets of APIs (e.g. Firefox for Android has no windows and commands),
// so every API method and event is checked before use.

// Returns the API object or function by path ('tabs.getCurrent'), undefined if the browser has none
function getApi(path) {
    let node = api;
    for (let part of path.split('.')) {
        if (node === undefined || node === null) {
            return undefined;
        }
        node = node[part];
    }
    return node;
}

function hasApi(path) {
    return getApi(path) !== undefined;
}

// Calls an API method if the browser has it, otherwise returns fallback.
// The result is returned as is (usually a promise), so callers can await it in both cases.
function callApi(path, args, fallback) {
    let method = getApi(path);
    if (typeof method !== 'function') {
        log('API is not available:', path);
        return fallback;
    }
    return method.apply(getApi(path.split('.').slice(0, -1).join('.')), args || []);
}

// The same for APIs the action can't work without: throws an error that is shown to the user
function requireApi(path, args) {
    let method = getApi(path);
    if (typeof method !== 'function') {
        throw new Error('API is not available in this browser: ' + path);
    }
    return method.apply(getApi(path.split('.').slice(0, -1).join('.')), args || []);
}

// Subscribes to an API event if the browser has it, returns false otherwise
function addApiListener(path, listener) {
    let event = getApi(path);
    if (!event || typeof event.addListener !== 'function') {
        log('API event is not available:', path);
        return false;
    }
    event.addListener(listener);
    return true;
}

// firstPartyDomain exists only in Firefox, Chrome rejects unknown properties
const IS_FIREFOX = hasApi('runtime.getBrowserInfo');
// Settings are kept in storage.sync, or in storage.local if the browser has no sync storage
const SETTINGS_AREA = hasApi('storage.sync') ? 'sync' : 'local';

// Bitrix Composite: the cookie <prefix>_NCC=Y ("no composite cache") disables the composite cache.
// Bitrix main module (main/lib/Composite): Helper::getOptions() - COOKIE_NCC = cookie prefix
// (option "cookie_name", default BITRIX_SM) + "_NCC", saved in /bitrix/html_pages/.config.php;
// Responder::isValidRequest() - the cache is not used when $_COOKIE[COOKIE_NCC] === "Y".
// The list form is kept to share the code structure with the Xdebug cookies extension.
const TRIGGERS = [
    { id: 'ncc', label: 'NCC', badge: 'N', key: 'cookie_ncc', defaultName: 'BITRIX_SM_NCC', defaultValue: 'Y' }
];
const DEFAULT_ON_COLOR = 'red';
const DEFAULT_OFF_COLOR = 'light';
// Must match host_permissions in manifest.json
const SITE_ORIGINS = { origins: ['http://*/*', 'https://*/*'] };
// Localized string from _locales/*/messages.json, falls back to the key itself
function t(key, ...substitutions) {
    let message = callApi('i18n.getMessage', [key, substitutions.map(String)], '');
    if (!message) {
        console.warn(LOG_PREFIX, 'i18n: no message for', key);
        return key;
    }
    return message;
}

// Translates elements with data-i18n (text), data-i18n-placeholder and data-i18n-title attributes
function localizePage(root) {
    if (!root) {
        root = document;
        // Language of the translation actually used (stored in messages.json)
        document.documentElement.lang = t('langCode');
    }
    root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
}

// RFC 6265: cookie-name is a token, cookie-value has no spaces, quotes, commas, semicolons, backslashes
function isValidCookieName(name) {
    return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);
}

function isValidCookieValue(value) {
    return /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(value);
}

function log(...args) {
    console.debug(LOG_PREFIX, ...args);
}

function logError(...args) {
    console.error(LOG_PREFIX, ...args);
}

// Cookies can be managed only for regular web pages (not about:, chrome:, file:, moz-extension: etc.)
function isSupportedUrl(url) {
    return /^https?:\/\//i.test(url || '');
}

async function hasHostPermission() {
    try {
        // Without the permissions API host permissions are granted at install time
        return await callApi('permissions.contains', [SITE_ORIGINS], true);
    } catch (e) {
        logError('permissions.contains failed', e);
        return false;
    }
}

// Must be called from a user action handler (click)
async function requestHostPermission() {
    let granted = await requireApi('permissions.request', [SITE_ORIGINS]);
    log('host permission granted:', granted);
    return granted;
}

// Returns [{...trigger, name, value, siteName}] with values from settings.
// host - apply the per-site cookie name (sites may use different cookie prefixes), siteName is true then.
async function getTriggerSettings(host) {
    let keys = [];
    for (let trigger of TRIGGERS) {
        keys.push(trigger.key, trigger.key + '_value');
    }
    let config = await callApi('storage.' + SETTINGS_AREA + '.get', [keys], {});
    let siteName = host ? await getSiteCookieName(host) : '';

    return TRIGGERS.map(trigger => {
        let name = config[trigger.key] || '';
        // Version 0.1 saved the placeholder "?????_NCC" when the name was not filled in
        if (!isValidCookieName(name)) {
            if (name) {
                log('stored cookie name is not valid, the default is used:', name);
            }
            name = trigger.defaultName;
        }
        return Object.assign({}, trigger, {
            label: t('trigger_' + trigger.id),
            name: siteName || name,
            globalName: name,
            // Bitrix checks the value strictly: === "Y"
            value: trigger.defaultValue,
            siteName: !!siteName
        });
    });
}

// Cookie name for a site, overrides the global one ('' - use global)
async function getSiteCookieName(host) {
    let key = 'name:' + host;
    let data = await callApi('storage.local.get', [key], {});
    return data[key] || '';
}

async function setSiteCookieName(host, name) {
    let key = 'name:' + host;
    if (name) {
        await callApi('storage.local.set', [{ [key]: name }]);
    } else {
        await callApi('storage.local.remove', [key]);
    }
    log('cookie name for', host, '=', name || '(global)');
}

async function getColors() {
    // Storage keys are the same as in version 0.1
    let config = await callApi('storage.' + SETTINGS_AREA + '.get', [['cookie_ncc_on_color', 'cookie_ncc_off_color']], {});

    return {
        on: config.cookie_ncc_on_color || DEFAULT_ON_COLOR,
        off: config.cookie_ncc_off_color || DEFAULT_OFF_COLOR
    };
}

// Firefox: tab.cookieStoreId (containers, private windows).
// Chrome: no cookieStoreId in tabs, find the store that contains the tab ("0" - normal, "1" - incognito).
async function getStoreId(tab) {
    if (tab.cookieStoreId) {
        return tab.cookieStoreId;
    }
    let stores = await callApi('cookies.getAllCookieStores', [], []);
    for (let store of stores) {
        if (store.tabIds && store.tabIds.includes(tab.id)) {
            return store.id;
        }
    }
    log('getStoreId: store not found for tab', tab.id, 'using default');
    return undefined;
}

function getHost(url) {
    try {
        return new URL(url).hostname;
    } catch (e) {
        return '';
    }
}

// Domains the cookie can be set for: the host itself and its parent domains (at least 2 labels).
// Public suffixes (like co.uk) are rejected by the browser itself, the error is shown in popup.
function getDomainCandidates(host) {
    if (!host || host.indexOf('.') === -1 || /^[\d.]+$/.test(host) || host.indexOf(':') !== -1 || host.startsWith('[')) {
        return [];
    }
    let labels = host.split('.');
    let result = [];
    for (let i = 0; i <= labels.length - 2; i++) {
        result.push(labels.slice(i).join('.'));
    }
    return result;
}

// Scope is remembered per host: '' - host-only cookie, 'example.com' - cookie for .example.com and subdomains
async function getScope(host) {
    let key = 'scope:' + host;
    let data = await callApi('storage.local.get', [key], {});
    let scope = data[key] || '';
    if (scope && !getDomainCandidates(host).includes(scope)) {
        return '';
    }
    return scope;
}

async function setScope(host, scope) {
    let key = 'scope:' + host;
    if (scope) {
        await callApi('storage.local.set', [{ [key]: scope }]);
    } else {
        await callApi('storage.local.remove', [key]);
    }
    log('scope for', host, '=', scope || '(host only)');
}

async function getCookie(tab, trigger) {
    if (!tab || !isSupportedUrl(tab.url)) {
        return null;
    }

    let cookie = null;
    try {
        cookie = await requireApi('cookies.get', [{
            url: tab.url,
            name: trigger.name,
            storeId: await getStoreId(tab)
        }]);
    } catch (e) {
        logError('getCookie failed for', tab.url, trigger.name, e);
        return null;
    }

    if (cookie && cookie.value == trigger.value) {
        return cookie;
    }
    if (cookie) {
        log('getCookie: cookie', trigger.name, 'has unexpected value', cookie.value, 'expected', trigger.value);
    }

    return null;
}

// Returns {debug: cookie|null, profile: ..., trace: ...}
async function getStates(tab) {
    let triggers = await getTriggerSettings(getHost(tab.url));
    let states = {};
    for (let trigger of triggers) {
        states[trigger.id] = await getCookie(tab, trigger);
    }
    return states;
}

function cookieUrl(cookie) {
    return (cookie.secure ? 'https://' : 'http://') + cookie.domain.replace(/^\./, '') + cookie.path;
}

// --- Keeping the cookie ---
// Bitrix itself deletes the NCC cookie (Engine::onEpilog(): for anonymous visitors and for users
// of composite groups), so a cookie enabled by the user is set again when the server removes it.
// The mark is stored per cookie (store, domain, name) and removed when the user turns it off.
function keepKey(cookie) {
    return 'keep:' + cookie.storeId + '|' + cookie.domain + '|' + cookie.name;
}

async function setKeep(cookie, keep) {
    if (keep) {
        await callApi('storage.local.set', [{ [keepKey(cookie)]: true }]);
    } else {
        await callApi('storage.local.remove', [keepKey(cookie)]);
    }
}

async function isKept(cookie) {
    let data = await callApi('storage.local.get', [keepKey(cookie)], {});
    return !!data[keepKey(cookie)];
}

// Sets the removed cookie again with the same parameters
async function restoreCookie(cookie) {
    let details = {
        url: cookieUrl(cookie),
        name: cookie.name,
        value: cookie.value || 'Y',
        path: cookie.path,
        storeId: cookie.storeId
    };
    if (!cookie.hostOnly) {
        details.domain = cookie.domain;
    }
    if (IS_FIREFOX && cookie.firstPartyDomain) {
        details.firstPartyDomain = cookie.firstPartyDomain;
    }
    await requireApi('cookies.set', [details]);
    log('restored', cookie.name, 'for', details.url, 'store', cookie.storeId);
}

// URL of the page with ?ncc=1: Bitrix does not use the composite cache for such requests
// (Responder::isValidRequest()), it works even when nginx serves the cache without checking cookies
function nccUrl(url) {
    let result = new URL(url);
    result.searchParams.set('ncc', '1');
    return result.toString();
}

async function removeCookie(cookie) {
    let details = {
        url: cookieUrl(cookie),
        name: cookie.name,
        storeId: cookie.storeId
    };
    if (IS_FIREFOX && cookie.firstPartyDomain !== undefined) {
        details.firstPartyDomain = cookie.firstPartyDomain;
    }
    // Turned off by the user (or by the extension), the server's removals are restored
    await setKeep(cookie, false);
    await requireApi('cookies.remove', [details]);
    log('removed', cookie.name, 'for', details.url, 'store', cookie.storeId);
}

// Removes all cookies with this name that are sent to the tab url (host-only and domain ones)
async function disableTrigger(tab, trigger) {
    let query = {
        url: tab.url,
        name: trigger.name,
        storeId: await getStoreId(tab)
    };
    if (IS_FIREFOX) {
        query.firstPartyDomain = null;
    }
    let cookies = await requireApi('cookies.getAll', [query]);
    for (let cookie of cookies) {
        await removeCookie(cookie);
    }
}

async function enableTrigger(tab, trigger) {
    let host = getHost(tab.url);
    let scope = await getScope(host);
    let details = {
        url: tab.url,
        name: trigger.name,
        value: trigger.value,
        path: '/',
        storeId: await getStoreId(tab)
    };
    if (scope) {
        details.domain = scope;
    }
    let cookie = await requireApi('cookies.set', [details]);
    if (cookie) {
        await setKeep(cookie, true);
    }
    log('set', trigger.name + '=' + trigger.value, 'for', scope ? '.' + scope : host, 'store', details.storeId);
}

// Returns new state (true - enabled). Throws on API errors.
async function toggleTrigger(tab, triggerId) {
    if (!tab || !isSupportedUrl(tab.url)) {
        log('toggleTrigger: skipped, unsupported url', tab && tab.url);
        return false;
    }
    let triggers = await getTriggerSettings(getHost(tab.url));
    let trigger = triggers.find(t => t.id === triggerId);
    if (await getCookie(tab, trigger)) {
        await disableTrigger(tab, trigger);
        return false;
    }
    await enableTrigger(tab, trigger);
    return true;
}

// Re-sets enabled cookies after scope change.
// triggerIds - triggers to (re)enable, by default the currently enabled ones.
async function reapplyTriggers(tab, triggerIds) {
    let triggers = await getTriggerSettings(getHost(tab.url));
    for (let trigger of triggers) {
        let enabled = triggerIds ? triggerIds.includes(trigger.id) : !!await getCookie(tab, trigger);
        if (enabled) {
            await disableTrigger(tab, trigger);
            await enableTrigger(tab, trigger);
        }
    }
}

async function getActiveTab() {
    let tabs = await callApi('tabs.query', [{ active: true, currentWindow: true }], []);
    // Firefox for Android shows the popup as a page in its own tab: then the active tab is the
    // popup itself, and the site is the most recently used other tab
    let ownTab = typeof document !== 'undefined' ? await callApi('tabs.getCurrent', [], undefined) : undefined;
    if (ownTab && tabs[0] && tabs[0].id === ownTab.id) {
        let others = (await callApi('tabs.query', [{}], [])).filter(tab => tab.id !== ownTab.id);
        others.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
        log('getActiveTab: popup is shown in a tab, using the last used tab', others[0] && others[0].url);
        return others[0];
    }
    return tabs[0];
}
