# Публикация в магазинах

Все файлы для публикации лежат в этой папке:

| Файл | Что это |
|---|---|
| `listing-en.md`, `listing-ru.md` | Название, краткое и полное описание, категория |
| `privacy-policy.md` | Политика приватности (можно указать ссылку на этот файл на GitHub) |
| `permissions.md` | Обоснования разрешений и «single purpose» для форм проверки |
| `images/screenshot-*-en.png`, `-ru.png` | Скриншоты 1280×800 |
| `images/promo-small-440x280.png` | Малый промо-баннер 440×280 (обязателен в Chrome Web Store) |
| `make-images.js` | Генератор картинок из настоящего интерфейса: `node store/make-images.js` |

## Пакет

Архив собирается командой `npm run build` (папка `web-ext-artifacts/`) или автоматически
GitHub Actions при создании тега версии, например `v1.0` — тогда zip прикрепляется к GitHub Release.
Один и тот же zip подходит для обоих магазинов. Перед каждой новой публикацией увеличьте `version` в `manifest.json`.

## Firefox — addons.mozilla.org (AMO)

Расширение уже опубликовано: https://addons.mozilla.org/firefox/addon/_ncc-cookie-for-bitrix/
(ID `ncc_cookie_setup@goodprogrammist.ru` в манифесте совпадает), поэтому загружается **новая версия**:

1. https://addons.mozilla.org/developers/addons → дополнение → «Upload New Version».
2. Загрузите zip. Галочка «Android» ставится автоматически: в манифесте есть `gecko_android`.
3. На вопрос о исходном коде ответьте «No»: код не минифицирован и не обфусцирован.
4. «Notes for Reviewers» — текст из `reviewer-notes.md`.
5. На странице дополнения («Edit Product Page») обновите описание из `listing-en.md`
   (и `listing-ru.md` для локали ru), скриншоты и ссылку на политику приватности.
6. Сведения о сборе данных уже указаны в манифесте: `data_collection_permissions: none`.

## Chrome Web Store

1. Зарегистрируйтесь как разработчик в Chrome Web Store Developer Dashboard
   (нужен Google-аккаунт и разовый регистрационный взнос).
2. «New item» → загрузите zip.
3. Store listing: описание из `listing-en.md` / `listing-ru.md`, категория Developer Tools,
   скриншоты из `images/` (от 1 до 5, 1280×800), малый промо-баннер 440×280.
   Иконка 128×128 берётся из пакета (`icons/bug-green-128-padded.png`, рисунок 96×96 с полями по 16 px),
   она же — `images/store-icon-128.png`.
4. Раздел о приватности: «single purpose» и обоснования разрешений из `permissions.md`,
   отметьте, что данные не собираются, укажите ссылку на `privacy-policy.md`.
5. Отправьте на проверку.
