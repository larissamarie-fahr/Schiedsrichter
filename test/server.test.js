import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function availablePort() {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('private app records games, preserves address history, and exports annual data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'referee-app-test-'));
  const port = await availablePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), APP_PASSWORD: 'test-access-code', DATABASE_PATH: join(directory, 'test.sqlite') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  const baseUrl = `http://127.0.0.1:${port}`;
  let cookie;
  const request = async (path, options = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    });
    return response;
  };

  try {
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
      if (child.exitCode !== null) throw new Error(output);
      try {
        const response = await fetch(baseUrl);
        ready = response.status === 200;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.equal(ready, true, `Server did not start: ${output}`);

    assert.equal((await request('/api/state')).status, 401);
    const login = await request('/api/login', { method: 'POST', body: JSON.stringify({ password: 'test-access-code' }) });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie').split(';')[0];

    const initialState = await (await request('/api/state')).json();
    assert.equal(initialState.currentSeason, '2026/27');
    assert.equal(initialState.salaryRates.length, 29);
    assert.equal(initialState.salaryRates.find((rate) => rate.age_group === 'U17' && rate.system === '2-Mann').fee, 95);

    const nextSeasonRate = await request('/api/rates', {
      method: 'POST',
      body: JSON.stringify({ season: '2027/28', age_group: 'U17', league: '', system: '2-Mann', role: '', round_stage: '', fee: '105' }),
    });
    assert.equal(nextSeasonRate.status, 201);
    await request('/api/settings/season', { method: 'POST', body: JSON.stringify({ season: '2027/28' }) });

    await request('/api/settings/address', { method: 'POST', body: JSON.stringify({ address: 'Alte Straße 1, 80000 München', effective_from: '2020-01-01' }) });
    const gameResponse = await request('/api/games', {
      method: 'POST',
      body: JSON.stringify({ game_date: '2026-02-14', game_time: '18:30', age_group: 'U17', system: '3-Mann', season: '2026/27', home_team: 'EHC Heim', away_team: 'EV Gast', stadium: 'Eiszentrum', stadium_address: 'Stadionweg 1, 80000 München', fee: '85', route_km: '68', route_mode: 'manual' }),
    });
    const gameText = await gameResponse.text();
    assert.equal(gameResponse.status, 201, gameText);
    const game = JSON.parse(gameText);
    assert.equal(game.fee, 85);

    const autoFeeResponse = await request('/api/games', {
      method: 'POST',
      body: JSON.stringify({ game_date: '2027-01-15', game_time: '18:30', age_group: 'U17', system: '2-Mann', league: '', role: '', round_stage: '', season: '2027/28', fee: '0', fee_manual: false, home_team: 'EV Saison', away_team: 'EC Saison', stadium: 'Eiszentrum', stadium_address: 'Stadionweg 1, 80000 München' }),
    });
    assert.equal(autoFeeResponse.status, 201);
    const futureGame = await autoFeeResponse.json();
    assert.equal(futureGame.fee, 105);

    const bylGameResponse = await request('/api/games', {
      method: 'POST',
      body: JSON.stringify({ game_date: '2026-03-20', game_time: '19:30', age_group: 'BYL', system: '4-Mann', role: 'Hauptschiedsrichter', round_stage: 'PlayOff/-Down', season: '2026/27', fee: '0', fee_manual: false, home_team: 'EV Playoff', away_team: 'EC Playoff', stadium: 'Eiszentrum', stadium_address: 'Stadionweg 1, 80000 München' }),
    });
    assert.equal(bylGameResponse.status, 201);
    assert.equal((await bylGameResponse.json()).fee, 250);

    const invalidBylResponse = await request('/api/games', {
      method: 'POST',
      body: JSON.stringify({ game_date: '2026-03-21', game_time: '19:30', age_group: 'BYL', system: '2-Mann', season: '2026/27', fee: '120', home_team: 'EV Ungültig', away_team: 'EC Ungültig', stadium: 'Eiszentrum', stadium_address: 'Stadionweg 1, 80000 München' }),
    });
    assert.equal(invalidBylResponse.status, 400);

    await request('/api/settings/address', { method: 'POST', body: JSON.stringify({ address: 'Neue Straße 4, 80000 München', effective_from: '2025-01-01' }) });
    await request(`/api/games/${game.id}`, {
      method: 'PUT',
      body: JSON.stringify({ game_date: game.game_date, game_time: game.game_time, age_group: game.age_group, system: game.system, home_team: game.home_team, away_team: game.away_team, stadium: game.stadium, stadium_address: game.stadium_address, fee: game.fee, route_km: game.route_km, route_mode: game.route_mode }),
    });
    const stateResponse = await request('/api/state');
    const state = await stateResponse.json();
    assert.equal(state.games[0].home_address, 'Neue Straße 4, 80000 München');
    assert.equal(state.addressHistory.length, 2);
    assert.equal(state.games.some((item) => item.id === futureGame.id), true);

    const expenseResponse = await request('/api/expenses', {
      method: 'POST',
      body: JSON.stringify({ expense_date: '2026-02-14', category: 'Parken', description: '=SUM(1,1)', amount: '4.5', attachment: { name: 'Beleg.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 test').toString('base64') } }),
    });
    const expenseText = await expenseResponse.text();
    assert.equal(expenseResponse.status, 201, expenseText);
    const savedExpense = JSON.parse(expenseText);
    const attachmentResponse = await request(`/api/expenses/${savedExpense.id}/attachment`);
    assert.equal(attachmentResponse.status, 200);
    assert.match(await attachmentResponse.text(), /%PDF-1.4 test/);

    const incomeCsv = await request('/api/export?year=2026&type=income');
    const incomeText = await incomeCsv.text();
    assert.match(incomeText, /EHC Heim/);
    assert.match(incomeText, /85,00/);
    const expensesCsv = await request('/api/export?year=2026&type=expenses');
    const expensesText = await expensesCsv.text();
    assert.match(expensesText, /20,40/);
    assert.match(expensesText, /'=SUM\(1,1\)/);
    const futureIncomeCsv = await request('/api/export?year=2027&type=income');
    assert.doesNotMatch(await futureIncomeCsv.text(), /EV Saison/);
    const futureExpensesCsv = await request('/api/export?year=2027&type=expenses');
    assert.doesNotMatch(await futureExpensesCsv.text(), /EV Saison/);
    assert.equal((await request('/api/route', { method: 'POST', body: JSON.stringify({ from: 'a', to: 'b' }) })).status, 503);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await rm(directory, { recursive: true, force: true });
  }
});