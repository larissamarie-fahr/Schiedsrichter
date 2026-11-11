const state = { games: [], expenses: [], address: null, addressHistory: [], venueDistances: [], salaryRates: [], currentSeason: '2026/27', year: new Date().getFullYear(), view: 'overview' };
const savedView = localStorage.getItem('schiedsrichter-app-view');
if (['overview', 'games', 'expenses', 'settings'].includes(savedView)) state.view = savedView;
const savedScrollPositions = JSON.parse(localStorage.getItem('schiedsrichter-app-scroll-positions') || '{}');
const savedDetailsState = JSON.parse(localStorage.getItem('schiedsrichter-app-details-state') || '{}');
const renderedGameStartState = new Map();
let scrollSaveTimer;
let suppressScrollSave = false;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const money = (value) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(Number(value || 0));
const dateText = (value) => value ? new Intl.DateTimeFormat('de-DE').format(new Date(`${value}T12:00:00`)) : '';
const today = () => new Date().toISOString().slice(0, 10);
const safe = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const hasStarted = (game, now = new Date()) => new Date(`${game.game_date}T${game.game_time || '00:00'}:00`) <= now;

function effectiveRouteKilometers(games) {
  const distances = new Map(games.map((game) => [game.id, game.route_km === null ? null : Number(game.route_km)]));
  const ordered = [...games].sort((a, b) => `${a.game_date}T${a.game_time}`.localeCompare(`${b.game_date}T${b.game_time}`) || a.id - b.id);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const previousVenue = (previous.stadium_address || previous.stadium).trim().toLocaleLowerCase('de-DE').replace(/\s+/g, ' ');
    const currentVenue = (current.stadium_address || current.stadium).trim().toLocaleLowerCase('de-DE').replace(/\s+/g, ' ');
    if (previous.game_date !== current.game_date || previousVenue !== currentVenue || previous.route_km === null || current.route_km === null) continue;
    distances.set(previous.id, Number(previous.route_km) / 2);
    distances.set(current.id, Number(current.route_km) / 2);
  }
  return distances;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    const error = new Error(payload?.error || 'Die Anfrage ist fehlgeschlagen.');
    error.status = response.status;
    throw error;
  }
  return payload;
}

function showNotice(message) {
  const notice = $('#notice');
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => { notice.hidden = true; }, 5000);
}

function setView(view) {
  if (!['overview', 'games', 'expenses', 'settings'].includes(view)) return;
  state.view = view;
  localStorage.setItem('schiedsrichter-app-view', view);
  $$('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  $$('.view-panel').forEach((panel) => { panel.hidden = panel.dataset.panel !== view; });
  const titles = {
    overview: ['SAISONÜBERSICHT', 'Dein Jahr auf dem Eis'],
    games: ['EINTEILUNGEN UND SPIELE', 'Alle Spiele'],
    expenses: ['BELEGE UND SONSTIGE KOSTEN', 'Deine Ausgaben'],
    settings: ['PERSÖNLICHE ANGABEN', 'Einstellungen'],
  };
  $('#heading-kicker').textContent = titles[view][0];
  $('#page-title').textContent = titles[view][1];
  if (!$('#app-view').hidden) restoreScrollPosition(view);
}

function restoreDetailsState() {
  $$('details[data-layout-key]').forEach((details) => {
    const savedOpen = savedDetailsState[details.dataset.layoutKey];
    if (typeof savedOpen === 'boolean') details.open = savedOpen;
  });
}

function saveDetailsState() {
  $$('details[data-layout-key]').forEach((details) => {
    savedDetailsState[details.dataset.layoutKey] = details.open;
  });
  localStorage.setItem('schiedsrichter-app-details-state', JSON.stringify(savedDetailsState));
}

function saveScrollPosition() {
  if ($('#app-view').hidden || suppressScrollSave) return;
  savedScrollPositions[state.view] = window.scrollY;
  localStorage.setItem('schiedsrichter-app-scroll-positions', JSON.stringify(savedScrollPositions));
}

function restoreScrollPosition(view = state.view) {
  const position = Math.max(0, Number(savedScrollPositions[view]) || 0);
  clearTimeout(scrollSaveTimer);
  suppressScrollSave = true;
  requestAnimationFrame(() => {
    window.scrollTo(0, position);
    setTimeout(() => {
      suppressScrollSave = false;
      saveScrollPosition();
    }, 150);
  });
}

function getYearOptions() {
  const years = new Set([new Date().getFullYear(), ...state.games.map((game) => Number(game.game_date.slice(0, 4))), ...state.expenses.map((expense) => Number(expense.expense_date.slice(0, 4)))]);
  return [...years].filter(Number.isFinite).sort((a, b) => b - a);
}

function gameRows(games, routeKmById, limit = Infinity, emptyMessage = 'Noch keine Spiele für dieses Jahr erfasst.') {
  const chosen = games.slice(0, limit);
  if (!chosen.length) return `<div class="empty-state">${emptyMessage}</div>`;
  return `<table><thead><tr><th>Datum</th><th>Spiel</th><th>System</th><th class="numeric">Gehalt</th><th class="numeric">Kilometer</th><th class="numeric">Aktion</th></tr></thead><tbody>${chosen.map((game) => {
    const routeKm = routeKmById.get(game.id) ?? game.route_km;
    return `<tr class="${hasStarted(game) ? '' : 'upcoming-row'}"><td>${dateText(game.game_date)}<span class="subtext">${safe(game.game_time)}${hasStarted(game) ? '' : ' · Kommend'}</span></td><td><strong>${safe(game.home_team)} – ${safe(game.away_team)}</strong><span class="subtext">${safe(game.age_group)} · ${safe(game.stadium)}</span></td><td>${safe(game.system)}</td><td class="numeric">${money(game.fee)}</td><td class="numeric">${routeKm === null ? '–' : `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(routeKm)} km`}</td><td><div class="row-actions"><button class="text-action" data-action="edit-game" data-id="${game.id}">Bearbeiten</button><button class="text-action delete" data-action="delete-game" data-id="${game.id}">Löschen</button></div></td></tr>`;
  }).join('')}</tbody></table>`;
}

function render() {
  renderedGameStartState.clear();
  for (const game of state.games) renderedGameStartState.set(game.id, hasStarted(game));
  const yearSelect = $('#year-select');
  const years = getYearOptions();
  if (!years.includes(state.year)) years.unshift(state.year);
  yearSelect.innerHTML = years.map((year) => `<option value="${year}" ${year === state.year ? 'selected' : ''}>${year}</option>`).join('');

  const allYearGames = state.games.filter((game) => Number(game.game_date.slice(0, 4)) === state.year);
  const yearGames = allYearGames.filter((game) => hasStarted(game));
  const routeKmById = effectiveRouteKilometers(state.games);
  const upcomingGames = state.games.filter((game) => !hasStarted(game)).sort((a, b) => `${a.game_date}T${a.game_time}`.localeCompare(`${b.game_date}T${b.game_time}`));
  const yearExpenses = state.expenses.filter((expense) => Number(expense.expense_date.slice(0, 4)) === state.year);
  const income = yearGames.reduce((sum, game) => sum + Number(game.fee), 0);
  const km = yearGames.reduce((sum, game) => sum + Number(routeKmById.get(game.id) ?? game.route_km ?? 0), 0);
  const mileage = yearGames.reduce((sum, game) => sum + Number(routeKmById.get(game.id) ?? game.route_km ?? 0) * Number(game.mileage_rate || 0.3), 0);
  const otherExpenses = yearExpenses.reduce((sum, expense) => sum + Number(expense.amount), 0);
  const monthlyIncome = Array.from({ length: 12 }, () => ({ games: 0, income: 0 }));
  for (const game of yearGames) {
    const monthIndex = Number(game.game_date.slice(5, 7)) - 1;
    if (monthIndex < 0 || monthIndex > 11) continue;
    monthlyIncome[monthIndex].games += 1;
    monthlyIncome[monthIndex].income += Number(game.fee || 0);
  }
  $('#stat-games').textContent = yearGames.length;
  $('#stat-game-detail').textContent = yearGames.length === 1 ? 'Spiel im ausgewählten Jahr' : 'im ausgewählten Jahr';
  $('#stat-income').textContent = money(income);
  $('#stat-mileage').textContent = money(mileage);
  const mileageRate = state.year >= 2026 ? '0,38' : '0,30';
  $('#stat-km').textContent = `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(km)} km · ${mileageRate} €/km`;
  $('#stat-expenses').textContent = money(otherExpenses);
  $('#summary-year').textContent = state.year;
  $('#summary-income').textContent = money(income);
  $('#summary-mileage').textContent = `− ${money(mileage)}`;
  $('#summary-expenses').textContent = `− ${money(otherExpenses)}`;
  $('#summary-net').textContent = money(income - mileage - otherExpenses);
  $('#monthly-income').innerHTML = `<table><thead><tr><th>Monat</th><th class="numeric">Spiele</th><th class="numeric">Einnahmen</th></tr></thead><tbody>${monthlyIncome.map((total, index) => {
    const label = new Intl.DateTimeFormat('de-DE', { month: 'long' }).format(new Date(state.year, index, 1));
    return `<tr><td>${label.charAt(0).toLocaleUpperCase('de-DE')}${label.slice(1)}</td><td class="numeric">${total.games}</td><td class="numeric">${money(total.income)}</td></tr>`;
  }).join('')}</tbody><tfoot><tr><th>Gesamt</th><th class="numeric">${yearGames.length}</th><th class="numeric">${money(income)}</th></tr></tfoot></table>`;
  const completedGames = state.games.filter((game) => hasStarted(game));
  const careerIncome = completedGames.reduce((sum, game) => sum + Number(game.fee), 0);
  $('#career-games').textContent = new Intl.NumberFormat('de-DE').format(completedGames.length);
  $('#career-income').textContent = money(careerIncome);
  const seasonTotals = new Map();
  for (const game of completedGames) {
    const total = seasonTotals.get(game.season) || { games: 0, income: 0, km: 0 };
    total.games += 1;
    total.income += Number(game.fee || 0);
    total.km += Number(routeKmById.get(game.id) ?? game.route_km ?? 0);
    seasonTotals.set(game.season, total);
  }
  $('#season-stats').innerHTML = seasonTotals.size
    ? `<table><thead><tr><th>Saison</th><th class="numeric">Spiele</th><th class="numeric">Gehalt</th><th class="numeric">Kilometer</th></tr></thead><tbody>${[...seasonTotals.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([season, total]) => `<tr><td>${safe(season)}</td><td class="numeric">${total.games}</td><td class="numeric">${money(total.income)}</td><td class="numeric">${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(total.km)} km</td></tr>`).join('')}</tbody></table>`
    : '<div class="empty-state">Noch keine Saisonspiele vorhanden.</div>';
  $('#income-export').href = `/api/export?year=${state.year}&type=income`;
  $('#expense-export').href = `/api/export?year=${state.year}&type=expenses`;
  $('#overview-games').innerHTML = gameRows(upcomingGames, routeKmById, 5, 'Keine kommenden Spiele geplant.');
  $('#games-table').innerHTML = gameRows(allYearGames, routeKmById);
  $('#game-count').textContent = `(${allYearGames.length})`;
  $('#expense-count').textContent = `(${yearExpenses.length})`;
  renderExpenses(yearExpenses);
  renderSettings();
  renderRates();
}

function renderExpenses(expenses) {
  if (!expenses.length) {
    $('#expenses-table').innerHTML = '<div class="empty-state">Für dieses Jahr sind noch keine sonstigen Ausgaben erfasst.</div>';
    return;
  }
  $('#expenses-table').innerHTML = `<table><thead><tr><th>Datum</th><th>Kategorie</th><th>Rechnungssteller / bezahlt bei</th><th>Beschreibung / Bemerkung</th><th>Beleg</th><th class="numeric">Betrag</th><th class="numeric">Aktion</th></tr></thead><tbody>${expenses.map((expense) => `<tr><td>${dateText(expense.expense_date)}</td><td>${safe(expense.category)}</td><td>${safe(expense.vendor || '–')}</td><td>${safe(expense.description)}${expense.note ? `<div class="subtext">${safe(expense.note)}</div>` : ''}</td><td>${expense.attachment_path ? `<a class="text-action" href="/api/expenses/${expense.id}/attachment" target="_blank" rel="noopener">${safe(expense.attachment_name || 'Ansehen')}</a>` : '<span class="subtext">–</span>'}</td><td class="numeric">${money(expense.amount)}</td><td><div class="row-actions"><button class="text-action" data-action="edit-expense" data-id="${expense.id}">Bearbeiten</button><button class="text-action delete" data-action="delete-expense" data-id="${expense.id}">Löschen</button></div></td></tr>`).join('')}</tbody></table>`;
}

function renderSettings() {
  $('#home-address').value = state.address?.address || '';
  $('#address-effective-from').value = state.address?.effective_from || today();
  $('#address-history').innerHTML = state.addressHistory.length
    ? state.addressHistory.map((entry) => `<div class="history-entry"><span>${safe(entry.address)}</span><time>Gültig ab ${dateText(entry.effective_from)}</time></div>`).join('')
    : '<div class="empty-state">Noch keine Heimatadresse hinterlegt.</div>';
  const currentVenues = state.venueDistances.filter((venue) => venue.home_address.trim().toLocaleLowerCase('de-DE') === (state.address?.address || '').trim().toLocaleLowerCase('de-DE'));
  $('#venue-distance-table').innerHTML = currentVenues.length
    ? `<table><thead><tr><th>Spielort</th><th>Adresse</th><th class="numeric">Hin und zurück</th><th class="numeric">Aktion</th></tr></thead><tbody>${currentVenues.map((venue) => `<tr><td>${safe(venue.stadium)}</td><td>${safe(venue.stadium_address)}</td><td class="numeric">${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(venue.route_km)} km</td><td><div class="row-actions"><button class="text-action" data-action="edit-venue" data-id="${venue.id}">Bearbeiten</button><button class="text-action delete" data-action="delete-venue" data-id="${venue.id}">Entfernen</button></div></td></tr>`).join('')}</tbody></table>`
    : '<div class="empty-state">Für diese Heimatadresse sind noch keine Spielorte gespeichert.</div>';
  $('#current-season').value = state.currentSeason;
}

function renderRates() {
  const seasons = [...new Set([state.currentSeason, ...state.salaryRates.map((rate) => rate.season)])].sort().reverse();
  const filter = $('#rate-season-filter');
  const selected = filter.value || state.currentSeason;
  filter.innerHTML = seasons.map((season) => `<option value="${safe(season)}">${safe(season)}</option>`).join('');
  filter.value = seasons.includes(selected) ? selected : state.currentSeason;
  $('#rate-form').elements.season.value = filter.value;
  const rates = state.salaryRates.filter((rate) => rate.season === filter.value);
  $('#rates-table').innerHTML = rates.length
    ? `<table><thead><tr><th>Altersklasse</th><th>Liga</th><th>System</th><th>Funktion</th><th>Runde</th><th>Gehalt</th><th>Aktion</th></tr></thead><tbody>${rates.map((rate) => `<tr><td>${safe(rate.age_group)}</td><td>${safe(rate.league || '–')}</td><td>${safe(rate.system)}</td><td>${safe(rate.role || '–')}</td><td>${safe(rate.round_stage || '–')}</td><td>${money(rate.fee)}</td><td><div class="row-actions"><button class="text-action" data-action="edit-rate" data-id="${rate.id}">Bearbeiten</button><button class="text-action delete" data-action="delete-rate" data-id="${rate.id}">Entfernen</button></div></td></tr>`).join('')}</tbody></table>`
    : '<div class="empty-state">Für diese Saison sind noch keine Tarife hinterlegt.</div>';
  renderFeePreview();
}

function matchingRate(game) {
  return state.salaryRates.find((rate) => rate.season === game.season
    && rate.age_group === game.age_group
    && rate.league === (game.league || '')
    && rate.system === game.system
    && rate.role === (game.role || '')
    && rate.round_stage === (game.round_stage || ''));
}

function renderFeePreview() {
  const form = $('#game-form');
  if (!form) return;
  const manual = $('#fee-manual').checked;
  const feeInput = form.elements.fee;
  feeInput.disabled = !manual;
  if (manual) {
    $('#fee-preview').textContent = 'Manuell festgelegtes Gehalt';
    return;
  }
  const rate = matchingRate(formObject(form));
  if (rate) {
    feeInput.value = Number(rate.fee).toFixed(2);
    $('#fee-preview').textContent = `Tarif ${rate.season}: ${money(rate.fee)}`;
  } else {
    feeInput.value = '0';
    $('#fee-preview').textContent = 'Kein passender Tarif. Bitte Merkmale prüfen oder Gehalt manuell festlegen.';
  }
}

async function refresh() {
  const data = await api('/api/state');
  Object.assign(state, data);
  render();
}

async function restoreSession() {
  try {
    await refresh();
    restoreDetailsState();
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    restoreScrollPosition();
  } catch (error) {
    if (error.status !== 401) $('#login-error').textContent = error.message;
  }
}

function openGame(game = null) {
  const form = $('#game-form');
  form.reset();
  form.distanceAutofilled = false;
  form.elements.id.value = game?.id || '';
  form.elements.game_date.value = game?.game_date || today();
  form.elements.game_time.value = game?.game_time === '00:00' ? '' : game?.game_time || '18:00';
  for (const key of ['age_group', 'league', 'system', 'role', 'round_stage', 'season', 'home_team', 'away_team', 'fee', 'stadium', 'stadium_address', 'route_km']) {
    if (game && game[key] !== null && form.elements[key]) form.elements[key].value = game[key];
  }
  const gameSeasons = [...new Set([state.currentSeason, ...state.salaryRates.map((rate) => rate.season), ...state.games.map((item) => item.season)])].sort().reverse();
  form.elements.season.innerHTML = gameSeasons.map((season) => `<option value="${safe(season)}">${safe(season)}</option>`).join('');
  form.elements.season.value = game?.season || state.currentSeason;
  $('#fee-manual').checked = game ? Boolean(game.fee_manual) : false;
  if (!game) form.elements.fee.value = '0';
  $('#game-dialog-title').textContent = game ? 'Spiel bearbeiten' : 'Spiel erfassen';
  $('#game-error').textContent = '';
  $('#route-hint').textContent = 'Kilometer manuell eintragen oder gespeicherte Spielort-Entfernung übernehmen.';
  renderFeePreview();
  if (!game) applySavedVenueDistance();
  $('#game-dialog').showModal();
}

function homeAddressForDate(date) {
  return state.addressHistory.find((entry) => entry.effective_from <= date)?.address || '';
}

function applySavedVenueDistance() {
  const form = $('#game-form');
  if (form.elements.id.value || (form.elements.route_km.value && !form.distanceAutofilled)) return;
  const origin = homeAddressForDate(form.elements.game_date.value) || state.address?.address;
  const stadiumAddress = form.elements.stadium_address.value.trim().toLocaleLowerCase('de-DE');
  const venue = state.venueDistances.find((item) => item.home_address.trim().toLocaleLowerCase('de-DE') === (origin || '').trim().toLocaleLowerCase('de-DE')
    && item.stadium_address.trim().toLocaleLowerCase('de-DE') === stadiumAddress);
  form.elements.route_km.value = venue ? Number(venue.route_km).toFixed(1) : '';
  form.distanceAutofilled = Boolean(venue);
  $('#route-hint').textContent = venue
    ? `Gespeicherte Entfernung für ${venue.stadium}: ${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(venue.route_km)} km`
    : 'Kilometer manuell eintragen.';
}

function openExpense(expense = null) {
  const form = $('#expense-form');
  const categorySelect = form.elements.category;
  categorySelect.querySelectorAll('[data-legacy-category]').forEach((option) => option.remove());
  form.reset();
  if (expense && ![...categorySelect.options].some((option) => option.value === expense.category)) {
    const option = new Option(`${expense.category} (bisherige Kategorie)`, expense.category);
    option.dataset.legacyCategory = 'true';
    categorySelect.add(option);
  }
  form.elements.id.value = expense?.id || '';
  form.elements.expense_date.value = expense?.expense_date || today();
  for (const key of ['category', 'vendor', 'description', 'note', 'amount']) if (expense && form.elements[key]) form.elements[key].value = expense[key] || '';
  form.elements.attachment.value = '';
  const existingAttachment = $('#existing-attachment');
  existingAttachment.hidden = !expense?.attachment_path;
  if (expense?.attachment_path) {
    existingAttachment.href = `/api/expenses/${expense.id}/attachment`;
    existingAttachment.textContent = `Vorhandener Beleg: ${expense.attachment_name}`;
  }
  $('#expense-dialog-title').textContent = expense ? 'Ausgabe bearbeiten' : 'Ausgabe hinzufügen';
  $('#expense-error').textContent = '';
  $('#expense-dialog').showModal();
}

function formObject(form) {
  return Object.fromEntries(new FormData(form).entries());
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#access-code').value }) });
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    await refresh();
  } catch (error) {
    $('#login-error').textContent = error.message;
  }
});

$$('.nav-button').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
$$('details[data-layout-key]').forEach((details) => details.addEventListener('toggle', saveDetailsState));
window.addEventListener('scroll', () => {
  if (suppressScrollSave) return;
  clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(saveScrollPosition, 100);
}, { passive: true });
window.addEventListener('pagehide', saveScrollPosition);
$('#year-select').addEventListener('change', (event) => { state.year = Number(event.target.value); render(); });
document.addEventListener('click', async (event) => {
  const actionButton = event.target.closest('[data-action]');
  if (actionButton) {
    const { action, id } = actionButton.dataset;
    if (action === 'new-game') openGame();
    if (action === 'new-expense') openExpense();
    if (action === 'import-games') {
      const button = $('#import-button');
      button.disabled = true;
      button.textContent = 'Excel wird gelesen …';
      try {
        const result = await api('/api/import', { method: 'POST', body: JSON.stringify({}) });
        await refresh();
        const warning = result.warnings?.length ? ` Hinweis: ${result.warnings.join(' ')}` : '';
        showNotice(`Import abgeschlossen: ${result.counts.addedGames} neue Spiele, ${result.counts.updatedGames} ergänzt, ${result.counts.addedExpenses} Ausgaben. Erkannt: ${result.parsed.salaryGames} Gehaltsspiele und ${result.parsed.assignmentGames} Einteilungen.${warning}`);
      } catch (error) { showNotice(error.message); }
      finally { button.disabled = false; button.textContent = 'Excel übernehmen'; }
    }
    if (action === 'edit-game') openGame(state.games.find((game) => String(game.id) === id));
    if (action === 'edit-expense') openExpense(state.expenses.find((expense) => String(expense.id) === id));
    if (action === 'edit-venue') {
      const venue = state.venueDistances.find((item) => String(item.id) === id);
      const form = $('#venue-form');
      for (const key of ['stadium', 'stadium_address', 'route_km']) form.elements[key].value = venue[key];
      form.elements.stadium.focus();
    }
    if (action === 'delete-venue' && confirm('Diesen gespeicherten Spielort entfernen?')) {
      try { await api(`/api/venues/${id}`, { method: 'DELETE' }); await refresh(); } catch (error) { showNotice(error.message); }
    }
    if (action === 'edit-rate') {
      const rate = state.salaryRates.find((item) => String(item.id) === id);
      const form = $('#rate-form');
      for (const key of ['id', 'season', 'age_group', 'league', 'system', 'role', 'round_stage', 'fee']) form.elements[key].value = rate[key] || '';
      showNotice('Tarif geladen. Ändere die Werte und speichere den Tarif.');
    }
    if (action === 'delete-rate' && confirm('Diesen Saison-Tarif entfernen?')) {
      try { await api(`/api/rates/${id}`, { method: 'DELETE' }); await refresh(); } catch (error) { showNotice(error.message); }
    }
    if (action === 'delete-game' && confirm('Dieses Spiel wirklich löschen?')) {
      try { await api(`/api/games/${id}`, { method: 'DELETE' }); await refresh(); } catch (error) { showNotice(error.message); }
    }
    if (action === 'delete-expense' && confirm('Diese Ausgabe wirklich löschen?')) {
      try { await api(`/api/expenses/${id}`, { method: 'DELETE' }); await refresh(); } catch (error) { showNotice(error.message); }
    }
  }
  if (event.target.closest('[data-close]')) event.target.closest('dialog')?.close();
});

$('#game-form').addEventListener('input', (event) => {
  if (event.target.name === 'age_group' && event.target.value === 'BYL') $('#game-form').elements.system.value = '4-Mann';
  if (event.target.name === 'route_km') {
    $('#game-form').elements.route_mode.value = 'manual';
    $('#game-form').distanceAutofilled = false;
  }
  if (event.target.name === 'stadium_address') applySavedVenueDistance();
  if (event.target.name !== 'route_km') renderFeePreview();
});
$('#game-form').addEventListener('change', renderFeePreview);
$('#game-form').elements.game_date.addEventListener('change', () => {
  applySavedVenueDistance();
});
$('#fee-manual').addEventListener('change', renderFeePreview);
$('#rate-season-filter').addEventListener('change', () => {
  $('#rate-form').elements.id.value = '';
  renderRates();
});

$('#game-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = formObject(form);
  const id = data.id;
  delete data.id;
  data.fee_manual = $('#fee-manual').checked;
  $('#game-error').textContent = '';
  try {
    await api(`/api/games${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(data) });
    $('#game-dialog').close();
    await refresh();
    showNotice('Spiel wurde gespeichert.');
  } catch (error) { $('#game-error').textContent = error.message; }
});

$('#expense-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = formObject(form);
  const id = data.id;
  delete data.id;
  const file = form.elements.attachment.files[0];
  delete data.attachment;
  $('#expense-error').textContent = '';
  try {
    if (file) {
      if (file.size > 25 * 1024 * 1024) throw new Error('Der Beleg darf höchstens 25 MB groß sein.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      data.attachment = { name: file.name, type: file.type, data: btoa(binary) };
    }
    await api(`/api/expenses${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(data) });
    $('#expense-dialog').close();
    await refresh();
    showNotice('Ausgabe wurde gespeichert.');
  } catch (error) { $('#expense-error').textContent = error.message; }
});

$('#address-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/settings/address', { method: 'POST', body: JSON.stringify({ address: $('#home-address').value, effective_from: $('#address-effective-from').value }) });
    await refresh();
    $('#address-status').textContent = 'Adressversion gespeichert. Spiele sind anhand ihres Datums der passenden Adresse zugeordnet.';
  } catch (error) { showNotice(error.message); }
});

$('#venue-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('[type="submit"]');
  const originalLabel = submitButton.textContent;
  submitButton.disabled = true;
  submitButton.textContent = 'Speichert …';
  try {
    const venue = await api('/api/venues', { method: 'POST', body: JSON.stringify(formObject(form)) });
    const index = state.venueDistances.findIndex((item) => item.id === venue.id);
    if (index === -1) state.venueDistances.push(venue);
    else state.venueDistances[index] = venue;
    form.reset();
    renderSettings();
    showNotice('Spielort und Entfernung gespeichert.');
  } catch (error) {
    showNotice(error.message);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = originalLabel;
  }
});

$('#season-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/settings/season', { method: 'POST', body: JSON.stringify({ season: $('#current-season').value.trim() }) });
    await refresh();
    showNotice('Aktive Saison gespeichert.');
  } catch (error) { showNotice(error.message); }
});

$('#rate-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = formObject(form);
  const id = data.id;
  delete data.id;
  try {
    await api(`/api/rates${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(data) });
    form.reset();
    await refresh();
    showNotice('Saison-Tarif gespeichert.');
  } catch (error) { showNotice(error.message); }
});

$('#rate-form').elements.age_group.addEventListener('change', (event) => {
  if (event.target.value === 'BYL') $('#rate-form').elements.system.value = '4-Mann';
});

setView(state.view);
restoreSession();
setInterval(() => {
  if (!$('#app-view').hidden && state.games.some((game) => renderedGameStartState.get(game.id) !== hasStarted(game))) render();
}, 30_000);