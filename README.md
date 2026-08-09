# KTMB Seat Monitor — GitHub Actions + Netlify

This project monitors KTMB ETS/Intercity seat availability without requiring your PC to stay on.

## Current configuration

- Route: **IPOH → KL SENTRAL**
- Travel date: **31 August 2026**
- Trains: **9045, 9049, 9011, 9055**
- Alert condition: **available seats > 3** (4 or more)
- Check frequency: **every 5 minutes**

The monitor uses a headless Chromium browser through Playwright in **GitHub Actions**. **Netlify is optional** and is included to host the simple dashboard in `/public`.

## 1. Add email secrets in GitHub

Open your repository:

**Settings → Secrets and variables → Actions → New repository secret**

Create these secrets:

| Secret | Example |
|---|---|
| `SMTP_HOST` | `smtp.gmail.com` or your mail provider SMTP server |
| `SMTP_PORT` | `587` (STARTTLS) or `465` (SSL) |
| `SMTP_USER` | Email account used to send the alert |
| `SMTP_PASS` | App password / SMTP password |
| `ALERT_EMAIL_TO` | Email address that should receive KTMB alerts |
| `ALERT_EMAIL_FROM` | Optional; normally same as `SMTP_USER` |

Do **not** put your real email password inside `config.json` or any GitHub file.

### Common SMTP examples

**Gmail**
- Host: `smtp.gmail.com`
- Port: `587`
- Use a Google App Password rather than your normal password when required.

**Microsoft 365 / Outlook**
- Host commonly used for Microsoft 365 SMTP submission: `smtp.office365.com`
- Port: `587`
- Your tenant/account must allow SMTP authentication for the mailbox.

If your email provider blocks SMTP login, the notification module can be changed to another mail API later.

## 2. First test in GitHub

1. Open the repository's **Actions** tab.
2. Open **KTMB Seat Monitor**.
3. Click **Run workflow**.
4. Open the run and check the **Check KTMB seats** step.

The log should show a table with train number, departure, arrival, available seats and fare.

If KTMB changes its page layout and the browser cannot find the controls, the workflow uploads a `ktmb-monitor-debug` artifact containing a screenshot and HTML snapshot. These files can be used to adjust the selectors.

## 3. Automatic monitoring

The workflow is configured to run approximately every 5 minutes. It checks the selected trains for the configured route/date.

When a train changes from **3 seats or fewer** to **4 seats or more**, an email is sent. It then remembers that train in `.monitor-state.json` so it does not keep sending the same alert every five minutes. If the seats later fall back to 3 or fewer, the alert resets; if it later goes above 3 again, a new email is sent.

The monitor automatically stops querying KTMB after the configured travel date has passed.

## 4. Netlify setup (optional dashboard)

1. In Netlify choose **Add new site / Import an existing project**.
2. Connect this GitHub repository.
3. Netlify will use `netlify.toml` and publish the `/public` folder.
4. No Netlify environment variables are required for the current version.

Your PC can remain switched off. GitHub Actions performs the monitoring in the cloud.

## Change route/date later

Edit `config.json`, for example:

```json
{
  "origin": "IPOH",
  "destination": "KL SENTRAL",
  "travelDate": "2026-08-31",
  "passengers": 1,
  "trains": ["9045", "9049", "9011", "9055"],
  "alertWhenSeatsGreaterThan": 3,
  "ktmbUrl": "https://online.ktmb.com.my/"
}
```

For all trains, replace the array with:

```json
"trains": "ALL"
```

## Local Windows test (optional)

If Node.js is installed, double-click `RUN_LOCAL_TEST.bat`. It runs with `DRY_RUN=true`, so no email is sent.

## Important operational notes

- Seat availability can change quickly between checks and booking.
- GitHub scheduled workflows are not guaranteed to start at the exact second/minute; cloud scheduling can sometimes be delayed.
- The monitor checks public availability only. It does not reserve, hold, or buy a seat.
- Keep the interval reasonable and use the monitor only for personal availability checking.
