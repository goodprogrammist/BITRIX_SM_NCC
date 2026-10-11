// End-to-end tests in Firefox via WebDriver (geckodriver): the built addon is installed as temporary.
// Run: npm run test:firefox (needs Firefox; geckodriver is found or downloaded by Selenium Manager)
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Builder, By } = require('selenium-webdriver');
const firefox = require('selenium-webdriver/firefox');
const { Select } = require('selenium-webdriver/lib/select');
const { SITE, OTHER_SITE, startServer, eventually } = require('./helpers');

const ADDON_ID = 'ncc_cookie_setup@goodprogrammist.ru';
// Fixed internal UUID, so extension pages have a known moz-extension:// URL
const ADDON_UUID = '3e0c1f0a-6b1d-4a52-9d6c-7a5b0f1c2d3e';
const BASE = `moz-extension://${ADDON_UUID}/`;

function findPackage() {
    const dir = path.resolve(__dirname, '..', 'web-ext-artifacts');
    const zip = fs.readdirSync(dir).find(f => f.endsWith('.zip'));
    assert.ok(zip, 'run `npm run build` first');
    return path.join(dir, zip);
}

describe('Firefox', () => {
    let server, driver, siteHandle, popupHandle, siteTabId;

    // Calls a function of the extension page by its path (e.g. 'browser.tabs.query') with JSON arguments.
    // The current tab must be an extension page. CSP of extension pages forbids eval/new Function,
    // so only existing functions are called.
    async function inExtension(fnPath, ...args) {
        const json = await driver.executeAsyncScript(`
            const done = arguments[arguments.length - 1];
            const win = window.wrappedJSObject || window;
            const parts = arguments[0].split('.');
            let context = win;
            for (const part of parts.slice(0, -1)) {
                context = context[part];
            }
            const fn = context[parts[parts.length - 1]];
            Promise.resolve(fn.apply(context, win.JSON.parse(arguments[1]))).then(
                r => done(win.JSON.stringify(r === undefined ? null : r)),
                e => done(JSON.stringify({ __error: String(e) }))
            );
        `, fnPath, JSON.stringify(args));
        const result = JSON.parse(json);
        if (result && result.__error) {
            throw new Error(fnPath + ': ' + result.__error);
        }
        return result;
    }

    async function sitePageText() {
        await driver.switchTo().window(siteHandle);
        await driver.navigate().refresh();
        const text = await driver.findElement(By.css('body')).getText();
        await driver.switchTo().window(popupHandle);
        return text;
    }

    async function openPopup(tabId = siteTabId) {
        await driver.switchTo().window(popupHandle);
        await openExtensionPage(`${BASE}popup.html?tabId=${tabId}`);
        await eventually(async () => {
            const rows = await driver.findElements(By.css('.trigger input'));
            assert.ok(rows.length > 0 || await isVisible('.unsupported'));
        });
    }

    // WebDriver can't navigate content to moz-extension:// URLs, so the page is loaded
    // from the browser (chrome) context with the system principal
    async function openExtensionPage(url) {
        await driver.setContext(firefox.Context.CHROME);
        // In the chrome context `window` is the browser window of the current WebDriver tab
        await driver.executeScript(`
            window.gBrowser.selectedBrowser.fixupAndLoadURIString(arguments[0], {
                triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
            });`, url);
        await driver.setContext(firefox.Context.CONTENT);
        await eventually(async () => assert.equal(await driver.getCurrentUrl(), url));
        await eventually(async () => assert.equal(await driver.executeScript('return document.readyState'), 'complete'));
    }

    async function isVisible(selector) {
        const elements = await driver.findElements(By.css(selector));
        return elements.length > 0 && await elements[0].isDisplayed();
    }

    const badge = () => inExtension('browser.action.getBadgeText', { tabId: siteTabId });
    const cookies = async name => (await inExtension('browser.cookies.getAll', { name: name, firstPartyDomain: null }))
        .map(c => c.domain + '=' + c.value);
    const select = async (selector, value) => {
        await new Select(await driver.findElement(By.css(selector))).selectByValue(value);
    };

    before(async () => {
        server = await startServer();
        const options = new firefox.Options()
            .addArguments('-headless')
            .setPreference('extensions.webextensions.uuids', JSON.stringify({ [ADDON_ID]: ADDON_UUID }))
            // Test hosts are resolved to 127.0.0.1
            .setPreference('network.dns.localDomains', 'app.example.co.uk,other.example.co.uk')
            .setPreference('dom.security.https_first', false)
            .setPreference('dom.security.https_first_schemeless', false)
            // Direct connection: test hosts must not go through a system proxy
            .setPreference('network.proxy.type', 0)
            // Containers for the container tab test
            .setPreference('privacy.userContext.enabled', true);
        // Custom Firefox / geckodriver, otherwise they are found by Selenium Manager
        if (process.env.FIREFOX_PATH) {
            options.setBinary(process.env.FIREFOX_PATH);
        }
        // --allow-system-access: needed for the chrome context used by openExtensionPage()
        const service = new firefox.ServiceBuilder(process.env.GECKODRIVER_PATH || undefined)
            .addArguments('--allow-system-access');
        driver = await new Builder().forBrowser('firefox')
            .setFirefoxOptions(options)
            .setFirefoxService(service)
            .build();
        const caps = await driver.getCapabilities();
        console.log('[test] Firefox', caps.get('browserVersion'));

        await driver.installAddon(findPackage(), true);
        // The addon opens its options (about:addons) after install and Firefox may reuse
        // the current blank tab for it, so the site is opened in a new tab after that
        await eventually(async () => {
            let found = false;
            for (const handle of await driver.getAllWindowHandles()) {
                await driver.switchTo().window(handle);
                found = found || (await driver.getCurrentUrl()).startsWith('about:addons');
            }
            assert.ok(found, 'options page is not opened yet');
        }, 10000);
        await driver.switchTo().newWindow('tab');
        siteHandle = await driver.getWindowHandle();
        await driver.get(SITE);
        await driver.switchTo().newWindow('tab');
        popupHandle = await driver.getWindowHandle();
        await openExtensionPage(BASE + 'options.html');
        siteTabId = await eventually(async () => {
            const tabs = await inExtension('browser.tabs.query', { url: 'http://app.example.co.uk/*' });
            assert.equal(tabs.length, 1);
            return tabs[0].id;
        });
        console.log('[test] site tab id', siteTabId);
        await openPopup();
    });

    after(async () => {
        if (driver) {
            await driver.quit();
        }
        server.close();
    });

    const title = () => inExtension('browser.action.getTitle', { tabId: siteTabId });

    async function goSite(url) {
        await driver.switchTo().window(siteHandle);
        await driver.get(url);
        const text = await driver.findElement(By.css('body')).getText();
        await driver.switchTo().window(popupHandle);
        return text;
    }

    it('runs as Firefox and has host permission', async () => {
        assert.equal((await inExtension('browser.runtime.getBrowserInfo')).name, 'Firefox');
        assert.equal(await inExtension('hasHostPermission'), true);
        assert.ok(!await isVisible('.no-permission'));
    });

    it('keyboard shortcut is assigned', async () => {
        const commands = await inExtension('browser.commands.getAll');
        const shortcuts = Object.fromEntries(commands.map(c => [c.name, c.shortcut]));
        console.log('[test] shortcuts', shortcuts);
        assert.equal(shortcuts['toggle-ncc'], 'Alt+Shift+Y');
    });

    it('shows the cookie', async () => {
        const rows = [];
        for (const el of await driver.findElements(By.css('.trigger'))) {
            rows.push((await el.getText()).replace(/\s+/g, ' ').trim());
        }
        assert.deepEqual(rows, ['Disable composite cache BITRIX_SM_NCC=Y']);
    });

    it('popup opened as a tab (as on Firefox for Android) works for the last used site tab', async () => {
        await driver.switchTo().window(siteHandle);
        await driver.switchTo().window(popupHandle);
        await openExtensionPage(BASE + 'popup.html');
        await eventually(async () => assert.equal(await driver.findElement(By.css('.host')).getText(), 'app.example.co.uk'));
        assert.ok(!await isVisible('.unsupported'));
        assert.equal((await driver.findElements(By.css('.trigger input'))).length, 1);
        await openPopup();
    });

    it('toggles the cookie, badge and title', async () => {
        await driver.findElement(By.css('.trigger input[data-trigger=ncc]')).click();
        await eventually(async () => assert.match(await sitePageText(), /BITRIX_SM_NCC=Y/));
        await eventually(async () => assert.equal(await badge(), 'N'));
        assert.equal(await title(), 'Composite cache disabled (BITRIX_SM_NCC)');
    });

    it('restores the cookie deleted by the server (as Bitrix does for anonymous visitors)', async () => {
        await goSite(SITE + 'epilog');
        await eventually(async () => assert.deepEqual(await cookies('BITRIX_SM_NCC'), ['app.example.co.uk=Y']));
        assert.match(await goSite(SITE), /BITRIX_SM_NCC=Y/);
    });

    it('sets cookie for parent domain', async () => {
        await openPopup();
        await select('.scope', 'example.co.uk');
        await eventually(async () => assert.deepEqual(await cookies('BITRIX_SM_NCC'), ['.example.co.uk=Y']));
        assert.match(await goSite(OTHER_SITE), /BITRIX_SM_NCC=Y/);
        // The domain cookie is restored too
        await goSite(OTHER_SITE + 'epilog');
        await eventually(async () => assert.deepEqual(await cookies('BITRIX_SM_NCC'), ['.example.co.uk=Y']));
        await goSite(SITE);
        await openPopup();
    });

    it('rolls back when the browser rejects public suffix domain', async () => {
        await select('.scope', 'co.uk');
        await eventually(async () => assert.ok(await isVisible('.error')));
        console.log('[test] error:', await driver.findElement(By.css('.error')).getText());
        assert.deepEqual(await cookies('BITRIX_SM_NCC'), ['.example.co.uk=Y']);
        await select('.scope', '');
        await eventually(async () => assert.deepEqual(await cookies('BITRIX_SM_NCC'), ['app.example.co.uk=Y']));
    });

    it('turned off by the user: not restored, the server deletion really works', async () => {
        await openPopup();
        await driver.findElement(By.css('.trigger input[data-trigger=ncc]')).click();
        await eventually(async () => assert.deepEqual(await cookies('BITRIX_SM_NCC'), []));
        await eventually(async () => assert.equal(await badge(), ''));
        assert.deepEqual(await inExtension('browser.storage.local.get', null), {}, 'no keep marks left');
        // Control: a cookie not turned on by the extension is deleted by the server response
        await inExtension('browser.cookies.set', { url: SITE, name: 'BITRIX_SM_NCC', value: 'Y', path: '/' });
        assert.match(await goSite(SITE), /BITRIX_SM_NCC=Y/);
        await goSite(SITE + 'epilog');
        assert.doesNotMatch(await goSite(SITE), /BITRIX_SM_NCC/);
        await eventually(async () => assert.deepEqual(await cookies('BITRIX_SM_NCC'), []));
    });

    it('per-site cookie name moves the enabled cookie', async () => {
        await openPopup();
        await driver.findElement(By.css('.trigger input[data-trigger=ncc]')).click();
        await eventually(async () => assert.match(await sitePageText(), /BITRIX_SM_NCC=Y/));
        await openPopup();
        await driver.findElement(By.css('.trigger-cookie')).click();
        assert.ok(await isVisible('.site-name'));
        const input = await driver.findElement(By.css('.site-name'));
        await input.sendKeys('SHOP_NCC');
        await driver.findElement(By.css('.site-name-row button[type=submit]')).click();
        await eventually(async () => {
            const text = await sitePageText();
            assert.match(text, /SHOP_NCC=Y/);
            assert.doesNotMatch(text, /BITRIX_SM_NCC/);
        });
        await eventually(async () => assert.equal(await title(), 'Composite cache disabled (SHOP_NCC)'));
        await goSite(SITE + 'epilog');
        await eventually(async () => assert.deepEqual(await cookies('SHOP_NCC'), ['app.example.co.uk=Y']));

        await openPopup();
        await eventually(async () => assert.ok(await isVisible('.site-name-reset')));
        await driver.findElement(By.css('.site-name-reset')).click();
        await eventually(async () => {
            const text = await sitePageText();
            assert.match(text, /BITRIX_SM_NCC=Y/);
            assert.doesNotMatch(text, /SHOP_NCC/);
        });
        await openPopup();
        await driver.findElement(By.css('.trigger input[data-trigger=ncc]')).click();
        await eventually(async () => assert.doesNotMatch(await sitePageText(), /NCC/));
    });

    it('options page: name of version 0.1 is shown as the default, a new name is saved', async () => {
        await inExtension('browser.storage.sync.set', { cookie_ncc: '?????_NCC' });
        await openExtensionPage(BASE + 'options.html');
        await eventually(async () => assert.equal(await driver.findElement(By.css('.cookie_ncc')).getAttribute('value'), 'BITRIX_SM_NCC'));
        const input = await driver.findElement(By.css('.cookie_ncc'));
        await input.clear();
        await input.sendKeys('MYPREFIX_NCC');
        await driver.findElement(By.css('button[type=submit]')).click();
        await eventually(async () => assert.equal((await inExtension('browser.storage.sync.get', 'cookie_ncc')).cookie_ncc, 'MYPREFIX_NCC'));
        await inExtension('browser.storage.sync.set', { cookie_ncc: '' });
    });

    it('opens the page with ?ncc=1', async () => {
        await goSite(SITE);
        await openPopup();
        await driver.findElement(By.css('.open-ncc')).click();
        await driver.switchTo().window(siteHandle);
        try {
            await eventually(async () => assert.equal(await driver.getCurrentUrl(), SITE + '?ncc=1'));
            await eventually(async () => assert.match(await driver.findElement(By.css('body')).getText(), /url=\/\?ncc=1/));
        } finally {
            // Next tests load extension pages into the current tab, it must not be the site tab
            await driver.switchTo().window(popupHandle);
        }
    });

    // Opens a tab from the browser (chrome) context: in a container or in a new private window
    async function openSpecialTab(url, kind) {
        await driver.setContext(firefox.Context.CHROME);
        await driver.executeScript(`
            const principal = Services.scriptSecurityManager.getSystemPrincipal();
            if (arguments[1] === 'private') {
                const privateWin = window.OpenBrowserWindow({ private: true });
                // The window is ready for navigation only after its delayed startup,
                // otherwise the initial about:privatebrowsing page may replace the site
                privateWin.addEventListener('load', () => {
                    privateWin.delayedStartupPromise.then(() => {
                        privateWin.gBrowser.selectedBrowser.fixupAndLoadURIString(arguments[0], { triggeringPrincipal: principal });
                    });
                }, { once: true });
            } else {
                window.gBrowser.addTab(arguments[0], { userContextId: 1, triggeringPrincipal: principal });
            }`, url, kind);
        await driver.setContext(firefox.Context.CONTENT);
    }

    it('works in a container tab (own cookie store), restore stays in the container', async () => {
        await openSpecialTab(SITE, 'container');
        await openExtensionPage(BASE + 'options.html');
        const tab = await eventually(async () => {
            const tabs = await inExtension('browser.tabs.query', { cookieStoreId: 'firefox-container-1' });
            assert.equal(tabs.length, 1);
            assert.equal(tabs[0].status, 'complete');
            return tabs[0];
        }, 10000);
        await openPopup(tab.id);
        await driver.findElement(By.css('.trigger input[data-trigger=ncc]')).click();
        const inStore = async storeId => (await inExtension('browser.cookies.getAll',
            { name: 'BITRIX_SM_NCC', storeId: storeId, firstPartyDomain: null })).length;
        await eventually(async () => assert.equal(await inStore('firefox-container-1'), 1));
        assert.equal(await inStore('firefox-default'), 0, 'cookie must not leak to the default store');
        await inExtension('browser.tabs.update', tab.id, { url: SITE + 'epilog' });
        await eventually(async () => assert.equal((await inExtension('browser.tabs.get', tab.id)).url, SITE + 'epilog'));
        await eventually(async () => assert.equal(await inStore('firefox-container-1'), 1));
        assert.equal(await inStore('firefox-default'), 0, 'restored cookie must not leak to the default store');
        await openPopup(tab.id);
        await driver.findElement(By.css('.trigger input[data-trigger=ncc]')).click();
        await eventually(async () => assert.equal(await inStore('firefox-container-1'), 0));
        await inExtension('browser.tabs.remove', tab.id);
    });

    // Same as the user switch "Run in Private Windows" in about:addons: permission + addon reload
    async function allowInPrivateWindows() {
        await driver.setContext(firefox.Context.CHROME);
        await driver.executeAsyncScript(`
            const done = arguments[arguments.length - 1];
            const { ExtensionPermissions } = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
            const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
            ExtensionPermissions.add(arguments[0], { permissions: ['internal:privateBrowsingAllowed'], origins: [] })
                .then(() => AddonManager.getAddonByID(arguments[0]))
                .then(addon => addon.reload())
                .then(() => done('ok'), e => done(String(e)));`, ADDON_ID);
        await driver.setContext(firefox.Context.CONTENT);
    }

    it('is not active in private windows until the user allows it', async () => {
        await openSpecialTab(SITE, 'private');
        await openExtensionPage(BASE + 'options.html');
        // Wait until the private tab exists for the browser, then make sure the addon does not see it
        await new Promise(resolve => setTimeout(resolve, 2000));
        assert.equal((await inExtension('browser.tabs.query', { cookieStoreId: 'firefox-private' })).length, 0);
        assert.equal(await inExtension('browser.extension.isAllowedIncognitoAccess'), false);
    });

    it('works in a private window when allowed', async () => {
        await allowInPrivateWindows();
        // The reload closes extension pages, including the tab used for them
        await driver.switchTo().window(siteHandle);
        await driver.switchTo().newWindow('tab');
        popupHandle = await driver.getWindowHandle();
        await eventually(async () => {
            await openExtensionPage(BASE + 'options.html');
            assert.equal(await inExtension('hasHostPermission'), true);
        }, 10000);
        assert.equal(await inExtension('browser.extension.isAllowedIncognitoAccess'), true);
        await openExtensionPage(BASE + 'options.html');
        // Right after the addon reload the page may still be initializing, so the call is retried
        const before = await eventually(async () => {
            const tabs = await inExtension('browser.tabs.query', { cookieStoreId: 'firefox-private' });
            assert.ok(Array.isArray(tabs));
            return tabs;
        }, 10000);
        console.log('[test] private tabs opened before the permission, url:', before.map(t => t.url));
        // A private window opened after the permission is granted (the usual user flow)
        await openSpecialTab(SITE, 'private');
        await openExtensionPage(BASE + 'options.html');
        const tab = await eventually(async () => {
            const tabs = (await inExtension('browser.tabs.query', { cookieStoreId: 'firefox-private' }))
                .filter(t => t.url === SITE && t.status === 'complete');
            // Both private windows (opened before and after the permission) show the site
            assert.equal(tabs.length, 2);
            return tabs[1];
        }, 10000);
        assert.equal(tab.incognito, true);
        await openPopup(tab.id);
        await driver.findElement(By.css('.trigger input[data-trigger=ncc]')).click();
        const inStore = async storeId => (await inExtension('browser.cookies.getAll',
            { name: 'BITRIX_SM_NCC', storeId: storeId, firstPartyDomain: null })).length;
        await eventually(async () => assert.equal(await inStore('firefox-private'), 1));
        assert.equal(await inStore('firefox-default'), 0, 'cookie must not leak to the default store');
        await inExtension('browser.windows.remove', tab.windowId);
    });

    it('sets and removes cookie of an IPv6 host', async () => {
        await openExtensionPage(BASE + 'options.html');
        // Cookie API does not need a loaded page, the tab object is enough
        const fakeTab = { id: -1, url: 'http://[::1]:8765/' };
        assert.equal(await inExtension('toggleTrigger', fakeTab, 'ncc'), true);
        const list = async () => (await inExtension('browser.cookies.getAll',
            { name: 'BITRIX_SM_NCC', firstPartyDomain: null })).map(c => c.domain);
        console.log('[test] IPv6 cookie domain:', await list());
        assert.equal((await list()).length, 1);
        assert.equal(await inExtension('toggleTrigger', fakeTab, 'ncc'), false);
        assert.deepEqual(await list(), []);
    });

    it('shows unsupported message on browser pages', async () => {
        await driver.switchTo().window(siteHandle);
        await driver.get('about:blank');
        // The site tab now shows about:blank
        await openPopup(siteTabId);
        assert.ok(await isVisible('.unsupported'));
    });
});
