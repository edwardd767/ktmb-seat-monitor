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
const dryRun = /^true$/i.test(process.env.DRY_RUN || 'false');

function malaysiaDateISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function formatDateCandidates(iso) {
  const [y, m, d] = iso.split('-');
  return [`${d}/${m}/${y}`, `${y}-${m}-${d}`, `${m}/${d}/${y}`];
}

function normalizeText(s = '') {
  return s.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseTrainBlock(raw) {
  const text = normalizeText(raw);
  const serviceMatch = text.match(/\b(Gold|Express|Platinum|Silver|Business)\s*-\s*(\d{3,5})\b/i);
  if (!serviceMatch || !/MYR\s*[\d,.]+/i.test(text)) return null;

  const service = serviceMatch[1][0].toUpperCase() + serviceMatch[1].slice(1).toLowerCase();
  const trainNumber = serviceMatch[2];
  const times = [...text.matchAll(/\b([01]?\d|2[0-3]):[0-5]\d\b/g)].map(m => m[0]);
  const fareMatch = text.match(/MYR\s*([\d,.]+)/i);

  const beforeFare = text.split(/MYR/i)[0];
  const numbers = [...beforeFare.matchAll(/\b\d+\b/g)].map(m => Number(m[0]));
  if (!numbers.length) return null;

  const seats = numbers[numbers.length - 1];
  if (!Number.isFinite(seats) || seats < 0 || seats > 999) return null;

  return {
    service,
    trainNumber,
    departure: times[0] || '',
    arrival: times[1] || '',
    availableSeats: seats,
    fare: fareMatch ? fareMatch[1] : '',
    raw: text
  };
}

async function selectByVisibleOption(page, wanted, excludeIndex = -1) {
  const target = wanted.trim().toUpperCase();
  const selects = page.locator('select');
  const count = await selects.count();

  for (let i = 0; i < count; i++) {
    if (i === excludeIndex) continue;
    const select = selects.nth(i);
    const labels = await select.locator('option').allTextContents().catch(() => []);
    const matchIndex = labels.findIndex(x => normalizeText(x).toUpperCase() === target);
    if (matchIndex >= 0) {
      const option = select.locator('option').nth(matchIndex);
      const value = await option.getAttribute('value');
      if (value !== null) await select.selectOption(value);
      else await select.selectOption({ label: labels[matchIndex] });
      await page.waitForTimeout(900);
      return i;
    }
  }
  throw new Error(`Could not find station option: ${wanted}`);
}

async function setDepartureDate(page, isoDate) {
  const candidates = formatDateCandidates(isoDate);
  const inputs = page.locator('input');
  const count = await inputs.count();

  const ranked = [];
  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    const attrs = await input.evaluate(el => ({
      type: el.getAttribute('type') || '',
      name: el.getAttribute('name') || '',
      id: el.id || '',
      placeholder: el.getAttribute('placeholder') || '',
      aria: el.getAttribute('aria-label') || ''
    }));
    const hay = `${attrs.name} ${attrs.id} ${attrs.placeholder} ${attrs.aria}`.toLowerCase();
    let score = 0;
    if (/depart|departure|journey|travel/.test(hay)) score += 10;
    if (/date/.test(hay)) score += 4;
    if (attrs.type === 'date') score += 6;
    if (attrs.type === 'text' || attrs.type === 'date' || !attrs.type) score += 1;
    if (/return/.test(hay)) score -= 20;
    ranked.push({ i, score, attrs });
  }
  ranked.sort((a, b) => b.score - a.score);

  for (const item of ranked.slice(0, 8)) {
    if (item.score < 1) continue;
    const input = inputs.nth(item.i);
    for (const candidate of candidates) {
      try {
        await input.click({ force: true, timeout: 1200 });
        await input.fill(candidate, { timeout: 1200 });
        await input.evaluate((el, value) => {
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, item.attrs.type === 'date' ? isoDate : candidate);
        await page.waitForTimeout(300);
        const current = await input.inputValue();
        if (current && (current.includes(isoDate) || current.includes(isoDate.slice(0, 4)) || current.includes(isoDate.slice(8, 10)))) {
          return;
        }
      } catch {}
    }
  }
  throw new Error(`Could not set departure date ${isoDate}`);
}

async function clickSearch(page) {
  const candidates = [
    page.getByRole('button', { name: /^search$/i }).first(),
    page.getByText(/^search$/i).first(),
    page.locator('input[type="submit"][value*="SEARCH" i]').first()
  ];
  for (const loc of candidates) {
    try {
      if (await loc.count()) {
        await loc.click({ timeout: 3000 });
        return;
      }
    } catch {}
  }
  throw new Error('Could not find the KTMB SEARCH button.');
}

async function parseResults(page) {
  await page.waitForTimeout(1500);
  const blocks = await page.evaluate(() => {
    const out = [];
    const seen = new Set();
    const all = [...document.querySelectorAll('button, a, input[type="button"], input[type="submit"]')];
    const pickers = all.filter(el => {
      const t = `${el.innerText || ''} ${el.value || ''} ${el.getAttribute('aria-label') || ''}`;
      return /pick\s*seats/i.test(t);
    });

    for (const picker of pickers) {
      let el = picker;
      for (let depth = 0; depth < 9 && el; depth++, el = el.parentElement) {
        const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (/MYR\s*[\d,.]+/i.test(txt) && /(Gold|Express|Platinum|Silver|Business)\s*-\s*\d{3,5}/i.test(txt)) {
          if (!seen.has(txt)) { seen.add(txt); out.push(txt); }
          break;
        }
      }
    }

    if (!out.length) {
      const rows = [...document.querySelectorAll('tr, [role="row"]')];
      for (const row of rows) {
        const txt = (row.innerText || '').replace(/\s+/g, ' ').trim();
        if (/MYR\s*[\d,.]+/i.test(txt) && /(Gold|Express|Platinum|Silver|Business)\s*-\s*\d{3,5}/i.test(txt)) {
          if (!seen.has(txt)) { seen.add(txt); out.push(txt); }
        }
      }
    }
    return out;
  });

  const parsed = blocks.map(parseTrainBlock).filter(Boolean);
  if (!parsed.length) {
    const bodyText = normalizeText(await page.locator('body').innerText().catch(() => ''));
    throw new Error(`No KTMB train rows could be parsed. Page sample: ${bodyText.slice(0, 700)}`);
  }
  return parsed;
}

function trainAllowed(train) {
  if (config.trains === 'ALL' || config.trains == null) return true;
  const allowed = Array.isArray(config.trains) ? config.trains.map(String) : [String(config.trains)];
  return allowed.includes(String(train.trainNumber));
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { activeAlerts: [] }; }
}

function writeState(activeAlerts) {
  fs.writeFileSync(STATE_PATH, JSON.stringify({ activeAlerts }, null, 2) + '\n');
}

async function sendEmail(trains) {
  if (dryRun) {
    console.log('DRY_RUN=true, email suppressed. Would alert for:', trains);
    return;
  }

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const to = process.env.ALERT_EMAIL_TO;
  const from = process.env.ALERT_EMAIL_FROM || user;
  if (!host || !user || !pass || !to || !from) {
    throw new Error('Email secrets missing. Required: SMTP_HOST, SMTP_USER, SMTP_PASS, ALERT_EMAIL_TO (SMTP_PORT optional).');
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

  const subject = `[KTMB ALERT] ${trains[0].availableSeats}+ seats available: ${config.origin} → ${config.destination}`;
  const text = [
    'KTMB seat availability alert', '',
    `${config.origin} → ${config.destination}`,
    `Travel date: ${config.travelDate}`,
    `Alert condition: more than ${threshold} seats`, '',
    lines, '',
    'Please open the official KTMB KITS website/app to book. Availability can change quickly.'
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
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36'
  });

  try {
    console.log(`Checking KTMB: ${config.origin} -> ${config.destination}, ${config.travelDate}`);
    await page.goto(config.ktmbUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

    for (const label of [/^close$/i, /^cancel$/i]) {
      try { await page.getByRole('button', { name: label }).first().click({ timeout: 1200 }); } catch {}
    }

    await page.waitForTimeout(1200);
    const originIndex = await selectByVisibleOption(page, config.origin);
    await page.waitForTimeout(1200);
    await selectByVisibleOption(page, config.destination, originIndex);
    await setDepartureDate(page, config.travelDate);
    await clickSearch(page);

    await Promise.race([
      page.waitForURL(/\/Trip/i, { timeout: 25000 }).catch(() => null),
      page.getByText(/Available\s+seats/i).first().waitFor({ timeout: 25000 }).catch(() => null)
    ]);
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    const trains = (await parseResults(page)).filter(trainAllowed);
    console.table(trains.map(t => ({
      train: `${t.service} - ${t.trainNumber}`,
      departure: t.departure,
      arrival: t.arrival,
      seats: t.availableSeats,
      fare: t.fare
    })));

    const qualifying = trains.filter(t => t.availableSeats > threshold);
    const state = loadState();
    const previous = new Set((state.activeAlerts || []).map(String));
    const activeNow = qualifying.map(t => String(t.trainNumber)).sort();
    const newAlerts = qualifying.filter(t => !previous.has(String(t.trainNumber)));

    if (newAlerts.length) {
      console.log(`New threshold crossing detected for: ${newAlerts.map(t => t.trainNumber).join(', ')}`);
      await sendEmail(newAlerts);
    } else if (qualifying.length) {
      console.log('Seats are still above threshold, but an alert was already sent. No duplicate email.');
    } else {
      console.log(`No trains currently have more than ${threshold} seats.`);
    }

    writeState(activeNow);
  } catch (err) {
    console.error(err?.stack || err);
    try { await page.screenshot({ path: path.join(DEBUG_DIR, 'ktmb-failure.png'), fullPage: true }); } catch {}
    try { fs.writeFileSync(path.join(DEBUG_DIR, 'ktmb-page.html'), await page.content(), 'utf8'); } catch {}
    throw err;
  } finally {
    await browser.close();
  }
}

main().catch(() => process.exit(1));
