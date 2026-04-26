# catalog_mfo

Открытый JSON-справочник микрофинансовых организаций РФ. Актуализируется
из реестра субъектов рынка микрофинансирования ЦБ РФ.

## Структура

- `creditors.json` — текущий каталог
- `scripts/update.mjs` — обновление из публичного реестра ЦБ РФ
- `package.json` — зависимости скрипта обновления

## Формат `creditors.json`

```jsonc
{
  "version": "YYYY.MM.DD",
  "updatedAt": "ISO 8601",
  "source": "https://www.cbr.ru/microfinance/registry/",
  "creditors": [
    {
      "inn": "0000000000",
      "name": "...",
      "shortName": "...",
      "ogrn": "...",
      "licenseNo": "...",
      "licenseStatus": "active | suspended | revoked | unknown",
      "registryRecordNo": "...",
      "updatedAt": "ISO 8601"
    }
  ]
}
```

## Источник данных

Реестр субъектов рынка микрофинансирования ЦБ РФ:
https://www.cbr.ru/microfinance/registry/

## Лицензия

Данные реестра — общедоступная информация ЦБ РФ.
JSON-структура и скрипт — MIT.
