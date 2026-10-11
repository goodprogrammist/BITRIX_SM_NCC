// Chrome runs background as a service worker (background.service_worker), shared code is loaded here.
// Firefox runs background.scripts (common.js is listed before this file in manifest).
if (typeof importScripts === 'function' && typeof TRIGGERS === 'undefined') {
    importScripts('common.js');
}

function getIcons(color) {
    return {
        "16": "icons/bug-" + color + "-16.png",
        "32": "icons/bug-" + color + "-32.png",
        "64": "icons/bug-" + color + "-64.png",
        "128": "icons/bug-" + color + "-128.png"
    };
}

// Calls for the same tab are serialized: otherwise a slow call with an old state
// may overwrite the icon after a newer one
const iconQueue = new Map();

function updateIcon(tab) {
    if (!tab) {
        log('updateIcon: no tab');
        return Promise.resolve();
    }
    let next = (iconQueue.get(tab.id) || Promise.resolve())
        .then(() => renderIcon(tab))
        .catch(e => logError('updateIcon failed', e));
    iconQueue.set(tab.id, next);
    next.then(() => {
        if (iconQueue.get(tab.id) === next) {
            iconQueue.delete(tab.id);
        }
    });
    return next;
}

async function renderIcon(tab) {
    if (!tab) {
        log('updateIcon: no tab');
        return;
    }

    let states = await getStates(tab);
    let triggers = await getTriggerSettings(getHost(tab.url));
    let colors = await getColors();
    let enabled = triggers.filter(t => states[t.id]);
    let badge = enabled.map(t => t.badge).join('');

    let title = enabled.length
        ? t('titleOn', enabled.map(trigger => trigger.name).join(', '))
        : t('titleOff');
    if (!isSupportedUrl(tab.url)) {
        title = t('titleUnavailable');
    } else if (!await hasHostPermission()) {
        title = t('titleNoPermission');
    }

    log('updateIcon: tab', tab.id, tab.url, 'enabled:', badge || '-');
    try {
        await callApi('action.setIcon', [{ path: getIcons(enabled.length ? colors.on : colors.off), tabId: tab.id }]);
        await callApi('action.setTitle', [{ title: title, tabId: tab.id }]);
        await callApi('action.setBadgeText', [{ text: badge, tabId: tab.id }]);
        await callApi('action.setBadgeBackgroundColor', [{ color: '#c0392b', tabId: tab.id }]);
    } catch (e) {
        // The tab may be closed between query and update
        logError('updateIcon failed', e);
    }
}

// Service worker has no persistent state, so active tabs are always queried
async function updateActiveTabs() {
    let tabs = await callApi('tabs.query', [{ active: true }], []);
    for (let tab of tabs) {
        await updateIcon(tab);
    }
}

// Removes cookies with the old name after it has been changed in options,
// otherwise they stay in the browser and keep the composite cache disabled.
async function removeCookiesByName(name, value) {
    let stores = await callApi('cookies.getAllCookieStores', [], []);
    for (let store of stores) {
        let query = { name: name, storeId: store.id };
        if (IS_FIREFOX) {
            query.firstPartyDomain = null;
        }
        let cookies = [];
        try {
            cookies = await requireApi('cookies.getAll', [query]);
        } catch (e) {
            logError('removeCookiesByName: getAll failed for store', store.id, e);
            continue;
        }
        for (let cookie of cookies) {
            if (cookie.value != value) {
                continue;
            }
            try {
                await removeCookie(cookie);
            } catch (e) {
                logError('removeCookiesByName: remove failed for', cookie.domain, e);
            }
        }
    }
}

async function onSettingsChanged(changes, area) {
    log('settings changed in', area, changes);
    if (area === SETTINGS_AREA) {
        let triggers = await getTriggerSettings();
        for (let trigger of TRIGGERS) {
            let nameChange = changes[trigger.key];
            let valueChange = changes[trigger.key + '_value'];
            if (!nameChange && !valueChange) {
                continue;
            }
            let current = triggers.find(t => t.id === trigger.id);
            // Empty/missing values mean defaults
            let oldName = nameChange ? nameChange.oldValue : current.globalName;
            // Empty or invalid (placeholder of version 0.1) name means the default one was used
            if (!oldName || !isValidCookieName(oldName)) {
                oldName = trigger.defaultName;
            }
            let oldValue = (valueChange ? valueChange.oldValue : current.value) || trigger.defaultValue;
            if (oldName !== current.globalName || oldValue !== current.value) {
                log('trigger', trigger.id, 'changed from', oldName + '=' + oldValue, 'to', current.globalName + '=' + current.value);
                await removeCookiesByName(oldName, oldValue);
            }
        }
    }
    await updateActiveTabs();
}

// Cause of a removal by Set-Cookie with a past date (how Bitrix deletes cookies).
// Chrome: "expired_overwrite". Firefox maps every single removal to "explicit"
// (toolkit/components/extensions/parent/ext-cookies.js, COOKIE_DELETED).
function isServerRemoval(cause) {
    return cause === 'expired_overwrite' || (IS_FIREFOX && cause === 'explicit');
}

// Updates all tabs the changed cookie belongs to (not only active ones: popup may be open in another tab)
async function onCookieChanged(changeInfo) {
    // Global names and per-site names ("name:<host>" in storage.local)
    let names = (await getTriggerSettings()).map(t => t.name);
    let local = await callApi('storage.local.get', [null], {});
    for (let key of Object.keys(local)) {
        if (key.startsWith('name:')) {
            names.push(local[key]);
        }
    }
    if (!names.includes(changeInfo.cookie.name)) {
        return;
    }
    // The server removed a cookie the user turned on (Bitrix deletes NCC for anonymous visitors
    // and composite groups): set it again. Removals by the extension clear the keep mark first.
    if (changeInfo.removed && isServerRemoval(changeInfo.cause) && await isKept(changeInfo.cookie)) {
        log('cookie removed by the server, restoring:', changeInfo.cookie.name, changeInfo.cookie.domain);
        try {
            await restoreCookie(changeInfo.cookie);
        } catch (e) {
            logError('restore failed', e);
        }
    }
    log('cookie changed:', changeInfo.cookie.name, changeInfo.cookie.domain, 'removed:', changeInfo.removed, 'cause:', changeInfo.cause);
    let domain = changeInfo.cookie.domain.replace(/^\./, '');
    let tabs = await callApi('tabs.query', [{}], []);
    for (let tab of tabs) {
        let host = getHost(tab.url);
        if (host === domain || host.endsWith('.' + domain)) {
            await updateIcon(tab);
        }
    }
}

function onTabUpdated(tabId, changeInfo, tab) {
    // React only to navigation, not to title/favicon/audio updates.
    // Tab-specific badge is reset by the browser on navigation, so background tabs are updated too.
    if (changeInfo.url || changeInfo.status === 'complete') {
        updateIcon(tab);
    }
}

async function onTabActivated(activeInfo) {
    try {
        updateIcon(await requireApi('tabs.get', [activeInfo.tabId]));
    } catch (e) {
        logError('onTabActivated: tabs.get failed', e);
    }
}

// Keyboard shortcuts toggle triggers without opening the popup
async function onCommand(command) {
    let triggerId = command.replace(/^toggle-/, '');
    let tab = await getActiveTab();
    log('command', command, 'tab', tab && tab.url);
    try {
        await toggleTrigger(tab, triggerId);
    } catch (e) {
        logError('command', command, 'failed', e);
    }
    await updateIcon(tab);
}

// Firefox MV3 treats host permissions as optional: open options with "Grant access" button if needed
async function onInstalled(details) {
    log('installed:', details.reason);
    // On first install the options page shows the cookie name (and asks for access in Firefox)
    if (details.reason === 'install' || !await hasHostPermission()) {
        callApi('runtime.openOptionsPage', []);
    }
    await updateActiveTabs();
}

// Listeners must be registered synchronously at top level (service worker requirement).
// Missing events are skipped: e.g. Firefox for Android has no windows and commands (keyboard shortcuts) APIs.
addApiListener('tabs.onUpdated', onTabUpdated);
addApiListener('tabs.onActivated', onTabActivated);
addApiListener('cookies.onChanged', onCookieChanged);
addApiListener('storage.onChanged', onSettingsChanged);
addApiListener('runtime.onInstalled', onInstalled);
addApiListener('windows.onFocusChanged', updateActiveTabs);
addApiListener('commands.onCommand', onCommand);
addApiListener('permissions.onAdded', updateActiveTabs);
addApiListener('permissions.onRemoved', updateActiveTabs);

updateActiveTabs();
