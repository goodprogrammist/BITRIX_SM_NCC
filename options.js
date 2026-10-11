const visibilityClass = 'is-visible';
const OPTIONS_LOG_PREFIX = '[NCC options]';

async function saveOptions(e) {
    e.preventDefault();
    hideMessages();
    document.querySelectorAll(".invalid").forEach(el => el.classList.remove("invalid"));

    let onColor = document.querySelector(".cookie-ncc-on-color:checked");
    let offColor = document.querySelector(".cookie-ncc-off-color:checked");
    let nameInput = document.querySelector(".cookie_ncc");
    // Storage keys are the same as in version 0.1
    let options = {
        cookie_ncc: nameInput.value.trim(),
        cookie_ncc_on_color: onColor ? onColor.value : DEFAULT_ON_COLOR,
        cookie_ncc_off_color: offColor ? offColor.value : DEFAULT_OFF_COLOR
    };

    let errors = [];
    if (options.cookie_ncc && !isValidCookieName(options.cookie_ncc)) {
        errors.push(t('optInvalidName', options.cookie_ncc));
        nameInput.classList.add("invalid");
    }
    if (errors.length) {
        console.debug(OPTIONS_LOG_PREFIX, 'not saved, invalid values:', errors);
        showError(errors.join(' '));
        return;
    }
    console.debug(OPTIONS_LOG_PREFIX, 'saving', options);

    try {
        await requireApi('storage.' + SETTINGS_AREA + '.set', [options]);
        showSuccess();
    } catch (err) {
        showError(err);
    }
}

async function restoreOptions() {
    let trigger = (await getTriggerSettings())[0];
    let colors = await getColors();
    console.debug(OPTIONS_LOG_PREFIX, 'restored', trigger, colors);

    // The placeholder "?????_NCC" saved by version 0.1 is shown as the default name
    document.querySelector(".cookie_ncc").value = trigger.globalName;
    document.querySelector(".cookie-ncc-on-color[value=" + colors.on + "]").checked = true;
    document.querySelector(".cookie-ncc-off-color[value=" + colors.off + "]").checked = true;

    await renderPermission();
}

async function renderPermission() {
    let permitted = await hasHostPermission();
    console.debug(OPTIONS_LOG_PREFIX, 'host permission:', permitted);
    document.querySelector(".permission-row").hidden = permitted;
}

async function onGrantClick() {
    try {
        await requestHostPermission();
    } catch (err) {
        console.error(OPTIONS_LOG_PREFIX, 'permission request failed', err);
    }
    await renderPermission();
}

function showSuccess() {
    let messageClass = document.querySelector(".saved-successfully").classList;

    messageClass.add(visibilityClass);
    setTimeout(function() {
        hideMessages();
    }, 2000);
}

// message - validation text; without it (storage error) the generic text is shown
function showError(message) {
    let element = document.querySelector(".saved-error");
    if (typeof message === 'string') {
        element.textContent = message;
    } else {
        console.error(OPTIONS_LOG_PREFIX, 'save failed', message);
        element.textContent = t('optSaveError');
    }
    element.classList.add(visibilityClass);
}

function hideMessages() {
    document.querySelectorAll(".message").forEach(function(message) {
        message.classList.remove(visibilityClass);
    });
}

localizePage();
document.addEventListener('DOMContentLoaded', restoreOptions);
document.querySelector("form").addEventListener("submit", saveOptions);
document.querySelector(".grant").addEventListener("click", onGrantClick);
