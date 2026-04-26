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

// Универсальный поиск ключа: имена колонок длинные, ищем по нескольким
// подстрокам (логическое AND).
const findKey = (sample, ...needles) => {
  for (const k of Object.keys(sample)) {
    const lk = String(k).toLowerCase();
    if (needles.every((n) => lk.includes(n))) return k;
  }
  return null;
};

// Парсит один лист реестра в нормализованный массив записей.
// Шапка документа на разных листах разной высоты, поэтому headerOffset.
function parseSheet(sheet, headerOffset, opts = {}) {
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json(sheet, {
    defval: null, raw: false, range: headerOffset,
  });
  if (rows.length === 0) return [];

  const s = rows[0];
  const keyName    = findKey(s, 'полное', 'наимен');
  const keyShort   = findKey(s, 'сокращ', 'наимен');
  const keyInn     = findKey(s, 'идентификационный') ?? findKey(s, 'инн');
  const keyOgrn    = findKey(s, 'огрн') ?? findKey(s, 'основной', 'регистрац');
  const keyReg     = findKey(s, 'регистрационный', 'номер', 'записи');
  const keyAddress = findKey(s, 'адрес', 'юридическ') ?? findKey(s, 'адрес');
  const keyExclusion = opts.withExclusionDate
    ? findKey(s, 'исключени') ?? findKey(s, 'исключения')
    : null;

  return rows
    .map((r) => ({
      name: keyName ? String(r[keyName] ?? '').trim() : '',
      shortName: keyShort ? String(r[keyShort] ?? '').trim() || undefined : undefined,
      inn: keyInn ? String(r[keyInn] ?? '').replace(/\D+/g, '') : '',
      ogrn: keyOgrn ? String(r[keyOgrn] ?? '').replace(/\D+/g, '') || undefined : undefined,
      registryRecordNo: keyReg ? String(r[keyReg] ?? '').trim() || undefined : undefined,
      address: keyAddress ? String(r[keyAddress] ?? '').trim() || undefined : undefined,
      exclusionDate: keyExclusion ? String(r[keyExclusion] ?? '').trim() || undefined : undefined,
    }))
    .filter((r) => r.name && r.inn.length === 10);
}

// Парсит обе вкладки и возвращает нормализованные списки.
//   active   — лист «Действующие» (шапка 4 строки)
//   excluded — лист «Исключенные» (шапка 2 строки + колонка с датой
//              исключения; используется для уточнения статуса записей,
//              которые уже есть в нашем каталоге)
function parseRegistry(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const active = parseSheet(
    wb.Sheets['Действующие'] ?? wb.Sheets[wb.SheetNames[0]],
    4,
  );
  const excluded = parseSheet(
    wb.Sheets['Исключенные'],
    2,
    { withExclusionDate: true },
  );
  return { active, excluded };
}

async function readCurrent() {
  const raw = await fs.readFile(CATALOG_PATH, 'utf-8');
  return JSON.parse(raw);
}

function merge(current, fromRegistry) {
  const byInn = new Map(current.creditors.map((c) => [c.inn, c]));
  const activeInns = new Set();
  const now = todayIso();
  const { active, excluded } = fromRegistry;

  // 1) Действующие — создаём новые записи или обновляем существующие
  for (const r of active) {
    activeInns.add(r.inn);
    const existing = byInn.get(r.inn);
    if (existing) {
      existing.licenseStatus = 'active';
      existing.registryRecordNo = r.registryRecordNo ?? existing.registryRecordNo;
      existing.ogrn = r.ogrn ?? existing.ogrn;
      existing.address = r.address ?? existing.address;
      // Если МФО была revoked, а теперь снова в реестре — снимаем дату исключения
      delete existing.revokedAt;
      existing.updatedAt = now;
    } else {
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

  // 2) Исключенные — обновляем статус ТОЛЬКО для тех ИНН, что уже есть
  // у нас в каталоге. Список исключённых на стороне ЦБ огромный (~9к),
  // целиком грузить нет смысла: пользователь не увидит этих МФО при
  // добавлении займа, но если у него уже есть займ от такой МФО, статус
  // подтянется в следующий цикл синхронизации.
  const excludedByInn = new Map(excluded.map((r) => [r.inn, r]));
  for (const c of byInn.values()) {
    if (c.inn === '0000000000') continue;            // плейсхолдер
    if (activeInns.has(c.inn)) continue;             // в реестре действующих
    const ex = excludedByInn.get(c.inn);
    if (ex) {
      // Точное совпадение — есть в реестре исключённых, можем добавить
      // дату исключения для UI приложения.
      c.licenseStatus = 'revoked';
      c.revokedAt = ex.exclusionDate ?? c.revokedAt;
      c.updatedAt = now;
    } else if (c.licenseStatus === 'active') {
      // На всякий случай: МФО исчезла из обоих списков (теоретически
      // не должно быть). Помечаем revoked без даты, как раньше.
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
  console.log(`→ В реестре ЦБ:`);
  console.log(`    действующих:  ${fromReg.active.length}`);
  console.log(`    исключённых:  ${fromReg.excluded.length} (используются для уточнения статуса)`);

  const before = {
    total: current.creditors.length,
    active: current.creditors.filter((c) => c.licenseStatus === 'active').length,
    revoked: current.creditors.filter((c) => c.licenseStatus === 'revoked').length,
  };

  const next = merge(current, fromReg);

  await fs.writeFile(
    CATALOG_PATH,
    JSON.stringify(next, null, 2) + '\n',
    'utf-8',
  );

  const after = {
    total: next.creditors.length,
    active: next.creditors.filter((c) => c.licenseStatus === 'active').length,
    revoked: next.creditors.filter((c) => c.licenseStatus === 'revoked').length,
  };

  console.log('✓ Каталог обновлён');
  console.log(`  Версия: ${next.version}`);
  console.log(`  Всего записей: ${after.total} (${after.total - before.total} новых)`);
  console.log(`    действующих:  ${after.active} (было ${before.active})`);
  console.log(`    отозванных:   ${after.revoked} (было ${before.revoked})`);
  console.log('');
  console.log('Готово к коммиту.');
}

main().catch((e) => {
  console.error('✗ Ошибка:', e.message ?? e);
  process.exit(1);
});
