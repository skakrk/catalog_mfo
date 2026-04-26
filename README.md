# Каталог МФО для Dinosaurus

Это директория с публичным справочником микрофинансовых организаций. Приложение Dinosaurus подтягивает его при запуске и показывает информацию о лицензии при работе с обязательствами пользователя.

```
catalog/
├── creditors.json     ← публичный JSON, его раздаём пользователям
├── package.json       ← зависимости скрипта обновления
├── README.md
└── scripts/
    └── update.mjs     ← скрипт обновления из реестра ЦБ РФ
```

---

## Формат

```jsonc
{
  "version": "2026.04.26",          // ИЗМЕНЯЕТСЯ при каждом обновлении
  "updatedAt": "2026-04-26T00:00:00Z",
  "source": "https://www.cbr.ru/microfinance/registry/",
  "creditors": [
    {
      "inn": "4205271785",
      "name": "МФК «Займер»",
      "shortName": "Займер",
      "ogrn": "1134205019189",
      "licenseNo": "651303322004471",
      "licenseStatus": "active",     // active | suspended | revoked | unknown
      "registryRecordNo": "651303322004471",
      "maxProlongations": 5,
      "prolongationFeeRate": 0,
      "ratingScore": 62,             // редакторская оценка 0..100
      "website": "https://www.zaymer.ru/",
      "complaintsUrl": "https://www.cbr.ru/Reception/Message/Register",
      "updatedAt": "2026-04-26T00:00:00Z"
    }
  ]
}
```

Приложение проверяет поле `version` против локально сохранённого. Если строки отличаются — скачивает каталог целиком и обновляет локальную таблицу `creditors_master`.

---

## Хостинг

Файл `creditors.json` нужно положить туда, где он будет доступен **по HTTPS без авторизации**. Несколько подходящих вариантов:

### Вариант 1 — GitHub Pages (бесплатно, рекомендую)

1. Создать публичный репозиторий, например `dinosaurus-catalog`.
2. Скопировать файл `creditors.json` в корень репозитория.
3. В **Settings → Pages** выбрать ветку `main` и корневую папку. GitHub за пару минут опубликует на `https://USERNAME.github.io/dinosaurus-catalog/creditors.json`.
4. В корневом `.env` приложения:
   ```
   EXPO_PUBLIC_CATALOG_URL=https://USERNAME.github.io/dinosaurus-catalog/creditors.json
   ```
5. Перезапустить Metro (`npm start -- --clear`).

При каждом обновлении просто коммитите новую версию в репозиторий — Pages пересоберёт автоматически.

### Вариант 2 — Supabase Storage

Если у вас уже настроен Supabase для бэкапа:

1. **Storage → Create bucket → public** (например, `catalog`).
2. Загрузить `creditors.json`.
3. Public URL будет вида `https://YOUR-PROJECT.supabase.co/storage/v1/object/public/catalog/creditors.json`.
4. Прописать в `.env`.

### Вариант 3 — любой статический CDN

Cloudflare Pages, Vercel, Netlify, S3 — всё одинаково. Главное:
- `Content-Type: application/json`
- Доступ по HTTPS без авторизации
- Обновление по `EXPO_PUBLIC_CATALOG_URL` в `.env`

---

## Обновление из реестра ЦБ РФ

Скрипт `scripts/update.mjs` качает Excel реестра МФО с [сайта ЦБ](https://www.cbr.ru/microfinance/registry/), парсит его и обновляет `creditors.json`:

- **Существующие записи** (по ИНН) — обновляются: статус лицензии, рег. номер, ОГРН, адрес. Редакторские поля (`ratingScore`, `notes`, `website`) **сохраняются**.
- **Новые записи** (которых не было в нашем каталоге) — добавляются с дефолтным `ratingScore: 50`.
- **Удалённые из реестра** — помечаются `licenseStatus: 'revoked'` (но сами записи остаются — у пользователей могут быть займы у них).
- Версия каталога автоматически меняется на дату запуска.

### Как запустить

```bash
cd catalog
npm install
npm run update
```

После выполнения проверить diff в `creditors.json`, при необходимости поправить ratingScore у новых записей и закоммитить.

> ⚠️ URL XLSX-файла на сайте ЦБ может меняться. Если скрипт перестал работать — зайди на [страницу реестра](https://www.cbr.ru/microfinance/registry/) и обнови `CBR_URL` в `scripts/update.mjs`.

---

## Регулярное обновление через GitHub Actions

Если каталог в отдельном репозитории на GitHub, можно настроить автообновление раз в неделю. Создайте `.github/workflows/update.yml`:

```yaml
name: Update catalog
on:
  schedule:
    - cron: '0 6 * * 1'   # каждый понедельник в 06:00 UTC
  workflow_dispatch:        # ручной запуск с GitHub UI

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
      - run: npm run update
      - name: Commit changes
        run: |
          git config user.name "github-actions"
          git config user.email "actions@github.com"
          git add creditors.json
          git diff --staged --quiet || git commit -m "chore(catalog): weekly update from CBR"
          git push
```

После этого: коммитить руками не нужно, каталог обновляется сам, GitHub Pages пересобирается автоматически.

---

## Редакторская политика

- `ratingScore` (0..100) — наша внутренняя оценка кредитора. Чем выше — тем менее агрессивная политика взыскания. Используется в приложении для рекомендаций приоритета погашения.
- `notes` — короткий комментарий редактора (например, «залог автомобиля», «исторически высокий процент жалоб»). Появляется в интерфейсе пользователя.
- `complaintsUrl` — ссылка на форму жалобы. По умолчанию — приёмная ЦБ РФ. При желании можно подставить специализированный канал (например, страницу Финансового омбудсмена).

**Чего не делаем:**
- Не добавляем рекламные ссылки в `notes`.
- Не подставляем партнёрские UTM в `website` или `complaintsUrl`.
- Не показываем платных «топ-1»: рейтинг — редакторский, не аукцион.
