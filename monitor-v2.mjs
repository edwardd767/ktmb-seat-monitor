import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import nodemailer from 'nodemailer';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STATE_PATH = path.join(ROOT, '.monitor-state.json');
const DEBUG_DIR = path.join(ROOT, 'debug');

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

function malaysiaDateISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function formatDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function normalizeText(value = '') {
  return String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return { notifiedRoutes: Array.isArray(state.notifiedRoutes) ? state.notifiedRoutes : [] };
  } catch {
    return { notifiedRoutes: [] };
  }
}

function writeState(notifiedRoutes) {
  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify({ notifiedRoutes: [...new Set(notifiedRoutes)].sort() }, null, 2) + '\n'
  );
}

async function selectStation(page, stationName, excludeIndex = -1) {
  const wanted = stationName.trim().toUpperCase();
  const selects = page.locator('select');
  const count = await selects.count();

  for (let i = 0; i < count; i++) {
    if (i === excludeIndex) continue;
    const select = selects.nth(i);
    const options = await select.locator('option').allTextContents().catch(() => []);
    const match = options.findIndex(x => normalizeText(x).toUpperCase() === wanted);
    if (match < 0) continue;

    const option = select.locator('option').nth(match);
    const value = await option.getAttribute('value');
    if (value != null) await select.selectOption(value);
    else await select.selectOption({ label: options[match] });

    await page.waitForTimeout(700);
    return i;
  }

  throw new Error(`Could not find station: ${stationName}`);
}

async function setDepartureDate(page, isoDate) {
  const [yearText, monthText, dayText] = isoDate.split('-');
  const targetYear = Number(yearText);
  const targetMonth = Number(monthText);
  const targetDay = Number(dayText);

  const input = page.locator('#OnwardDate');
  await input.waitFor({ state: 'visible', timeout: 10000 });
  await input.click({ force: true });

  const picker = page.locator('section.lightpick').filter({ visible: true }).first();
  await picker.waitFor({ state: 'visible', timeout: 5000 });

  for (let attempt = 0; attempt < 24; attempt++) {
    const monthSelect = picker.locator('.lightpick__select-months');
    const yearSelect = picker.locator('.lightpick__select-years');
    const currentMonth = Number(await monthSelect.inputValue()) + 1;
    const currentYear = Number(await yearSelect.inputValue());

    if (currentYear === targetYear && currentMonth === targetMonth) break;

    const currentIndex = currentYear * 12 + currentMonth;
    const targetIndex = targetYear * 12 + targetMonth;
    if (targetIndex > currentIndex) await picker.locator('.lightpick__next-action').click();
    else await picker.locator('.lightpick__previous-action').click();
    await page.waitForTimeout(180);

    if (attempt === 23) return false;
  }

  const target = picker
    .locator('.lightpick__day.is-available:not(.is-previous-month):not(.is-next-month)')
    .filter({ hasText: new RegExp(`^${targetDay}$`) })
    .first();

  if (!(await target.count())) return false;

  await target.click();
  await page.waitForTimeout(400);
  return Boolean(normalizeText(await input.inputValue()));
}

async function clickSearch(page) {
  const button = page.getByRole('button', { name: /^search$/i }).first();
  if (await button.count()) {
    await button.click();
    return;
  }

  const fallback = page.locator('input[type="submit"][value*="SEARCH" i]').first();
  if (await fallback.count()) {
    await fallback.click();
    return;
  }

  throw new Error('Could not find KTMB SEARCH button.');
}

async function detectTripStatus(page) {
  await page.waitForTimeout(1400);
  const bodyText = normalizeText(await page.locator('body').innerText().catch(() => ''));

  if (/NO\s+TRIPS?\s+FOUND/i.test(bodyText)) {
    return { open: false, reason: 'NO TRIPS FOUND', details: [] };
  }

  const details = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('tr, [role="row"], .card, .row')];
    const results = [];
    const seen = new Set();
    for (const row of rows) {
      const text = (row.innerText || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const looksLikeTrip = /MYR\s*[\d,.]+/i.test(text) || /PICK\s*SEATS?/i.test(text) || /AVAILABLE\s*SEATS?/i.test(text);
      if (looksLikeTrip && !seen.has(text)) {
        seen.add(text);
        results.push(text.slice(0, 500));
      }
      if (results.length >= 5) break;
    }
    return results;
  });

  if (details.length) return { open: true, reason: 'Trip results found', details };

  if (/MYR\s*[\d,.]+|PICK\s*SEATS?|AVAILABLE\s*SEATS?/i.test(bodyText)) {
    return { open: true, reason: 'Trip indicators found', details: [] };
  }

  return { open: false, reason: 'No trip result indicators found', details: [] };
}

async function sendTripOpenEmail(route, details) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const to = process.env.ALERT_EMAIL_TO;
  const from = process.env.ALERT_EMAIL_FROM || user;

  if (!host || !user || !pass || !to || !from) {
    throw new Error('Email configuration is incomplete. SMTP_PASS must exist as a GitHub Actions secret.');
  }

  const transporter = nodemailer.createTransport({
    host, port, secure: port === 465, auth: { user, pass }
  });

  const subject = `[KTMB TRIP OPEN] ${route.origin} → ${route.destination} | ${formatDate(route.travelDate)}`;
  const text = [
    'KTMB trip opening alert',
    '',
    `${route.label}: ${route.origin} → ${route.destination}`,
    `Travel date: ${formatDate(route.travelDate)}`,
    '',
    'The trip is now showing as available on the KTMB KITS website.',
    'Please open KTMB KITS and make your booking as soon as possible.',
    '',
    ...(details.length ? ['Detected trip information:', ...details.slice(0, 3), ''] : []),
    'KTMB KITS: https://online.ktmb.com.my/'
  ].join('\n');

  await transporter.sendMail({ from, to, subject, text });
  console.log(`Trip-open email sent for ${route.id} to ${to}`);
}

async function checkRoute(browser, route) {
  const page = await browser.newPage({
    locale: 'en-MY',
    timezoneId: 'Asia/Kuala_Lumpur',
    viewport: { width: 1440, height: 1000 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36'
  });

  try {
    console.log(`Checking ${route.label}: ${route.origin} -> ${route.destination}, ${route.travelDate}`);
    await page.goto(config.ktmbUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1000);

    const originIndex = await selectStation(page, route.origin);
    await selectStation(page, route.destination, originIndex);

    const dateSelectable = await setDepartureDate(page, route.travelDate);
    if (!dateSelectable) {
      console.log(`${route.id}: date is not selectable yet; treating as not open.`);
      return { open: false, reason: 'Date not selectable yet', details: [] };
    }

    await clickSearch(page);
    await Promise.race([
      page.waitForURL(/\/Trip/i, { timeout: 30000 }),
      page.getByText(/NO\s+TRIPS?\s+FOUND/i).first().waitFor({ state: 'visible', timeout: 30000 }),
      page.getByText(/Available\s+seats/i).first().waitFor({ state: 'visible', timeout: 30000 })
    ]).catch(() => {});

    await page.waitForLoadState('domcontentloaded').catch(() => {});
    const status = await detectTripStatus(page);
    console.log(`${route.id}: ${status.open ? 'OPEN' : 'NOT OPEN'} - ${status.reason}`);
    return status;
  } catch (error) {
    const safeId = route.id.replace(/[^a-z0-9_-]/gi, '_');
    try { await page.screenshot({ path: path.join(DEBUG_DIR, `${safeId}-failure.png`), fullPage: true }); } catch {}
    try { fs.writeFileSync(path.join(DEBUG_DIR, `${safeId}-page.html`), await page.content(), 'utf8'); } catch {}
    throw error;
  } finally {
    await page.close();
  }
}

async function main() {
  const routes = Array.isArray(config.routes) ? config.routes : [];
  if (!routes.length) throw new Error('No routes configured in config.json');

  const today = malaysiaDateISO();
  const lastTravelDate = routes.map(r => r.travelDate).sort().at(-1);
  if (today > lastTravelDate) {
    console.log(`All configured travel dates have passed. Monitor is inactive.`);
    return;
  }

  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const state = loadState();
  const notified = new Set(state.notifiedRoutes.map(String));

  const browser = await chromium.launch({ headless: true });
  try {
    for (const route of routes) {
      if (notified.has(route.id)) {
        console.log(`${route.id}: already notified; skipping.`);
        continue;
      }

      const status = await checkRoute(browser, route);
      if (status.open) {
        await sendTripOpenEmail(route, status.details);
        notified.add(route.id);
      }
    }
  } finally {
    await browser.close();
  }

  writeState([...notified]);

  const allNotified = routes.every(route => notified.has(route.id));
  if (allNotified) console.log('ALL_CONFIGURED_TRIPS_OPEN_AND_NOTIFIED');
  else console.log('Monitoring will continue for trip(s) not opened yet.');
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exit(1);
});
