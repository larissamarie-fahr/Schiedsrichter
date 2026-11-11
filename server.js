import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const publicDir = join(root, 'public');
const databasePath = process.env.DATABASE_PATH || join(homedir(), 'Library', 'Application Support', 'Schiedsrichter-App', 'referee.sqlite');
const appDataDir = dirname(databasePath);
const attachmentDir = join(appDataDir, 'attachments');
mkdirSync(dirname(databasePath), { recursive: true });
mkdirSync(attachmentDir, { recursive: true });
const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS address_versions (
    id INTEGER PRIMARY KEY,
    address TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY,
    game_date TEXT NOT NULL,
    game_time TEXT NOT NULL,
    age_group TEXT NOT NULL,
    system TEXT NOT NULL,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    stadium TEXT NOT NULL,
    stadium_address TEXT NOT NULL,
    fee REAL NOT NULL DEFAULT 0,
    route_km REAL,
    route_mode TEXT NOT NULL DEFAULT 'manual',
    mileage_rate REAL NOT NULL DEFAULT 0.30,
    league TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT '',
    round_stage TEXT NOT NULL DEFAULT '',
    season TEXT NOT NULL DEFAULT '2026/27',
    fee_manual INTEGER NOT NULL DEFAULT 1,
    address_version_id INTEGER REFERENCES address_versions(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS salary_rates (
    id INTEGER PRIMARY KEY,
    season TEXT NOT NULL,
    age_group TEXT NOT NULL,
    league TEXT NOT NULL DEFAULT '',
    system TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    round_stage TEXT NOT NULL DEFAULT '',
    fee REAL NOT NULL CHECK (fee >= 0),
    UNIQUE (season, age_group, league, system, role, round_stage)
  );
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS venue_distances (
    id INTEGER PRIMARY KEY,
    home_address TEXT NOT NULL,
    stadium TEXT NOT NULL,
    stadium_address TEXT NOT NULL,
    route_km REAL NOT NULL CHECK (route_km >= 0),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX IF NOT EXISTS venue_distances_address_idx ON venue_distances (lower(trim(home_address)), lower(trim(stadium_address)));
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY,
    expense_date TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    amount REAL NOT NULL,
    attachment_path TEXT,
    attachment_name TEXT,
    attachment_type TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const gameColumns = db.prepare('PRAGMA table_info(games)').all().map((column) => column.name);
for (const [column, definition] of [
  ['league', "TEXT NOT NULL DEFAULT ''"],
  ['role', "TEXT NOT NULL DEFAULT ''"],
  ['round_stage', "TEXT NOT NULL DEFAULT ''"],
  ['season', "TEXT NOT NULL DEFAULT '2026/27'"],
  ['fee_manual', 'INTEGER NOT NULL DEFAULT 1'],
]) {
  if (!gameColumns.includes(column)) db.exec(`ALTER TABLE games ADD COLUMN ${column} ${definition}`);
}
if (!gameColumns.includes('season')) {
  db.exec(`UPDATE games SET season = CASE
    WHEN CAST(substr(game_date, 6, 2) AS INTEGER) >= 7
      THEN substr(game_date, 1, 4) || '/' || substr(CAST(CAST(substr(game_date, 1, 4) AS INTEGER) + 1 AS TEXT), 3, 2)
    ELSE CAST(CAST(substr(game_date, 1, 4) AS INTEGER) - 1 AS TEXT) || '/' || substr(game_date, 3, 2)
  END`);
}
db.exec(`UPDATE games SET mileage_rate = CASE
  WHEN CAST(substr(game_date, 1, 4) AS INTEGER) >= 2026 THEN 0.38
  ELSE 0.30
END`);

const addressColumns = db.prepare('PRAGMA table_info(address_versions)').all().map((column) => column.name);
if (!addressColumns.includes('effective_from')) db.exec("ALTER TABLE address_versions ADD COLUMN effective_from TEXT NOT NULL DEFAULT '0001-01-01'");
const expenseColumns = db.prepare('PRAGMA table_info(expenses)').all().map((column) => column.name);
for (const column of ['attachment_path', 'attachment_name', 'attachment_type', 'vendor', 'note']) {
  if (!expenseColumns.includes(column)) db.exec(`ALTER TABLE expenses ADD COLUMN ${column} TEXT`);
}

const initialRates = [
  ['U11', '', '1-Mann', '', '', 70],
  ['U13', '', '2-Mann', '', '', 70],
  ['U15', '', '2-Mann', '', '', 80],
  ['U17', '', '2-Mann', '', '', 95],
  ['DEB-U17', '', '2-Mann', '', '', 125],
  ['U20', 'LL', '2-Mann', '', '', 100],
  ['U20', 'BYL', '2-Mann', '', '', 100],
  ['U20', 'BYL', '3-Mann', 'Linienrichter', '', 100],
  ['U20', 'BYL', '3-Mann', 'Hauptschiedsrichter', '', 140],
  ['U20', 'BYL', '4-Mann', 'Linienrichter', '', 90],
  ['U20', 'BYL', '4-Mann', 'Hauptschiedsrichter', '', 90],
  ['Frauen', 'LL', '2-Mann', '', '', 100],
  ['Frauen', 'BYL', '2-Mann', '', '', 100],
  ['Frauen', 'BYL', '3-Mann', 'Linienrichter', '', 100],
  ['Frauen', 'BYL', '4-Mann', 'Linienrichter', '', 100],
  ['Frauen', 'BYL', '3-Mann', 'Hauptschiedsrichter', '', 150],
  ['Frauen', 'BYL', '4-Mann', 'Hauptschiedsrichter', '', 110],
  ['BZL', '', '2-Mann', '', '', 120],
  ['LL', '', '2-Mann', '', '', 150],
  ['LL', '', '3-Mann', 'Linienrichter', '', 120],
  ['LL', '', '3-Mann', 'Hauptschiedsrichter', '', 180],
  ['LL', '', '4-Mann', 'Linienrichter', '', 100],
  ['LL', '', '4-Mann', 'Hauptschiedsrichter', '', 110],
  ...['Vorrunde', 'Abstiegsrunde', 'PlayOff/-Down'].flatMap((round) => [
    ['BYL', '', '4-Mann', 'Linienrichter', round, round === 'PlayOff/-Down' ? 200 : 160],
    ['BYL', '', '4-Mann', 'Hauptschiedsrichter', round, round === 'PlayOff/-Down' ? 250 : 220],
  ]),
];
db.exec(`
  INSERT OR IGNORE INTO salary_rates (season, age_group, league, system, role, round_stage, fee)
  SELECT season, 'DEB-U17', league, system, role, round_stage, fee
  FROM salary_rates
  WHERE upper(trim(age_group)) IN ('U17 DEB', 'U17-DEB', 'U17–DEB', 'DEB–U17');
  DELETE FROM salary_rates
  WHERE upper(trim(age_group)) IN ('U17 DEB', 'U17-DEB', 'U17–DEB', 'DEB–U17');
  UPDATE games SET age_group='DEB-U17'
  WHERE upper(trim(age_group)) IN ('U17 DEB', 'U17-DEB', 'U17–DEB', 'DEB–U17');
`);
const seedRate = db.prepare('INSERT OR IGNORE INTO salary_rates (season, age_group, league, system, role, round_stage, fee) VALUES (?, ?, ?, ?, ?, ?, ?)');
for (const [ageGroup, league, system, role, roundStage, fee] of initialRates) seedRate.run('2026/27', ageGroup, league, system, role, roundStage, fee);
db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('current_season', '2026/27')").run();
if (!db.prepare("SELECT value FROM app_settings WHERE key='migration_game_seasons_v1'").get()) {
  db.exec(`UPDATE games SET season = CASE
    WHEN CAST(substr(game_date, 6, 2) AS INTEGER) >= 7
      THEN substr(game_date, 1, 4) || '/' || substr(CAST(CAST(substr(game_date, 1, 4) AS INTEGER) + 1 AS TEXT), 3, 2)
    ELSE CAST(CAST(substr(game_date, 1, 4) AS INTEGER) - 1 AS TEXT) || '/' || substr(game_date, 3, 2)
  END WHERE season='2026/27' AND game_date < '2026-07-01'`);
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('migration_game_seasons_v1', 'done')").run();
}

const accessPassword = process.env.APP_PASSWORD || randomBytes(6).toString('hex');
const sessions = new Set();
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function readJson(request, maxBytes = 100_000) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > maxBytes) throw new Error('Anfrage ist zu groß.');
  }
  return body ? JSON.parse(body) : {};
}

function numberOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : NaN;
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function manualFeeSelected(game) {
  if (game.fee_manual === undefined) return true;
  return game.fee_manual === true || game.fee_manual === 1 || game.fee_manual === '1' || game.fee_manual === 'true';
}

function validateGame(game) {
  const required = ['game_date', 'game_time', 'age_group', 'system', 'home_team', 'away_team', 'stadium', 'stadium_address'];
  if (required.some((key) => typeof game[key] !== 'string' || !game[key].trim())) return 'Bitte alle Pflichtfelder ausfüllen.';
  if (!validDate(game.game_date) || !/^\d{2}:\d{2}$/.test(game.game_time)) return 'Datum oder Uhrzeit ist ungültig.';
  if ([game.age_group, game.system, game.home_team, game.away_team, game.stadium, game.stadium_address].some((value) => value.length > 250)) return 'Ein Eingabefeld ist zu lang.';
  if (game.age_group.trim() === 'BYL' && game.system.trim() !== '4-Mann') return 'BYL-Spiele werden immer im 4-Mann-System gepfiffen.';
  if (!game.season || game.season.length > 20) return 'Bitte eine gültige Saison auswählen.';
  const feeManual = manualFeeSelected(game);
  if (feeManual && (numberOrNull(game.fee) === null || Number.isNaN(numberOrNull(game.fee)))) return 'Das Gehalt muss eine gültige Zahl sein.';
  if (!feeManual && findSalaryRate(game) === null) return 'Für diese Kombination gibt es in der Saison noch keinen Tarif. Gehalt manuell festlegen oder Tarif ergänzen.';
  if (Number.isNaN(numberOrNull(game.route_km))) return 'Die Kilometerzahl muss eine gültige positive Zahl sein.';
  return null;
}

function addressForDate(date) {
  return db.prepare('SELECT * FROM address_versions WHERE effective_from<=? ORDER BY effective_from DESC, id DESC LIMIT 1').get(date) || null;
}

function currentAddress() {
  return db.prepare('SELECT * FROM address_versions ORDER BY effective_from DESC, id DESC LIMIT 1').get() || null;
}

function findVenueDistance(homeAddress, stadiumAddress) {
  if (!homeAddress || !stadiumAddress) return null;
  return db.prepare('SELECT * FROM venue_distances WHERE lower(trim(home_address))=lower(trim(?)) AND lower(trim(stadium_address))=lower(trim(?)) ORDER BY id DESC LIMIT 1').get(homeAddress, stadiumAddress) || null;
}

function findVenueDistanceByStadium(homeAddress, stadium) {
  if (!homeAddress || !stadium) return null;
  const normalize = (value) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('de-DE');
  return db.prepare('SELECT * FROM venue_distances WHERE lower(trim(home_address))=lower(trim(?)) ORDER BY id DESC')
    .all(homeAddress)
    .find((venue) => normalize(venue.stadium) === normalize(stadium)) || null;
}

function saveVenueDistance(homeAddress, stadium, stadiumAddress, routeKm) {
  if (!homeAddress || !stadiumAddress || routeKm === null || Number.isNaN(routeKm)) return;
  db.prepare(`INSERT INTO venue_distances (home_address, stadium, stadium_address, route_km) VALUES (?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET stadium=excluded.stadium, route_km=excluded.route_km, updated_at=CURRENT_TIMESTAMP`).run(homeAddress.trim(), stadium.trim(), stadiumAddress.trim(), routeKm);
}

function findSalaryRate(game) {
  const rate = db.prepare(`SELECT fee FROM salary_rates WHERE season=? AND age_group=? AND league=? AND system=? AND role=? AND round_stage=?`).get(
    game.season,
    game.age_group.trim(),
    (game.league || '').trim(),
    game.system.trim(),
    (game.role || '').trim(),
    (game.round_stage || '').trim(),
  );
  return rate ? Number(rate.fee) : null;
}

function insertGame(game, id = null) {
  const address = addressForDate(game.game_date);
  const feeManual = manualFeeSelected(game);
  const fee = feeManual ? Number(game.fee) : findSalaryRate(game);
  const savedDistance = numberOrNull(game.route_km) === null ? findVenueDistance(address?.address, game.stadium_address) : null;
  const routeKm = savedDistance ? Number(savedDistance.route_km) : numberOrNull(game.route_km);
  const values = [
    game.game_date, game.game_time, game.age_group.trim(), game.system.trim(),
    game.home_team.trim(), game.away_team.trim(), game.stadium.trim(), game.stadium_address.trim(),
    fee, routeKm, 'manual',
    mileageRateForDate(game.game_date), (game.league || '').trim(), (game.role || '').trim(), (game.round_stage || '').trim(), game.season || '2026/27', feeManual ? 1 : 0, address?.id ?? null,
  ];
  if (id) {
    const existing = db.prepare('SELECT address_version_id FROM games WHERE id=?').get(id);
    values[17] = existing?.address_version_id ?? null;
    db.prepare(`UPDATE games SET game_date=?, game_time=?, age_group=?, system=?, home_team=?, away_team=?, stadium=?, stadium_address=?, fee=?, route_km=?, route_mode=?, mileage_rate=?, league=?, role=?, round_stage=?, season=?, fee_manual=?, address_version_id=? WHERE id=?`).run(...values, id);
    saveVenueDistance(address?.address, game.stadium, game.stadium_address, routeKm);
    return db.prepare('SELECT * FROM games WHERE id=?').get(id);
  }
  const result = db.prepare(`INSERT INTO games (game_date, game_time, age_group, system, home_team, away_team, stadium, stadium_address, fee, route_km, route_mode, mileage_rate, league, role, round_stage, season, fee_manual, address_version_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...values);
  saveVenueDistance(address?.address, game.stadium, game.stadium_address, routeKm);
  return db.prepare('SELECT * FROM games WHERE id=?').get(result.lastInsertRowid);
}

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function euro(value) {
  return Number(value || 0).toFixed(2).replace('.', ',');
}

function csvResponse(response, filename, rows) {
  const content = `\uFEFF${rows.map((row) => row.map(csvCell).join(';')).join('\r\n')}`;
  response.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  response.end(content);
}

function runImportParser() {
  const assignments = join(root, 'Spiele', 'Eishockey Management by BEV.xlsx');
  const salaries = join(root, 'Spiele', 'Gehalt Schiedsrichter.xlsx');
  if (!existsSync(assignments)) throw new Error('Die Einteilungsdatei „Eishockey Management by BEV.xlsx“ fehlt im Ordner Spiele.');
  return new Promise((resolve, reject) => {
    const args = [join(root, 'import_xlsx.py'), assignments];
    if (existsSync(salaries)) args.push(salaries);
    const child = spawn(process.env.PYTHON || 'python3', args);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new Error(`Excel-Import konnte nicht gestartet werden: ${error.message}`)));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || 'Excel-Dateien konnten nicht gelesen werden.'));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Excel-Import lieferte ein ungültiges Ergebnis.')); }
    });
  });
}

function importKey(game) {
  return [game.game_date, game.home_team, game.away_team].map((value) => String(value || '').trim().toLocaleLowerCase('de-DE').replace(/\s+/g, ' ')).join('|');
}

function seasonForDate(date) {
  const [year, month] = date.split('-').map(Number);
  const start = month >= 7 ? year : year - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, '0')}`;
}

function mileageRateForDate(date) {
  return Number(date.slice(0, 4)) >= 2026 ? 0.38 : 0.30;
}

function billableRouteKilometers(games) {
  const distances = new Map(games.map((game) => [game.id, game.route_km === null ? null : Number(game.route_km)]));
  for (let index = 1; index < games.length; index += 1) {
    const previous = games[index - 1];
    const current = games[index];
    const previousVenue = (previous.stadium_address || previous.stadium).trim().toLocaleLowerCase('de-DE').replace(/\s+/g, ' ');
    const currentVenue = (current.stadium_address || current.stadium).trim().toLocaleLowerCase('de-DE').replace(/\s+/g, ' ');
    if (previous.game_date !== current.game_date || previousVenue !== currentVenue || previous.route_km === null || current.route_km === null) continue;
    distances.set(previous.id, Number(previous.route_km) / 2);
    distances.set(current.id, Number(current.route_km) / 2);
  }
  return distances;
}

function applyImport(imported) {
  const counts = { addedGames: 0, updatedGames: 0, addedExpenses: 0 };
  const gameByKey = new Map(db.prepare('SELECT * FROM games').all().map((game) => [importKey(game), game]));
  const insert = db.prepare(`INSERT INTO games (game_date, game_time, age_group, system, home_team, away_team, stadium, stadium_address, fee, route_km, route_mode, mileage_rate, league, role, round_stage, season, fee_manual, address_version_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?)`);
  const update = db.prepare(`UPDATE games SET game_time=?, age_group=?, system=?, league=?, role=?, round_stage=?, season=?, stadium=?, stadium_address=?, fee=?, route_km=?, mileage_rate=?, fee_manual=?, address_version_id=? WHERE id=?`);
  const addExpense = db.prepare('INSERT INTO expenses (expense_date, category, description, amount) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const game of imported.games) {
      const key = importKey(game);
      const existing = gameByKey.get(key);
      const season = game.season || seasonForDate(game.game_date);
      const fromSalary = game.source === 'salary';
      const rateFee = fromSalary ? null : findSalaryRate({ ...game, season });
      const importedFee = fromSalary ? Number(game.fee) : rateFee ?? 0;
      const address = addressForDate(game.game_date);
      const savedDistance = findVenueDistance(address?.address, game.stadium_address || existing?.stadium_address)
        || findVenueDistanceByStadium(address?.address, game.stadium);
      const stadiumAddress = savedDistance && game.stadium_address.trim().toLocaleLowerCase('de-DE') === game.stadium.trim().toLocaleLowerCase('de-DE')
        ? savedDistance.stadium_address
        : game.stadium_address || existing?.stadium_address || '';
      if (existing) {
        const updatedGame = {
          ...existing,
          game_time: game.game_time !== '00:00' ? game.game_time : existing.game_time,
          age_group: fromSalary || existing.age_group === 'Nicht angegeben' ? game.age_group : existing.age_group,
          system: game.system !== 'Nicht angegeben' ? game.system : existing.system === 'Linienrichter' ? 'Nicht angegeben' : existing.system,
          league: game.league || existing.league,
          role: game.role || existing.role,
          round_stage: game.round_stage || existing.round_stage,
          season,
          stadium: game.stadium || existing.stadium,
          stadium_address: stadiumAddress || existing.stadium_address,
          fee: fromSalary ? importedFee : Number(existing.fee) || importedFee,
          route_km: fromSalary && game.route_km !== null ? game.route_km : existing.route_km ?? savedDistance?.route_km ?? null,
          fee_manual: fromSalary ? 1 : Number(existing.fee) > 0 ? existing.fee_manual : rateFee === null ? existing.fee_manual : 0,
          address_version_id: existing.address_version_id ?? address?.id ?? null,
        };
        update.run(
          updatedGame.game_time,
          updatedGame.age_group,
          updatedGame.system,
          updatedGame.league,
          updatedGame.role,
          updatedGame.round_stage,
          updatedGame.season,
          updatedGame.stadium,
          updatedGame.stadium_address,
          updatedGame.fee,
          updatedGame.route_km,
          updatedGame.mileage_rate,
          updatedGame.fee_manual,
          updatedGame.address_version_id,
          existing.id,
        );
        saveVenueDistance(address?.address, updatedGame.stadium, updatedGame.stadium_address, updatedGame.route_km);
        gameByKey.set(key, updatedGame);
        counts.updatedGames += 1;
      } else {
        const feeManual = fromSalary || rateFee === null;
        const routeKm = game.route_km ?? savedDistance?.route_km ?? null;
        const result = insert.run(game.game_date, game.game_time, game.age_group, game.system, game.home_team, game.away_team, game.stadium, stadiumAddress, importedFee, routeKm, mileageRateForDate(game.game_date), game.league || '', game.role || '', game.round_stage || '', season, feeManual ? 1 : 0, address?.id ?? null);
        const saved = db.prepare('SELECT * FROM games WHERE id=?').get(result.lastInsertRowid);
        saveVenueDistance(address?.address, saved.stadium, saved.stadium_address, saved.route_km);
        gameByKey.set(key, saved);
        counts.addedGames += 1;
      }
    }
    const knownExpenses = new Set(db.prepare('SELECT expense_date, category, description, amount FROM expenses').all().map((expense) => `${expense.expense_date}|${expense.category}|${expense.description}|${expense.amount}`));
    for (const expense of imported.expenses) {
      const key = `${expense.expense_date}|${expense.category}|${expense.description}|${expense.amount}`;
      if (knownExpenses.has(key)) continue;
      addExpense.run(expense.expense_date, expense.category, expense.description, expense.amount);
      knownExpenses.add(key);
      counts.addedExpenses += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return counts;
}

async function saveAttachment(attachment) {
  if (!attachment) return null;
  const allowedTypes = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
  if (!allowedTypes.has(attachment.type) || typeof attachment.data !== 'string') throw new Error('Bitte eine PDF-, JPG-, PNG- oder WebP-Datei auswählen.');
  const buffer = Buffer.from(attachment.data, 'base64');
  if (!buffer.length || buffer.length > 25 * 1024 * 1024) throw new Error('Der Beleg darf höchstens 25 MB groß sein.');
  const extension = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[attachment.type];
  const fileId = randomUUID();
  const storedPath = join(attachmentDir, `${fileId}${extension}`);
  await writeFile(storedPath, buffer, { flag: 'wx' });
  const originalName = String(attachment.name || `Beleg${extension}`).replace(/[\r\n"\\/]/g, '_').slice(0, 180);
  return { path: storedPath, name: originalName, type: attachment.type };
}

async function serve(request, response) {
  const url = new URL(request.url, 'http://localhost');
  const path = decodeURIComponent(url.pathname);

  if (path === '/api/login' && request.method === 'POST') {
    const body = await readJson(request);
    const supplied = Buffer.from(String(body.password || ''));
    const expected = Buffer.from(accessPassword);
    const accepted = supplied.length === expected.length && timingSafeEqual(supplied, expected);
    if (!accepted) return sendJson(response, 401, { error: 'Zugangscode stimmt nicht.' });
    const token = randomBytes(32).toString('hex');
    sessions.add(token);
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
      'Cache-Control': 'no-store',
    });
    return response.end('{"ok":true}');
  }

  if (path.startsWith('/api/')) {
    const token = request.headers.cookie?.match(/(?:^|;\s*)session=([a-f0-9]+)/)?.[1];
    if (!token || !sessions.has(token)) return sendJson(response, 401, { error: 'Bitte zuerst anmelden.' });

    if (path === '/api/state' && request.method === 'GET') {
      return sendJson(response, 200, {
        games: db.prepare('SELECT games.*, address_versions.address AS home_address FROM games LEFT JOIN address_versions ON address_versions.id=games.address_version_id ORDER BY game_date DESC, game_time DESC').all(),
        expenses: db.prepare('SELECT * FROM expenses ORDER BY expense_date DESC, id DESC').all(),
        address: currentAddress(),
        addressHistory: db.prepare('SELECT * FROM address_versions ORDER BY effective_from DESC, id DESC').all(),
        venueDistances: db.prepare('SELECT * FROM venue_distances ORDER BY stadium COLLATE NOCASE').all(),
        salaryRates: db.prepare('SELECT * FROM salary_rates ORDER BY season DESC, age_group, league, system, role, round_stage').all(),
        currentSeason: db.prepare("SELECT value FROM app_settings WHERE key='current_season'").get()?.value || '2026/27',
      });
    }

    if (path === '/api/settings/season' && request.method === 'POST') {
      const { season } = await readJson(request);
      if (typeof season !== 'string' || !/^\d{4}\/\d{2}$/.test(season)) return sendJson(response, 400, { error: 'Saison bitte im Format 2026/27 eingeben.' });
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('current_season', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(season);
      return sendJson(response, 200, { season });
    }

    const rateMatch = path.match(/^\/api\/rates(?:\/(\d+))?$/);
    if (rateMatch) {
      const id = Number(rateMatch[1]);
      if (request.method === 'POST' || request.method === 'PUT') {
        const rate = await readJson(request);
        const fee = numberOrNull(rate.fee);
        const required = ['season', 'age_group', 'system'];
        if (required.some((key) => typeof rate[key] !== 'string' || !rate[key].trim()) || !/^\d{4}\/\d{2}$/.test(rate.season) || fee === null || Number.isNaN(fee)) return sendJson(response, 400, { error: 'Saison, Altersklasse, System und ein gültiges Gehalt sind erforderlich.' });
        const values = [rate.season.trim(), rate.age_group.trim(), (rate.league || '').trim(), rate.system.trim(), (rate.role || '').trim(), (rate.round_stage || '').trim(), fee];
        try {
          if (request.method === 'PUT') {
            db.prepare('UPDATE salary_rates SET season=?, age_group=?, league=?, system=?, role=?, round_stage=?, fee=? WHERE id=?').run(...values, id);
            return sendJson(response, 200, db.prepare('SELECT * FROM salary_rates WHERE id=?').get(id));
          }
          const result = db.prepare('INSERT INTO salary_rates (season, age_group, league, system, role, round_stage, fee) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (season, age_group, league, system, role, round_stage) DO UPDATE SET fee=excluded.fee').run(...values);
          return sendJson(response, 201, db.prepare('SELECT * FROM salary_rates WHERE id=? OR (season=? AND age_group=? AND league=? AND system=? AND role=? AND round_stage=?) ORDER BY id DESC LIMIT 1').get(result.lastInsertRowid, ...values.slice(0, 6)));
        } catch (error) {
          if (error.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE') return sendJson(response, 409, { error: 'Diese Tarifkombination existiert in der Saison bereits.' });
          throw error;
        }
      }
      if (request.method === 'DELETE' && id) {
        db.prepare('DELETE FROM salary_rates WHERE id=?').run(id);
        return sendJson(response, 200, { ok: true });
      }
    }

    if (path === '/api/settings/address' && request.method === 'POST') {
      const { address, effective_from: effectiveFrom } = await readJson(request);
      if (typeof address !== 'string' || !address.trim() || address.length > 500) return sendJson(response, 400, { error: 'Bitte eine gültige Heimatadresse eingeben.' });
      if (!validDate(effectiveFrom)) return sendJson(response, 400, { error: 'Bitte ein gültiges Gültig-ab-Datum angeben.' });
      const existing = db.prepare('SELECT * FROM address_versions WHERE effective_from=? ORDER BY id DESC LIMIT 1').get(effectiveFrom);
      if (existing?.address.trim() === address.trim()) return sendJson(response, 200, existing);
      const result = db.prepare('INSERT INTO address_versions (address, effective_from) VALUES (?, ?)').run(address.trim(), effectiveFrom);
      db.prepare(`UPDATE games SET address_version_id=(SELECT id FROM address_versions WHERE effective_from<=games.game_date ORDER BY effective_from DESC, id DESC LIMIT 1)`).run();
      return sendJson(response, 201, db.prepare('SELECT * FROM address_versions WHERE id=?').get(result.lastInsertRowid));
    }

    const venueMatch = path.match(/^\/api\/venues(?:\/(\d+))?$/);
    if (venueMatch && request.method === 'POST') {
      const venue = await readJson(request);
      const routeKm = numberOrNull(venue.route_km);
      if (typeof venue.stadium !== 'string' || !venue.stadium.trim() || venue.stadium.length > 250 || typeof venue.stadium_address !== 'string' || !venue.stadium_address.trim() || venue.stadium_address.length > 250 || routeKm === null || Number.isNaN(routeKm)) return sendJson(response, 400, { error: 'Spielort, Stadionadresse und eine gültige Kilometerzahl sind erforderlich.' });
      const address = currentAddress();
      if (!address) return sendJson(response, 400, { error: 'Bitte zuerst die Heimatadresse hinterlegen.' });
      saveVenueDistance(address.address, venue.stadium, venue.stadium_address, routeKm);
      return sendJson(response, 200, findVenueDistance(address.address, venue.stadium_address));
    }
    if (venueMatch && request.method === 'DELETE' && venueMatch[1]) {
      db.prepare('DELETE FROM venue_distances WHERE id=?').run(Number(venueMatch[1]));
      return sendJson(response, 200, { ok: true });
    }

    if (path === '/api/import' && request.method === 'POST') {
      try {
        const imported = await runImportParser();
        const warnings = existsSync(join(root, 'Spiele', 'Gehalt Schiedsrichter.xlsx'))
          ? []
          : ['Gehalts- und Ausgabendatei fehlt; diese Daten wurden nicht importiert.'];
        return sendJson(response, 200, { counts: applyImport(imported), parsed: imported.counts, warnings });
      } catch (error) {
        return sendJson(response, 400, { error: error.message || 'Excel-Import ist fehlgeschlagen.' });
      }
    }

    const gameMatch = path.match(/^\/api\/games(?:\/(\d+))?$/);
    if (gameMatch) {
      const id = Number(gameMatch[1]);
      if (request.method === 'POST' || request.method === 'PUT') {
        const body = await readJson(request);
        const error = validateGame(body);
        if (error) return sendJson(response, 400, { error });
        if (request.method === 'PUT' && (!id || !db.prepare('SELECT id FROM games WHERE id=?').get(id))) return sendJson(response, 404, { error: 'Spiel nicht gefunden.' });
        return sendJson(response, request.method === 'POST' ? 201 : 200, insertGame(body, request.method === 'PUT' ? id : null));
      }
      if (request.method === 'DELETE' && id) {
        db.prepare('DELETE FROM games WHERE id=?').run(id);
        return sendJson(response, 200, { ok: true });
      }
    }

    const expenseMatch = path.match(/^\/api\/expenses(?:\/(\d+))?$/);
    if (expenseMatch) {
      const id = Number(expenseMatch[1]);
      if (request.method === 'POST' || request.method === 'PUT') {
        const expense = await readJson(request, 36 * 1024 * 1024);
        const amount = numberOrNull(expense.amount);
        if (!validDate(expense.expense_date) || !expense.category?.trim() || typeof expense.vendor !== 'string' || !expense.vendor.trim() || expense.vendor.length > 250 || !expense.description?.trim() || expense.description.length > 1000 || (expense.note !== undefined && typeof expense.note !== 'string') || (typeof expense.note === 'string' && expense.note.length > 2000) || amount === null || Number.isNaN(amount)) return sendJson(response, 400, { error: 'Bitte Datum, Kategorie, Rechnungssteller, Beschreibung und einen gültigen Betrag angeben. Rechnungssteller dürfen höchstens 250, Beschreibung 1.000 und Bemerkung 2.000 Zeichen lang sein.' });
        const vendor = expense.vendor.trim();
        const note = (expense.note || '').trim();
        let attachment;
        try { attachment = await saveAttachment(expense.attachment); } catch (error) { return sendJson(response, 400, { error: error.message }); }
        if (request.method === 'PUT') {
          if (attachment) db.prepare('UPDATE expenses SET expense_date=?, category=?, vendor=?, description=?, note=?, amount=?, attachment_path=?, attachment_name=?, attachment_type=? WHERE id=?').run(expense.expense_date, expense.category.trim(), vendor, expense.description.trim(), note, amount, attachment.path, attachment.name, attachment.type, id);
          else db.prepare('UPDATE expenses SET expense_date=?, category=?, vendor=?, description=?, note=?, amount=? WHERE id=?').run(expense.expense_date, expense.category.trim(), vendor, expense.description.trim(), note, amount, id);
          return sendJson(response, 200, db.prepare('SELECT * FROM expenses WHERE id=?').get(id));
        }
        const result = db.prepare('INSERT INTO expenses (expense_date, category, vendor, description, note, amount, attachment_path, attachment_name, attachment_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(expense.expense_date, expense.category.trim(), vendor, expense.description.trim(), note, amount, attachment?.path ?? null, attachment?.name ?? null, attachment?.type ?? null);
        return sendJson(response, 201, db.prepare('SELECT * FROM expenses WHERE id=?').get(result.lastInsertRowid));
      }
      if (request.method === 'DELETE' && id) {
        const expense = db.prepare('SELECT attachment_path FROM expenses WHERE id=?').get(id);
        db.prepare('DELETE FROM expenses WHERE id=?').run(id);
        if (expense?.attachment_path) await unlink(expense.attachment_path).catch(() => {});
        return sendJson(response, 200, { ok: true });
      }
    }

    const attachmentMatch = path.match(/^\/api\/expenses\/(\d+)\/attachment$/);
    if (attachmentMatch && request.method === 'GET') {
      const expense = db.prepare('SELECT attachment_path, attachment_name, attachment_type FROM expenses WHERE id=?').get(Number(attachmentMatch[1]));
      if (!expense?.attachment_path || !existsSync(expense.attachment_path)) return sendJson(response, 404, { error: 'Belegdatei nicht gefunden.' });
      response.writeHead(200, {
        'Content-Type': expense.attachment_type,
        'Content-Disposition': `inline; filename="${encodeURIComponent(expense.attachment_name)}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      return createReadStream(expense.attachment_path).pipe(response);
    }

    if (path === '/api/export' && request.method === 'GET') {
      const year = url.searchParams.get('year');
      const type = url.searchParams.get('type');
      if (!/^\d{4}$/.test(year || '') || !['income', 'expenses'].includes(type)) return sendJson(response, 400, { error: 'Ungültiges Exportjahr oder Exportformat.' });
      if (type === 'income') {
        const games = db.prepare("SELECT * FROM games WHERE substr(game_date,1,4)=? AND (game_date || ' ' || game_time || ':00') <= datetime('now','localtime') ORDER BY game_date, game_time").all(year);
        const rows = [[`Einnahmenübersicht zur Vorlage beim Finanzamt – ${year}`], ['Datum', 'Uhrzeit', 'Altersklasse', 'System', 'Heim', 'Gast', 'Eisstadion', 'Gehalt EUR']];
        for (const game of games) rows.push([game.game_date, game.game_time, game.age_group, game.system, game.home_team, game.away_team, game.stadium, euro(game.fee)]);
        return csvResponse(response, `Einnahmen_Finanzamt_${year}.csv`, rows);
      }
      const games = db.prepare('SELECT * FROM games WHERE substr(game_date,1,4)=? ORDER BY game_date, game_time, id').all(year);
      const routeKmById = billableRouteKilometers(games);
      const now = new Date();
      const expenses = db.prepare('SELECT * FROM expenses WHERE substr(expense_date,1,4)=? ORDER BY expense_date').all(year);
      const rows = [[`Ausgabenübersicht zur Vorlage beim Finanzamt – ${year}`], ['Datum', 'Art', 'Kategorie', 'Rechnungssteller / bezahlt bei', 'Beschreibung', 'Bemerkung', 'Betrag EUR']];
      let totalRouteKm = 0;
      let hasMileage = false;
      for (const game of games) {
        const routeKm = routeKmById.get(game.id);
        if (routeKm === null || new Date(`${game.game_date}T${game.game_time || '00:00'}:00`) > now) continue;
        hasMileage = true;
        totalRouteKm += routeKm;
      }
      let totalExpensesCents = expenses.reduce((sum, expense) => sum + Math.round(Number(expense.amount) * 100), 0);
      if (hasMileage) {
        const totalMileageCents = Math.round(totalRouteKm * 38);
        const formattedRouteKm = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(totalRouteKm);
        totalExpensesCents += totalMileageCents;
        rows.push([`${year}-12-31`, 'Fahrt', 'Fahrtkosten', '', `${formattedRouteKm} km x 0,38 €/km`, '', euro(totalMileageCents / 100)]);
      }
      for (const expense of expenses) rows.push([expense.expense_date, 'Ausgabe', expense.category, expense.vendor || '', expense.description, expense.note || '', euro(expense.amount)]);
      rows.splice(2, rows.length - 2, ...rows.slice(2).sort((a, b) => a[0].localeCompare(b[0])));
      rows.push(['', 'Summe genau', '', '', '', '', euro(totalExpensesCents / 100)]);
      rows.push(['', 'Summe abgerundet auf volle Euro', '', '', '', '', euro(Math.floor(totalExpensesCents / 100))]);
      return csvResponse(response, `Ausgaben_Finanzamt_${year}.csv`, rows);
    }

    return sendJson(response, 404, { error: 'API-Endpunkt nicht gefunden.' });
  }

  const relativePath = path === '/' ? 'index.html' : normalize(path.replace(/^\/+/, ''));
  const filename = join(publicDir, relativePath);
  if (!filename.startsWith(`${publicDir}/`) || !existsSync(filename)) {
    response.writeHead(404);
    return response.end('Nicht gefunden');
  }
  response.writeHead(200, { 'Content-Type': mimeTypes[extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  return createReadStream(filename).pipe(response);
}

const server = createServer((request, response) => {
  serve(request, response).catch((error) => {
    console.error(error);
    if (!response.headersSent) sendJson(response, 500, { error: 'Interner Fehler. Bitte Serverprotokoll prüfen.' });
    else response.destroy();
  });
});

const port = Number(process.env.PORT || 4173);
server.listen(port, '0.0.0.0', () => {
  console.log(`Schiedsrichter-App läuft auf http://localhost:${port}`);
  console.log(`Zugangscode: ${accessPassword}`);
  console.log(`Datenbank: ${databasePath}`);
  console.log('Für den Zugriff im WLAN die lokale IP-Adresse dieses MacBook verwenden.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    db.close();
    server.close(() => process.exit(0));
  });
}