// Background script and shared code without a browser: reduced environments (Firefox for Android),
// API helpers, settings migration and restoring the cookie removed by the server.
// Firefox for Android has no windows and commands APIs (@mdn/browser-compat-data:
// webextensions.api.windows / commands - firefox_android: false), other browsers may lack other APIs.
// Run: node --test tests/unit.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function event(name, registered) {
    return { addListener: () => registered.push(name) };
}

// Loads common.js (+ background.js) into a sandbox with the given `browser` object
function load(browser, files) {
    const errors = [];
    const context = vm.createContext({
        browser: browser,
        console: { debug: () => {}, warn: () => {}, error: (...args) => errors.push(args.map(String).join(' ')) },
        URL: URL
    });
    context.globalThis = context;
    for (const file of files) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file });
    }
    return { context, errors };
}

// Simple storage area: get(null | key | [keys]), set, remove
function storageArea(data) {
    return {
        data: data,
        get: async keys => {
            if (keys === null) {
                return Object.assign({}, data);
            }
            const result = {};
            for (const key of [].concat(keys)) {
                if (key in data) {
                    result[key] = data[key];
                }
            }
            return result;
        },
        set: async items => { Object.assign(data, items); },
        remove: async keys => { for (const key of [].concat(keys)) delete data[key]; }
    };
}

// Firefox for Android: everything except windows and commands
function androidBrowser(registered, calls) {
    return {
        runtime: { getBrowserInfo: async () => ({ name: 'Firefox' }), onInstalled: event('runtime.onInstalled', registered), openOptionsPage: async () => {} },
        i18n: { getMessage: key => key },
        tabs: { query: async () => [], get: async () => ({}), onUpdated: event('tabs.onUpdated', registered), onActivated: event('tabs.onActivated', registered) },
        cookies: { onChanged: event('cookies.onChanged', registered), getAllCookieStores: async () => [], get: async () => null },
        storage: { onChanged: event('storage.onChanged', registered), sync: storageArea({}), local: storageArea({}) },
        permissions: { contains: async () => true, onAdded: event('permissions.onAdded', registered), onRemoved: event('permissions.onRemoved', registered) },
        action: {
            setIcon: async () => calls.push('setIcon'),
            setTitle: async () => calls.push('setTitle'),
            setBadgeText: async () => calls.push('setBadgeText'),
            setBadgeBackgroundColor: async () => calls.push('setBadgeBackgroundColor')
        }
    };
}

test('background script starts without windows and commands APIs (Firefox for Android)', async () => {
    const registered = [];
    const { errors } = load(androidBrowser(registered, []), ['common.js', 'background.js']);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(registered.sort(), [
        'cookies.onChanged', 'permissions.onAdded', 'permissions.onRemoved', 'runtime.onInstalled',
        'storage.onChanged', 'tabs.onActivated', 'tabs.onUpdated'
    ]);
    assert.deepEqual(errors, []);
});

test('icon is updated with a partial action API and without storage.sync and permissions', async () => {
    const registered = [];
    const calls = [];
    const browser = androidBrowser(registered, calls);
    delete browser.action.setBadgeBackgroundColor;
    delete browser.permissions;
    delete browser.storage.sync;
    let localGets = 0;
    const get = browser.storage.local.get;
    browser.storage.local.get = async keys => {
        localGets++;
        return get(keys);
    };
    const { context, errors } = load(browser, ['common.js', 'background.js']);
    // Top-level const is not a property of the context, so it is read by an expression
    assert.equal(vm.runInContext('SETTINGS_AREA', context), 'local', 'settings fall back to storage.local');
    await context.updateIcon({ id: 1, url: 'http://app.example.com/' });
    assert.deepEqual(calls, ['setIcon', 'setTitle', 'setBadgeText']);
    assert.ok(localGets > 0, 'settings are read from storage.local');
    assert.deepEqual(errors, []);
});

test('API helpers: getApi, hasApi, callApi, requireApi, addApiListener', () => {
    const registered = [];
    const browser = {
        runtime: {},
        tabs: { query: function (info) { return { self: this === browser.tabs, info: info }; }, onUpdated: event('tabs.onUpdated', registered) }
    };
    const { context } = load(browser, ['common.js']);
    assert.equal(context.hasApi('tabs.query'), true);
    assert.equal(context.hasApi('tabs.getCurrent'), false);
    assert.equal(context.hasApi('windows.onFocusChanged'), false);
    assert.equal(context.getApi('nothing.at.all'), undefined);
    // Method is called with its namespace as `this`
    assert.deepEqual(JSON.parse(JSON.stringify(context.callApi('tabs.query', [{ active: true }], 'fallback'))), { self: true, info: { active: true } });
    assert.equal(context.callApi('tabs.getCurrent', [], 'fallback'), 'fallback');
    assert.throws(() => context.requireApi('cookies.set', [{}]), /API is not available in this browser: cookies\.set/);
    assert.equal(context.addApiListener('tabs.onUpdated', () => {}), true);
    assert.equal(context.addApiListener('commands.onCommand', () => {}), false);
    assert.deepEqual(registered, ['tabs.onUpdated']);
    assert.equal(vm.runInContext('IS_FIREFOX', context), false);
});

test('toggle shows a clear error when the cookies API is missing', async () => {
    const browser = androidBrowser([], []);
    delete browser.cookies.set;
    const { context } = load(browser, ['common.js']);
    await assert.rejects(context.toggleTrigger({ id: 1, url: 'http://app.example.com/' }, 'ncc'), /API is not available in this browser: cookies\.set/);
});

test('settings: default name, placeholder of version 0.1, global and per-site names, value is always Y', async () => {
    const browser = androidBrowser([], []);
    const { context } = load(browser, ['common.js']);
    const settings = async host => JSON.parse(JSON.stringify((await context.getTriggerSettings(host))[0]));

    let s = await settings();
    assert.equal(s.name, 'BITRIX_SM_NCC');
    assert.equal(s.value, 'Y');
    assert.equal(s.siteName, false);

    // Version 0.1 saved "?????_NCC" when the name was left as is
    browser.storage.sync.data.cookie_ncc = '?????_NCC';
    browser.storage.sync.data.cookie_ncc_value = 'N';
    s = await settings();
    assert.equal(s.name, 'BITRIX_SM_NCC');
    assert.equal(s.globalName, 'BITRIX_SM_NCC');
    assert.equal(s.value, 'Y', 'Bitrix checks === "Y", other values are ignored');

    browser.storage.sync.data.cookie_ncc = 'MYPREFIX_NCC';
    await context.setSiteCookieName('shop.example.com', 'SHOP_NCC');
    assert.equal((await settings('app.example.com')).name, 'MYPREFIX_NCC');
    s = await settings('shop.example.com');
    assert.equal(s.name, 'SHOP_NCC');
    assert.equal(s.globalName, 'MYPREFIX_NCC');
    assert.equal(s.siteName, true);
    await context.setSiteCookieName('shop.example.com', '');
    assert.equal((await settings('shop.example.com')).name, 'MYPREFIX_NCC');
    assert.deepEqual(browser.storage.local.data, {});
});

test('NCC cookie name is detected from the Bitrix cookie prefix of the site', () => {
    const { context } = load(androidBrowser([], []), ['common.js']);
    const detect = names => context.nccNameFromCookieNames(names);
    assert.equal(detect(['PHPSESSID', 'ARGO_GUEST_ID', 'ARGO_LAST_VISIT', 'ARGO_SALE_UID', 'ARGO_kernel', 'ARGO_kernel_0']), 'ARGO_NCC');
    assert.equal(detect(['BITRIX_SM_GUEST_ID', 'BITRIX_SM_LOGIN']), 'BITRIX_SM_NCC');
    assert.equal(detect(['_ga', 'PHPSESSID', 'theme']), '');
    assert.equal(detect([]), '');
});

test('detected name is saved for the site unless the user chose one', async () => {
    const browser = androidBrowser([], []);
    const jar = ['PHPSESSID', 'ARGO_GUEST_ID', 'ARGO_SALE_UID'];
    browser.cookies.getAll = async () => jar.map(name => ({ name }));
    browser.cookies.getAllCookieStores = async () => [{ id: '0', tabIds: [1] }];
    const { context } = load(browser, ['common.js']);
    const tab = { id: 1, url: 'https://an.example.com/' };

    assert.equal(await context.autoDetectSiteName(tab), true);
    assert.equal((await context.getTriggerSettings('an.example.com'))[0].name, 'ARGO_NCC');
    assert.equal(await context.autoDetectSiteName(tab), false, 'already saved');

    await context.setSiteCookieName('an.example.com', '');
    browser.storage.sync.data.cookie_ncc = 'MY_NCC';
    assert.equal(await context.autoDetectSiteName(tab), false, 'global name chosen by the user');
});

test('nccUrl adds ncc=1 and keeps the rest of the url', () => {
    const { context } = load(androidBrowser([], []), ['common.js']);
    assert.equal(context.nccUrl('https://shop.example.com/catalog/'), 'https://shop.example.com/catalog/?ncc=1');
    assert.equal(context.nccUrl('https://shop.example.com/?a=1&ncc=0#top'), 'https://shop.example.com/?a=1&ncc=1#top');
});

// Background with cookies.set recorded; Firefox (getBrowserInfo) or Chrome
function restoreEnv(isFirefox) {
    const sets = [];
    const browser = androidBrowser([], []);
    if (!isFirefox) {
        delete browser.runtime.getBrowserInfo;
    }
    browser.cookies.set = async details => { sets.push(details); return details; };
    const { context, errors } = load(browser, ['common.js', 'background.js']);
    const cookie = { name: 'BITRIX_SM_NCC', value: 'Y', domain: 'app.example.com', path: '/', hostOnly: true, secure: false, storeId: '0' };
    return { browser, context, errors, sets, cookie };
}

for (const [browserName, isFirefox, serverCause] of [['Chrome', false, 'expired_overwrite'], ['Firefox', true, 'explicit']]) {
    test(browserName + ': cookie removed by the server is restored only when turned on by the user', async () => {
        const { context, errors, sets, cookie } = restoreEnv(isFirefox);
        // Not turned on by the extension: not restored
        await context.onCookieChanged({ removed: true, cause: serverCause, cookie: cookie });
        assert.equal(sets.length, 0);

        await context.setKeep(cookie, true);
        // Overwrite and eviction are not server removals
        await context.onCookieChanged({ removed: true, cause: 'overwrite', cookie: cookie });
        await context.onCookieChanged({ removed: true, cause: 'evicted', cookie: cookie });
        assert.equal(sets.length, 0);

        await context.onCookieChanged({ removed: true, cause: serverCause, cookie: cookie });
        assert.deepEqual(JSON.parse(JSON.stringify(sets)), [{ url: 'http://app.example.com/', name: 'BITRIX_SM_NCC', value: 'Y', path: '/', storeId: '0' }]);

        // Other cookies are ignored
        await context.onCookieChanged({ removed: true, cause: serverCause, cookie: Object.assign({}, cookie, { name: 'PHPSESSID' }) });
        assert.equal(sets.length, 1);
        assert.deepEqual(errors, []);
    });
}

test('Chrome: removal by the user (devtools, site data) is not restored', async () => {
    const { context, sets, cookie } = restoreEnv(false);
    await context.setKeep(cookie, true);
    await context.onCookieChanged({ removed: true, cause: 'explicit', cookie: cookie });
    assert.equal(sets.length, 0);
});

test('domain cookie is restored with its domain, per-site name is recognized', async () => {
    const { browser, context, sets, cookie } = restoreEnv(false);
    const domainCookie = Object.assign({}, cookie, { name: 'SHOP_NCC', domain: '.example.com', hostOnly: false, secure: true });
    browser.storage.local.data['name:shop.example.com'] = 'SHOP_NCC';
    await context.setKeep(domainCookie, true);
    await context.onCookieChanged({ removed: true, cause: 'expired_overwrite', cookie: domainCookie });
    assert.deepEqual(JSON.parse(JSON.stringify(sets)), [{
        url: 'https://example.com/', name: 'SHOP_NCC', value: 'Y', path: '/', storeId: '0', domain: '.example.com'
    }]);
});
