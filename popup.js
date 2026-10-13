let popupTab;

function showError(message) {
    let el = document.querySelector('.error');
    el.textContent = message;
    el.hidden = !message;
}

async function render() {
    // popup.html?tabId=N opens the popup for a given tab (for debugging in a regular tab)
    let debugTabId = new URLSearchParams(location.search).get('tabId');
    popupTab = debugTabId ? await callApi('tabs.get', [Number(debugTabId)], undefined) : await getActiveTab();
    let host = popupTab ? getHost(popupTab.url) : '';
    log('popup: render for', popupTab && popupTab.url);

    document.querySelector('.host').textContent = host || (popupTab && popupTab.url) || '';

    let supported = popupTab && isSupportedUrl(popupTab.url);
    let permitted = supported && await hasHostPermission();
    document.querySelector('.unsupported').hidden = !!supported;
    document.querySelector('.no-permission').hidden = !supported || permitted;
    document.querySelector('.controls').hidden = !permitted;
    if (!permitted) {
        return;
    }

    await autoDetectSiteName(popupTab);
    let triggers = await getTriggerSettings(host);
    let states = await getStates(popupTab);
    let container = document.querySelector('.triggers');
    let template = document.querySelector('.trigger-template');
    container.textContent = '';
    for (let trigger of triggers) {
        let row = template.content.cloneNode(true);
        let checkbox = row.querySelector('input');
        checkbox.checked = !!states[trigger.id];
        checkbox.dataset.trigger = trigger.id;
        checkbox.addEventListener('change', onTriggerChange);
        row.querySelector('.trigger-label').textContent = trigger.label;
        let cookie = row.querySelector('.trigger-cookie');
        cookie.textContent = trigger.name + '=' + trigger.value + (trigger.siteName ? ' - ' + t('forThisSite') : '');
        cookie.title = t('changeSiteNameTitle');
        cookie.addEventListener('click', toggleSiteNameRow);
        container.appendChild(row);
    }

    let select = document.querySelector('.scope');
    let scope = await getScope(host);
    select.textContent = '';
    select.appendChild(new Option(t('scopeHostOnly', host), ''));
    for (let domain of getDomainCandidates(host)) {
        select.appendChild(new Option(t('scopeWithSubdomains', domain), domain));
    }
    select.value = scope;
    select.disabled = select.options.length < 2;

    await renderSiteName(host, triggers[0]);
}

// Per-site cookie name: input with the current name, the global one is the placeholder
async function renderSiteName(host, trigger) {
    let siteName = await getSiteCookieName(host);
    let input = document.querySelector('.site-name');
    input.value = siteName;
    input.placeholder = trigger.globalName;
    // The row is opened by click on the cookie name, stays open when a site name is set
    if (siteName) {
        document.querySelector('.site-name-row').hidden = false;
    }
    log('popup: cookie name for', host, '=', trigger.name, trigger.siteName ? '(site)' : '(global)');
}

function toggleSiteNameRow(e) {
    e.preventDefault();
    let row = document.querySelector('.site-name-row');
    row.hidden = !row.hidden;
    if (!row.hidden) {
        document.querySelector('.site-name').focus();
    }
}

// Changes the cookie name for the site. An enabled cookie is moved to the new name,
// otherwise the cookie with the old name would stay and keep the composite cache disabled.
async function applySiteCookieName(name) {
    showError('');
    let host = getHost(popupTab.url);
    let before = (await getTriggerSettings(host))[0];
    let enabled = !!await getCookie(popupTab, before);
    try {
        if (enabled) {
            await disableTrigger(popupTab, before);
        }
        await setSiteCookieName(host, name);
        if (enabled) {
            await enableTrigger(popupTab, (await getTriggerSettings(host))[0]);
        }
    } catch (err) {
        logError('popup: cookie name change failed', err);
        showError(t('failed', err && err.message || err));
    }
    await render();
}

async function onSiteNameSubmit(e) {
    e.preventDefault();
    let name = document.querySelector('.site-name').value.trim();
    if (name && !isValidCookieName(name)) {
        showError(t('optInvalidName', name));
        return;
    }
    await applySiteCookieName(name);
}

async function onSiteNameReset() {
    await applySiteCookieName('');
}

async function onTriggerChange(e) {
    showError('');
    let triggerId = e.target.dataset.trigger;
    try {
        let enabled = await toggleTrigger(popupTab, triggerId);
        log('popup: trigger', triggerId, enabled ? 'enabled' : 'disabled');
    } catch (err) {
        logError('popup: toggle failed', triggerId, err);
        showError(t('failed', err && err.message || err));
    }
    await render();
}

async function onScopeChange(e) {
    showError('');
    let host = getHost(popupTab.url);
    let oldScope = await getScope(host);
    let states = await getStates(popupTab);
    let enabledIds = Object.keys(states).filter(id => states[id]);
    await setScope(host, e.target.value);
    try {
        await reapplyTriggers(popupTab, enabledIds);
    } catch (err) {
        // For example, the browser refuses to set a cookie for a public suffix (co.uk)
        logError('popup: scope change failed', err);
        showError(t('scopeFailed', err && err.message || err));
        await setScope(host, oldScope);
        await reapplyTriggers(popupTab, enabledIds).catch(err2 => logError('popup: rollback failed', err2));
    }
    await render();
}

async function onGrantClick() {
    try {
        await requestHostPermission();
    } catch (err) {
        logError('popup: permission request failed', err);
        showError(t('permissionFailed', err && err.message || err));
    }
    await render();
}

// Reloads the page with ?ncc=1: works even when nginx serves the composite cache without PHP
async function onOpenWithoutComposite() {
    let url = nccUrl(popupTab.url);
    log('popup: open without composite', url);
    try {
        await requireApi('tabs.update', [popupTab.id, { url: url }]);
        window.close();
    } catch (err) {
        logError('popup: tabs.update failed', err);
        showError(t('failed', err && err.message || err));
    }
}

function openOptions(e) {
    e.preventDefault();
    callApi('runtime.openOptionsPage', []);
    window.close();
}

document.querySelector('.scope').addEventListener('change', onScopeChange);
document.querySelector('.site-name-row').addEventListener('submit', onSiteNameSubmit);
document.querySelector('.site-name-reset').addEventListener('click', onSiteNameReset);
document.querySelector('.grant').addEventListener('click', onGrantClick);
document.querySelector('.open-options').addEventListener('click', openOptions);
document.querySelector('.open-ncc').addEventListener('click', onOpenWithoutComposite);

localizePage();
render().catch(err => {
    logError('popup: render failed', err);
    showError(String(err && err.message || err));
});
