#!/usr/bin/env node
// Обновление каталога МФО из реестра ЦБ РФ.
//
// Скачивает Excel-файл реестра МФО с сайта ЦБ, парсит и сливает с
// существующим creditors.json:
//   - Обновляет статус лицензии (active/suspended/revoked) и регистрационный
//     номер для записей, которые уже есть в каталоге (по ИНН).
//   - Добавляет новые записи как `licenseStatus: 'active'` с дефолтным
//     ratingScore=50.
//   - Помечает удалённые из реестра записи как `licenseStatus: 'revoked'`.
//
// Запуск:
//   npm install
//   npm run update
//
// После запуска — закоммитить изменённый creditors.json.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Используем dynamic import, чтобы скрипт не падал, если xlsx не установлен —
// выводим понятное сообщение.
let XLSX;
try {
  XLSX = (await import('xlsx')).default;
} catch {
  console.error('Установите парсер: cd catalog && npm install xlsx');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.join(__dirname, '..', 'creditors.json');

// ЦБ РФ публикует реестр МФО как Excel. URL может меняться — проверяйте
// актуальный на https://www.cbr.ru/microfinance/registry/
const CBR_URL = 'https://www.cbr.ru/vfs/finmarkets/files/supervision/list_MFO.xlsx';

const todayIso = () => new Date().toISOString();
const todayVersion = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${String(d.getUTCDate()).padStart(2, '0')}`;
};

async function downloadXlsx(url) {
  console.log(`→ Скачиваю реестр: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`  получено ${buf.length} байт`);
  return buf;
}

function parseRegistry(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  // В файле ЦБ листы: «Действующие», «Действующие МФК», «Действующие МКК»,
  // «Исключенные». Берём основной — со всеми действующими.
  const sheet = wb.Sheets['Действующие'] ?? wb.Sheets[wb.SheetNames[0]];

  // Первые 4 строки — текстовая шапка документа («Государственный реестр…»),
  // настоящие имена колонок начинаются на строке 5 (range: 4 в zero-indexed).
  const rows = XLSX.utils.sheet_to_json(sheet, {
    defval: null, raw: false, range: 4,
  });
  if (rows.length === 0) return [];

  // Имена колонок длинные — ищем по нескольким вхождениям (AND).
  const findKey = (sample, ...needles) => {
    for (const k of Object.keys(sample)) {
      const lk = String(k).toLowerCase();
      if (needles.every((n) => lk.includes(n))) return k;
    }
    return null;
  };

  const s = rows[0];
  const keyName    = findKey(s, 'полное', 'наимен');
  const keyShort   = findKey(s, 'сокращ', 'наимен');
  const keyInn     = findKey(s, 'идентификационный') ?? findKey(s, 'инн');
  const keyOgrn    = findKey(s, 'огрн') ?? findKey(s, 'основной', 'регистрац');
  const keyReg     = findKey(s, 'регистрационный', 'номер', 'записи');
  const keyAddress = findKey(s, 'адрес', 'юридическ')
    ?? findKey(s, 'адрес');

  return rows
    .map((r) => ({
      name: keyName ? String(r[keyName] ?? '').trim() : '',
      shortName: keyShort ? String(r[keyShort] ?? '').trim() || undefined : undefined,
      inn: keyInn ? String(r[keyInn] ?? '').replace(/\D+/g, '') : '',
      ogrn: keyOgrn ? String(r[keyOgrn] ?? '').replace(/\D+/g, '') || undefined : undefined,
      registryRecordNo: keyReg ? String(r[keyReg] ?? '').trim() || undefined : undefined,
      address: keyAddress ? String(r[keyAddress] ?? '').trim() || undefined : undefined,
    }))
    .filter((r) => r.name && r.inn.length === 10);
}

async function readCurrent() {
  const raw = await fs.readFile(CATALOG_PATH, 'utf-8');
  return JSON.parse(raw);
}

function merge(current, fromRegistry) {
  const byInn = new Map(current.creditors.map((c) => [c.inn, c]));
  const seen = new Set();
  const now = todayIso();

  for (const r of fromRegistry) {
    seen.add(r.inn);
    const existing = byInn.get(r.inn);
    if (existing) {
      // Обновляем поля, которые приходят из реестра ЦБ; остальные оставляем
      existing.licenseStatus = 'active';
      existing.registryRecordNo = r.registryRecordNo ?? existing.registryRecordNo;
      existing.ogrn = r.ogrn ?? existing.ogrn;
      existing.address = r.address ?? existing.address;
      existing.updatedAt = now;
    } else {
      // Новая запись — добавляем с дефолтным рейтингом
      byInn.set(r.inn, {
        inn: r.inn,
        name: r.name,
        shortName: r.shortName,
        ogrn: r.ogrn,
        licenseStatus: 'active',
        registryRecordNo: r.registryRecordNo,
        maxProlongations: 5,
        prolongationFeeRate: 0,
        ratingScore: 50,
        address: r.address,
        complaintsUrl: 'https://www.cbr.ru/Reception/Message/Register',
        updatedAt: now,
      });
    }
  }

  // Те, кого нет в реестре, но они есть у нас — помечаем revoked.
  // Кроме записи-плейсхолдера (inn 0000000000) — она не из реестра.
  for (const c of byInn.values()) {
    if (c.inn === '0000000000') continue;
    if (!seen.has(c.inn) && c.licenseStatus === 'active') {
      c.licenseStatus = 'revoked';
      c.updatedAt = now;
    }
  }

  // Версия = сегодняшняя дата UTC. Если она совпадает с уже опубликованной
  // (повторный запуск за день) — добавляем суффикс `.N`, чтобы клиенты
  // увидели изменение и подтянули новый JSON.
  const today = todayVersion();
  let nextVersion = today;
  if (current.version === today) {
    nextVersion = `${today}.1`;
  } else if (current.version.startsWith(`${today}.`)) {
    const m = /\.(\d+)$/.exec(current.version);
    const n = m ? Number(m[1]) + 1 : 1;
    nextVersion = `${today}.${n}`;
  }

  return {
    version: nextVersion,
    updatedAt: now,
    source: current.source,
    notes: current.notes,
    creditors: Array.from(byInn.values())
      .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
  };
}

async function main() {
  const current = await readCurrent();
  console.log(`Текущая версия: ${current.version} (${current.creditors.length} записей)`);

  const buf = await downloadXlsx(CBR_URL);
  const fromReg = parseRegistry(buf);
  console.log(`→ В реестре ЦБ найдено ${fromReg.length} организаций`);

  const next = merge(current, fromReg);

  await fs.writeFile(
    CATALOG_PATH,
    JSON.stringify(next, null, 2) + '\n',
    'utf-8',
  );

  const added = next.creditors.length - current.creditors.length;
  const revoked = next.creditors.filter((c) => c.licenseStatus === 'revoked').length
                - current.creditors.filter((c) => c.licenseStatus === 'revoked').length;
  console.log('✓ Каталог обновлён');
  console.log(`  Версия: ${next.version}`);
  console.log(`  Всего записей: ${next.creditors.length}`);
  console.log(`  Добавлено новых: ${added}`);
  console.log(`  Помечено отозванными: ${revoked}`);
  console.log('');
  console.log('Не забудьте: проверить diff, отредактировать ratingScore у новых записей,');
  console.log('закоммитить creditors.json и обновить хостинг.');
}

main().catch((e) => {
  console.error('✗ Ошибка:', e.message ?? e);
  process.exit(1);
});
