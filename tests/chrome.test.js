// End-to-end tests in Chromium: the unpacked addon is loaded into a real browser.
// Run: npm run test:chrome (CHROMIUM_PATH can point to a custom Chromium binary)
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { SITE, OTHER_SITE, startServer, eventually } = require('./helpers');

const EXT_DIR = path.resolve(__dirname, '..');

async function launch(lang, extraArgs) {
    const args = [
        `--disable-extensions-except=${EXT_DIR}`,
        `--load-extension=${EXT_DIR}`,
        '--host-resolver-rules=MAP * 127.0.0.1',
        // Extensions work only in the new headless mode
        '--headless=new'
    ];
    if (lang) {
        args.push('--lang=' + lang);
    }
    args.push(...(extraArgs || []));
    const context = await chromium.launchPersistentContext('', {
        executablePath: process.env.CHROMIUM_PATH || undefined,
        headless: false,
        ignoreDefaultArgs: ['--disable-extensions'],
        args: args,
        locale: lang || 'en-US'
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = worker.url().split('/')[2];
    console.log('[test] extension id', extensionId, 'lang', lang || 'default');
    // The addon opens options page after install: Chrome may reuse a fresh blank tab for it,
    // so tests open their pages only after that
    await eventually(() => assert.ok(context.pages().some(p => p.url().includes('options'))), 10000);
    return { context, worker, extensionId };
}

describe('Chromium', () => {
    let server, context, worker, extensionId, site, popup, siteTabId;
    const errors = [];

    const pageText = async (page = site) => {
        await page.reload();
        return page.textContent('body');
    };
    const badge = () => worker.evaluate(tabId => api.action.getBadgeText({ tabId }), siteTabId);
    const title = () => worker.evaluate(tabId => api.action.getTitle({ tabId }), siteTabId);
    const cookieDomains = name => worker.evaluate(n => api.cookies.getAll({ name: n }), name)
        .then(cookies => cookies.map(c => c.domain + '=' + c.value));
    const openPopup = async () => {
        await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${siteTabId}`);
        await popup.waitForSelector('.trigger input');
    };

    before(async () => {
        server = await startServer();
        ({ context, worker, extensionId } = await launch());
        site = await context.newPage();
        await site.goto(SITE);
        siteTabId = await worker.evaluate(async () => (await api.tabs.query({ url: 'http://app.example.co.uk/*' }))[0].id);
        popup = await context.newPage();
        popup.on('console', m => m.type() === 'error' && errors.push(m.text()));
        await openPopup();
    });

    after(async () => {
        console.log('[test] console errors:', errors);
        await context.close();
        server.close();
    });

    it('opens options page after install', async () => {
        const urls = context.pages().map(p => p.url());
        assert.ok(urls.some(u => u.includes('options')), 'pages: ' + urls.join(', '));
    });

    it('keyboard shortcut is assigned (not reserved by Chrome)', async () => {
        const commands = await worker.evaluate(() => api.commands.getAll());
        const shortcuts = Object.fromEntries(commands.map(c => [c.name, c.shortcut]));
        console.log('[test] shortcuts', shortcuts);
        assert.equal(shortcuts['toggle-ncc'], 'Alt+Shift+Y');
        assert.equal(shortcuts._execute_action, '');
    });

    it('has host permission and shows the cookie', async () => {
        assert.ok(await popup.isHidden('.no-permission'));
        const rows = await popup.$$eval('.trigger', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
        assert.deepEqual(rows, ['Disable composite cache BITRIX_SM_NCC=Y']);
        assert.equal(await title(), '_NCC cookie: off');
    });

    it('popup opened as a tab (as on Firefox for Android) works for the last used site tab', async () => {
        await site.bringToFront();
        const asTab = await context.newPage();
        await asTab.goto(`chrome-extension://${extensionId}/popup.html`);
        await eventually(async () => assert.equal(await asTab.textContent('.host'), 'app.example.co.uk'));
        await asTab.waitForSelector('.trigger input');
        assert.ok(await asTab.isHidden('.unsupported'));
        await asTab.close();
    });

    it('toggles the cookie, badge and title', async () => {
        await popup.check('.trigger input[data-trigger=ncc]');
        // Popup sets the cookie asynchronously after the click
        await eventually(async () => assert.match(await pageText(), /BITRIX_SM_NCC=Y/));
        await eventually(async () => assert.equal(await badge(), 'N'));
        assert.equal(await title(), 'Composite cache disabled (BITRIX_SM_NCC)');
    });

    it('restores the cookie deleted by the server (as Bitrix does for anonymous visitors)', async () => {
        await site.goto(SITE + 'epilog');
        await eventually(async () => assert.deepEqual(await cookieDomains('BITRIX_SM_NCC'), ['app.example.co.uk=Y']));
        await site.goto(SITE);
        assert.match(await site.textContent('body'), /BITRIX_SM_NCC=Y/);
        await eventually(async () => assert.equal(await badge(), 'N'));
    });

    it('sets cookie for parent domain and subdomains', async () => {
        await openPopup();
        await popup.selectOption('.scope', 'example.co.uk');
        await eventually(async () => assert.deepEqual(await cookieDomains('BITRIX_SM_NCC'), ['.example.co.uk=Y']));
        const other = await context.newPage();
        await other.goto(OTHER_SITE);
        assert.match(await other.textContent('body'), /BITRIX_SM_NCC=Y/);
        await other.close();
    });

    it('rolls back when the browser rejects public suffix domain', async () => {
        await popup.selectOption('.scope', 'co.uk');
        await eventually(async () => assert.notEqual(await popup.textContent('.error'), ''));
        assert.deepEqual(await cookieDomains('BITRIX_SM_NCC'), ['.example.co.uk=Y']);
        assert.equal(await popup.inputValue('.scope'), 'example.co.uk');
        await popup.selectOption('.scope', '');
        await eventually(async () => assert.deepEqual(await cookieDomains('BITRIX_SM_NCC'), ['app.example.co.uk=Y']));
    });

    it('turned off by the user: the server deletion is not restored', async () => {
        await openPopup();
        await popup.uncheck('.trigger input[data-trigger=ncc]');
        await eventually(async () => assert.deepEqual(await cookieDomains('BITRIX_SM_NCC'), []));
        await eventually(async () => assert.equal(await badge(), ''));
        assert.deepEqual(await worker.evaluate(() => api.storage.local.get(null)), {}, 'no keep marks left');
        // Control: a cookie not turned on by the extension is really deleted by the server response
        await worker.evaluate(() => api.cookies.set({ url: 'http://app.example.co.uk/', name: 'BITRIX_SM_NCC', value: 'Y', path: '/' }));
        await site.goto(SITE);
        assert.match(await site.textContent('body'), /BITRIX_SM_NCC=Y/);
        await site.goto(SITE + 'epilog');
        await site.goto(SITE);
        assert.doesNotMatch(await site.textContent('body'), /BITRIX_SM_NCC/);
        await eventually(async () => assert.deepEqual(await cookieDomains('BITRIX_SM_NCC'), []));
    });

    it('toggles the cookie by keyboard command', async () => {
        await site.bringToFront();
        await worker.evaluate(() => onCommand('toggle-ncc'));
        assert.match(await pageText(), /BITRIX_SM_NCC=Y/);
        await eventually(async () => assert.equal(await badge(), 'N'));
        await worker.evaluate(() => onCommand('toggle-ncc'));
        assert.doesNotMatch(await pageText(), /BITRIX_SM_NCC/);
    });

    it('per-site cookie name moves the enabled cookie', async () => {
        await openPopup();
        await popup.check('.trigger input[data-trigger=ncc]');
        await eventually(async () => assert.match(await pageText(), /BITRIX_SM_NCC=Y/));
        assert.ok(await popup.isHidden('.site-name-row'));
        await popup.click('.trigger-cookie');
        assert.ok(await popup.isVisible('.site-name-row'));
        assert.equal(await popup.getAttribute('.site-name', 'placeholder'), 'BITRIX_SM_NCC');

        await popup.fill('.site-name', 'bad name');
        await popup.click('.site-name-row button[type=submit]');
        await eventually(async () => assert.match(await popup.textContent('.error'), /"bad name"/));
        assert.equal(await worker.evaluate(() => getSiteCookieName('app.example.co.uk')), '');

        await popup.fill('.site-name', 'SHOP_NCC');
        await popup.click('.site-name-row button[type=submit]');
        await eventually(async () => {
            const text = await pageText();
            assert.match(text, /SHOP_NCC=Y/);
            assert.doesNotMatch(text, /BITRIX_SM_NCC/);
        });
        await popup.waitForSelector('.trigger-cookie');
        assert.equal(await popup.textContent('.trigger-cookie'), 'SHOP_NCC=Y - for this site');
        await eventually(async () => assert.equal(await title(), 'Composite cache disabled (SHOP_NCC)'));

        // The kept cookie with the site name is restored too
        await site.goto(SITE + 'epilog');
        await site.goto(SITE);
        await eventually(async () => assert.deepEqual(await cookieDomains('SHOP_NCC'), ['app.example.co.uk=Y']));

        // Other sites use the global name
        const other = await context.newPage();
        await other.goto(OTHER_SITE);
        const otherTabId = await worker.evaluate(async () => (await api.tabs.query({ url: 'http://other.example.co.uk/*' }))[0].id);
        await worker.evaluate(id => api.tabs.update(id, { active: true }), otherTabId);
        await worker.evaluate(() => onCommand('toggle-ncc'));
        await other.reload();
        assert.match(await other.textContent('body'), /BITRIX_SM_NCC=Y/);
        assert.doesNotMatch(await other.textContent('body'), /SHOP_NCC/);
        await worker.evaluate(() => onCommand('toggle-ncc'));
        await other.close();

        await openPopup();
        assert.ok(await popup.isVisible('.site-name-row'), 'stays open when the site name is set');
        await popup.click('.site-name-reset');
        await eventually(async () => {
            const text = await pageText();
            assert.match(text, /BITRIX_SM_NCC=Y/);
            assert.doesNotMatch(text, /SHOP_NCC/);
        });
        await popup.waitForSelector('.trigger input');
        await popup.uncheck('.trigger input[data-trigger=ncc]');
        await eventually(async () => assert.doesNotMatch(await pageText(), /NCC/));
    });

    it('options: name of version 0.1, invalid name, rename removes the old cookie', async () => {
        // Version 0.1 saved the placeholder "?????_NCC" when the name was left as is
        await worker.evaluate(() => api.storage.sync.set({ cookie_ncc: '?????_NCC', cookie_ncc_on_color: 'green', cookie_ncc_off_color: 'dark' }));
        const options = await context.newPage();
        options.on('console', m => m.type() === 'error' && errors.push('options: ' + m.text()));
        await options.goto(`chrome-extension://${extensionId}/options.html`);
        await eventually(async () => assert.equal(await options.inputValue('.cookie_ncc'), 'BITRIX_SM_NCC'));
        assert.ok(await options.isHidden('.permission-row'));
        assert.ok(await options.isChecked('.cookie-ncc-on-color[value=green]'));
        assert.ok(await options.isChecked('.cookie-ncc-off-color[value=dark]'));

        await openPopup();
        await popup.check('.trigger input[data-trigger=ncc]');
        await eventually(async () => assert.match(await pageText(), /BITRIX_SM_NCC=Y/));

        await options.fill('.cookie_ncc', 'BAD NAME');
        await options.click('button[type=submit]');
        await eventually(async () => assert.match(await options.textContent('.saved-error'), /"BAD NAME"/));
        assert.equal((await worker.evaluate(() => api.storage.sync.get('cookie_ncc'))).cookie_ncc, '?????_NCC');

        await options.fill('.cookie_ncc', 'MYPREFIX_NCC');
        await options.click('button[type=submit]');
        await eventually(async () => assert.ok(await options.isVisible('.saved-successfully')));
        // The old cookie is removed, otherwise it would keep the composite cache disabled
        await eventually(async () => assert.doesNotMatch(await pageText(), /BITRIX_SM_NCC/));
        await eventually(async () => assert.equal(await badge(), ''));

        await options.fill('.cookie_ncc', '');
        await options.click('button[type=submit]');
        await eventually(async () => assert.equal((await worker.evaluate(() => api.storage.sync.get('cookie_ncc'))).cookie_ncc, ''));
        await options.reload();
        await eventually(async () => assert.equal(await options.inputValue('.cookie_ncc'), 'BITRIX_SM_NCC'));
        await options.close();
    });

    it('opens the page with ?ncc=1', async () => {
        await openPopup();
        const closed = popup.waitForEvent('close').then(() => true);
        await popup.click('.open-ncc');
        await eventually(async () => assert.equal(site.url(), SITE + '?ncc=1'));
        await eventually(async () => assert.match(await site.textContent('body'), /url=\/\?ncc=1/));
        assert.equal(await closed, true, 'popup is closed');
        popup = await context.newPage();
        popup.on('console', m => m.type() === 'error' && errors.push(m.text()));
    });

    it('shows unsupported message on browser pages', async () => {
        // Without the "tabs" permission non-http tabs can't be found by URL, so the site tab is reused
        await site.goto('about:blank');
        await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${siteTabId}`);
        await eventually(async () => assert.ok(await popup.isVisible('.unsupported')));
        assert.ok(await popup.isHidden('.controls'));
    });

    it('has no unexpected console errors', () => {
        // The public suffix rejection is expected and logged by popup
        const unexpected = errors.filter(e => !e.includes('scope change failed'));
        assert.deepEqual(unexpected, []);
    });
});

for (const [lang, label, settingsLabel, titleStart] of [
    ['ru', 'Отключить композитный кеш', 'Настройки', 'Cookie _NCC: '],
    ['kk', 'Композиттік кэшті өшіру', 'Баптаулар', '_NCC cookie: ']
]) {
    describe('Chromium UI language: ' + lang, () => {
        let server, context, extensionId;

        before(async () => {
            server = await startServer();
            ({ context, extensionId } = await launch(lang));
        });

        after(async () => {
            await context.close();
            server.close();
        });

        it('popup and options are translated', async () => {
            const site = await context.newPage();
            await site.goto(SITE);
            const page = await context.newPage();
            const worker = context.serviceWorkers()[0];
            const tabId = await worker.evaluate(async () => (await api.tabs.query({ url: 'http://app.example.co.uk/*' }))[0].id);
            await page.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
            await page.waitForSelector('.trigger input');
            assert.equal(await page.textContent('.trigger-label'), label);
            assert.equal(await page.textContent('.open-options'), settingsLabel);
            assert.equal(await page.getAttribute('html', 'lang'), lang);
            await eventually(async () => {
                const title = await worker.evaluate(id => api.action.getTitle({ tabId: id }), tabId);
                console.log('[test]', lang, 'action title:', title);
                assert.ok(title.startsWith(titleStart), title);
            });
            await page.goto(`chrome-extension://${extensionId}/options.html`);
            assert.match(await page.textContent('.hint'), /\.config\.php/);
        });
    });
}

describe('Chromium incognito', () => {
    let server, context, extensionId;

    before(async () => {
        server = await startServer();
        // Incognito tries https:// first (HTTPS-First mode) and the http-only test server makes
        // the page load wait for that attempt; Playwright's own HttpsUpgrades switch is kept
        ({ context, extensionId } = await launch(undefined, ['--disable-features=HttpsUpgrades,HttpsFirstModeIncognito']));
    });

    after(async () => {
        await context.close();
        server.close();
    });

    it('works in incognito after the user allows it (own cookie store)', async () => {
        // Same switches as on chrome://extensions: developer mode (unpacked addon) and "Allow in Incognito"
        const page = await context.newPage();
        await page.goto('chrome://extensions/');
        const info = id => page.evaluate(i => new Promise(r => chrome.developerPrivate.getExtensionInfo(i, r)), id);
        assert.equal((await info(extensionId)).incognitoAccess.isActive, false, 'not allowed in incognito by default');
        await page.evaluate(() => new Promise(r => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, r)));
        await page.evaluate(id => new Promise(r => chrome.developerPrivate.updateExtensionConfiguration(
            { extensionId: id, incognitoAccess: true }, r)), extensionId);
        await eventually(async () => assert.equal((await info(extensionId)).state, 'ENABLED'), 10000);

        // The addon is reloaded, its functions are called from an extension page
        const extPage = await context.newPage();
        await eventually(() => extPage.goto(`chrome-extension://${extensionId}/options.html`), 10000);
        const result = await extPage.evaluate(async site => {
            const win = await api.windows.create({ incognito: true, url: site });
            let tab;
            for (let i = 0; i < 50; i++) {
                tab = (await api.tabs.query({ windowId: win.id }))[0];
                // A new window first reports "complete" for about:blank, so wait for the site itself
                if (tab.status === 'complete' && tab.url === site) {
                    break;
                }
                await new Promise(r => setTimeout(r, 200));
            }
            const count = async storeId => (await api.cookies.getAll({ name: 'BITRIX_SM_NCC', storeId: storeId })).length;
            const out = { incognito: tab.incognito, store: await getStoreId(tab) };
            out.enabled = await toggleTrigger(tab, 'ncc');
            out.inIncognito = await count('1');
            out.inNormal = await count('0');
            // The server deletes the cookie in the incognito store: it is restored there
            await api.tabs.update(tab.id, { url: site + 'epilog' });
            for (let i = 0; i < 50 && (await api.tabs.get(tab.id)).url !== site + 'epilog'; i++) {
                await new Promise(r => setTimeout(r, 100));
            }
            await new Promise(r => setTimeout(r, 1000));
            out.restored = await count('1');
            out.disabled = await toggleTrigger(tab, 'ncc');
            out.afterOff = await count('1');
            await api.windows.remove(win.id);
            return out;
        }, SITE);
        assert.deepEqual(result, { incognito: true, store: '1', enabled: true, inIncognito: 1, inNormal: 0, restored: 1, disabled: false, afterOff: 0 });
    });
});
