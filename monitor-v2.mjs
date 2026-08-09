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
const threshold = Number(config.alertWhenSeatsGreaterThan ?? 3);

function malaysiaDateISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function normalizeText(value = '') {
  return String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
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
  const targetMonth = Number(monthText); // 1-12
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

    if (targetIndex > currentIndex) {
      await picker.locator('.lightpick__next-action').click();
    } else {
      await picker.locator('.lightpick__previous-action').click();
    }
    await page.waitForTimeout(180);

    if (attempt === 23) {
      throw new Error(`Could not navigate KTMB calendar to ${isoDate}`);
    }
  }

  const target = picker
    .locator('.lightpick__day.is-available:not(.is-previous-month):not(.is-next-month)')
    .filter({ hasText: new RegExp(`^${targetDay}$`) })
    .first();

  if (!(await target.count())) {
    throw new Error(`Date ${isoDate} is not selectable on KTMB calendar.`);
  }

  await target.click();
  await page.waitForTimeout(400);

  const selected = normalizeText(await input.inputValue());
  if (!selected) throw new Error(`KTMB departure date remained blank after selecting ${isoDate}`);
  console.log(`Departure date selected: ${selected}`);
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

function parseTrainBlock(raw) {
  const text = normalizeText(raw);
  const serviceMatch = text.match(/\b(Gold|Express|Platinum|Silver|Business)\s*-\s*(\d{3,5})\b/i);
  if (!serviceMatch || !/MYR\s*[\d,.]+/i.test(text)) return null;

  const service = serviceMatch[1][0].toUpperCase() + serviceMatch[1].slice(1).toLowerCase();
  const trainNumber = serviceMatch[2];
  const times = [...text.matchAll(/\b([01]?\d|2[0-3]):[0-5]\d\b/g)].map(m => m[0]);
  const fareMatch = text.match(/MYR\s*([\d,.]+)/i);

  // On the KTMB results row the available-seat number is the final standalone
  // integer before the fare column.
  const beforeFare = text.split(/MYR/i)[0];
  const integers = [...beforeFare.matchAll(/\b\d+\b/g)].map(m => Number(m[0]));
  if (!integers.length) return null;
  const availableSeats = integers[integers.length - 1];

  if (!Number.isFinite(availableSeats) || availableSeats < 0 || availableSeats > 999) return null;

  return {
    service,
    trainNumber,
    departure: times[0] || '',
    arrival: times[1] || '',
    availableSeats,
    fare: fareMatch?.[1] || '',
    raw: text
  };
}

async function parseResults(page) {
  await page.waitForTimeout(1200);

  const blocks = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    const rows = [...document.querySelectorAll('tr, [role="row"]')];
    for (const row of rows) {
      const text = (row.innerText || '').replace(/\s+/g, ' ').trim();
      if (/MYR\s*[\d,.]+/i.test(text) && /(Gold|Express|Platinum|Silver|Business)\s*-\s*\d{3,5}/i.test(text)) {
        if (!seen.has(text)) {
          seen.add(text);
          results.push(text);
        }
      }
    }

    if (!results.length) {
      const controls = [...document.querySelectorAll('button, a, input[type="button"], input[type="submit"]')];
      const pickButtons = controls.filter(el => {
        const text = `${el.innerText || ''} ${el.value || ''}`;
        return /pick\s*seats/i.test(text);
      });

      for (const button of pickButtons) {
        let node = button;
        for (let depth = 0; depth < 10 && node; depth++, node = node.parentElement) {
          const text = (node.innerText || '').replace(/\s+/g, ' ').trim();
          if (/MYR\s*[\d,.]+/i.test(text) && /(Gold|Express|Platinum|Silver|Business)\s*-\s*\d{3,5}/i.test(text)) {
            if (!seen.has(text)) {
              seen.add(text);
              results.push(text);
            }
            break;
          }
        }
      }
    }

    return results;
  });

  const parsed = blocks.map(parseTrainBlock).filter(Boolean);
  if (!parsed.length) {
    const sample = normalizeText(await page.locator('body').innerText().catch(() => ''));
    throw new Error(`No train rows parsed. Current URL: ${page.url()}. Page sample: ${sample.slice(0, 800)}`);
  }

  return parsed;
}

function trainAllowed(train) {
  if (config.trains === 'ALL' || config.trains == null) return true;
  const allowed = Array.isArray(config.trains) ? config.trains.map(String) : [String(config.trains)];
  return allowed.includes(String(train.trainNumber));
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { activeAlerts: [] };
  }
}

function writeState(activeAlerts) {
  fs.writeFileSync(STATE_PATH, JSON.stringify({ activeAlerts }, null, 2) + '\n');
}

async function sendEmail(trains) {
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
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });

  const lines = trains.map(t =>
    `${t.service} - ${t.trainNumber} | ${t.departure || '-'} → ${t.arrival || '-'} | ${t.availableSeats} seats | MYR ${t.fare || '-'}`
  ).join('\n');

  const subject = `[KTMB ALERT] Seats available: ${config.origin} → ${config.destination}`;
  const text = [
    'KTMB seat availability alert',
    '',
    `${config.origin} → ${config.destination}`,
    `Travel date: ${config.travelDate}`,
    `Alert condition: more than ${threshold} seats`,
    '',
    lines,
    '',
    'Please open the official KTMB KITS website/app to book. Availability may change quickly.'
  ].join('\n');

  await transporter.sendMail({ from, to, subject, text });
  console.log(`Alert email sent to ${to}`);
}

async function main() {
  const today = malaysiaDateISO();
  if (today > config.travelDate) {
    console.log(`Travel date ${config.travelDate} has passed. Monitor is inactive.`);
    return;
  }

  fs.mkdirSync(DEBUG_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    locale: 'en-MY',
    timezoneId: 'Asia/Kuala_Lumpur',
    viewport: { width: 1440, height: 1000 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36'
  });

  try {
    console.log(`Checking KTMB: ${config.origin} -> ${config.destination}, ${config.travelDate}`);
    await page.goto(config.ktmbUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1000);

    const originIndex = await selectStation(page, config.origin);
    await selectStation(page, config.destination, originIndex);
    await setDepartureDate(page, config.travelDate);

    console.log('Submitting KTMB search...');
    await clickSearch(page);

    await Promise.race([
      page.waitForURL(/\/Trip/i, { timeout: 30000 }),
      page.getByText(/Available\s+seats/i).first().waitFor({ state: 'visible', timeout: 30000 })
    ]).catch(() => {});

    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1500);
    console.log(`Results URL: ${page.url()}`);

    const trains = (await parseResults(page)).filter(trainAllowed);
    if (!trains.length) throw new Error('KTMB returned results, but none matched the configured train numbers.');

    console.table(trains.map(t => ({
      train: `${t.service} - ${t.trainNumber}`,
      departure: t.departure,
      arrival: t.arrival,
      seats: t.availableSeats,
      fare: t.fare
    })));

    const qualifying = trains.filter(t => t.availableSeats > threshold);
    const previous = new Set((loadState().activeAlerts || []).map(String));
    const activeNow = qualifying.map(t => String(t.trainNumber)).sort();
    const newAlerts = qualifying.filter(t => !previous.has(String(t.trainNumber)));

    if (newAlerts.length) {
      console.log(`Threshold crossed by train(s): ${newAlerts.map(t => t.trainNumber).join(', ')}`);
      await sendEmail(newAlerts);
    } else if (qualifying.length) {
      console.log('Availability is above the threshold, but an alert was already sent for the current condition.');
    } else {
      console.log(`No monitored train currently has more than ${threshold} seats.`);
    }

    writeState(activeNow);
  } catch (error) {
    console.error(error?.stack || error);
    try { await page.screenshot({ path: path.join(DEBUG_DIR, 'ktmb-failure.png'), fullPage: true }); } catch {}
    try { fs.writeFileSync(path.join(DEBUG_DIR, 'ktmb-page.html'), await page.content(), 'utf8'); } catch {}
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch(() => process.exit(1));
