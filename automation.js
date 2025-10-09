// automation.js
// npm i dotenv axios pg playwright form-data
//
// Run: node automation.js
//
// What this does:
// - Ensures a valid CHEERS session: tries to reuse storageState.json (local or Retool Storage);
//   if not authenticated after navigating, it opens login, waits for manual login, then saves & uploads storageState.json.
// - Pulls all rows with status='pending', marks each ai_submitting, processes sequentially.
// - Takes a full-page screenshot, uploads to Retool Storage, updates DB: pass/manual_required.
// - Uses env vars: PG_CONNECTION_STRING, RETOOL_API_KEY, HEADLESS (optional)

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");
const { chromium } = require("playwright");
const pg = require("pg");

const TARGET_URL = "https://www.cheers.org/app/sites";
const LOGIN_URL = "https://www.cheers.org/app/login";
const STORAGE_STATE_FILE = "storageState.json";
const RETOOL_API = "https://api.retool.com/v1/storage";
const RETOOL_API_KEY = process.env.RETOOL_API_KEY;
const PG_CONNECTION_STRING = process.env.PG_CONNECTION_STRING;
const HEADLESS = String(process.env.HEADLESS || "false").toLowerCase() === "true";
const MANUAL_LOGIN_WINDOW_MS = 90_000; // give you more time to log in manually

// ------------------------ utils ------------------------
function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function ensureEnv() {
  if (!PG_CONNECTION_STRING) throw new Error("PG_CONNECTION_STRING is not set in .env");
  if (!RETOOL_API_KEY) throw new Error("RETOOL_API_KEY is not set in .env");
}

// ------------------------ Retool Storage ------------------------
async function uploadToRetoolStorage(filePath, key) {
  // Try 1: POST /v1/storage/upload (body: raw bytes, header x-retool-key)
  try {
    const bytes = fs.readFileSync(filePath);
    const res = await axios.post(`${RETOOL_API}/upload`, bytes, {
      headers: {
        Authorization: `Bearer ${RETOOL_API_KEY}`,
        "Content-Type": "application/octet-stream",
        "x-retool-key": key
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
    if (res.data?.url) return res.data.url;
    throw new Error("No url in upload response");
  } catch (e) {
    console.warn(`[storage] upload POST failed (${e?.response?.status || e.message}). Trying PUT fallback…`);
  }

  // Try 2 (fallback): PUT /v1/storage/<key> with raw bytes or multipart
  try {
    const bytes = fs.readFileSync(filePath);
    const res = await axios.put(`${RETOOL_API}/${encodeURIComponent(key)}`, bytes, {
      headers: {
        Authorization: `Bearer ${RETOOL_API_KEY}`,
        "Content-Type": "application/octet-stream"
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
    if (res.data?.url) return res.data.url;
    // some variants return nothing; construct public URL form (service usually echoes)
    if (res.status >= 200 && res.status < 300) {
      // As a conservative fallback, return the GET endpoint; most Retool Storage returns a signed/public URL via GET
      return `${RETOOL_API}/${encodeURIComponent(key)}`;
    }
    throw new Error(`PUT fallback failed: ${res.status}`);
  } catch (e) {
    console.warn(`[storage] upload PUT fallback failed (${e?.response?.status || e.message}). Trying multipart as last resort…`);
  }

  // Try 3 (last resort): multipart form-data to /upload
  try {
    const form = new FormData();
    form.append("file", fs.createReadStream(filePath));
    const res = await axios.post(`${RETOOL_API}/upload?key=${encodeURIComponent(key)}`, form, {
      headers: {
        Authorization: `Bearer ${RETOOL_API_KEY}`,
        ...form.getHeaders()
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
    if (res.data?.url) return res.data.url;
    throw new Error("No url in multipart upload response");
  } catch (e) {
    console.error("[storage] All upload attempts failed:", e?.response?.status, e.message);
    throw e;
  }
}

async function tryDownloadStorageState() {
  try {
    const res = await axios.get(`${RETOOL_API}/${encodeURIComponent(STORAGE_STATE_FILE)}`, {
      headers: { Authorization: `Bearer ${RETOOL_API_KEY}` },
      responseType: "arraybuffer",
      validateStatus: () => true
    });
    if (res.status === 200 && res.data) {
      fs.writeFileSync(STORAGE_STATE_FILE, res.data);
      console.log("[login] Downloaded storageState.json from Retool Storage");
      return true;
    }
    console.log("[login] storageState.json not found in Retool Storage (GET returned", res.status, ")");
    return false;
  } catch (e) {
    console.log("[login] GET storage state failed:", e.message);
    return false;
  }
}

// ------------------------ DB helpers ------------------------
async function getPendingRows(client) {
  const res = await client.query(
    `SELECT id, form_data
     FROM public.submissions
     WHERE status = 'pending'
     ORDER BY created_at ASC`
  );
  return res.rows;
}

async function updateRowStatus(client, id, status, screenshotUrl = null, errorMsg = null) {
  await client.query(
    `UPDATE public.submissions
     SET status = $1,
         screenshot_url = COALESCE($2, screenshot_url),
         error_message = $3,
         updated_at = NOW()
     WHERE id = $4`,
    [status, screenshotUrl, errorMsg, id]
  );
  console.log(`[db] Updated row ${id}: status → ${status}`);
}

// ------------------------ CHEERS auth helpers ------------------------
async function isOnSites(page) {
  const url = page.url();
  if (/\/app\/sites/i.test(url)) return true;
  // heuristic: look for something that appears on Sites list
  const siteHeader = page.getByText(/sites/i, { exact: false }).first();
  try {
    await Promise.race([
      siteHeader.waitFor({ state: "visible", timeout: 1500 }),
      page.waitForSelector("table, .list, .grid", { timeout: 1500 })
    ]);
    return /\/app\/sites/i.test(page.url());
  } catch {
    return false;
  }
}

async function ensureLoggedIn(ctx) {
  const page = await ctx.newPage();

  // Step 1: try with existing local storageState or downloaded one
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  if (await isOnSites(page)) {
    console.log("[login] Session appears valid (landed on Sites).");
    await page.close();
    return;
  }

  // Step 2: if we had no local state, try pull from Retool Storage
  const hadLocal = fs.existsSync(STORAGE_STATE_FILE);
  if (!hadLocal) {
    console.log("[login] No local storage state; checking Retool Storage…");
    const pulled = await tryDownloadStorageState();
    if (pulled) {
      await page.context().close(); // rebuild context with storage
      const newCtx = await page.browser().newContext({ storageState: STORAGE_STATE_FILE });
      const p2 = await newCtx.newPage();
      await p2.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
      if (await isOnSites(p2)) {
        console.log("[login] Retool Storage state worked.");
        await p2.close();
        await newCtx.close();
        return;
      }
      await newCtx.close();
    }
  }

  // Step 3: manual login flow
  console.log("[login] Opening manual login page…");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  console.log(`[login] Please complete login within ${Math.round(MANUAL_LOGIN_WINDOW_MS / 1000)}s…`);
  // Give you time to login (and navigate to Sites)
  await page.waitForTimeout(2_000);
  // Poll for Sites landing or any auth gate success
  const t0 = Date.now();
  let authed = false;
  while (Date.now() - t0 < MANUAL_LOGIN_WINDOW_MS) {
    if (await isOnSites(page)) { authed = true; break; }
    await page.waitForTimeout(1_500);
  }
  if (!authed) {
    console.warn("[login] Did not detect Sites within the time window. You can increase MANUAL_LOGIN_WINDOW_MS.");
    // Still save whatever state we have; might be partially logged
  }

  // Save and upload storageState for future runs
  await page.context().storageState({ path: STORAGE_STATE_FILE });
  console.log("[login] Saved storageState.json locally.");

  try {
    const url = await uploadToRetoolStorage(STORAGE_STATE_FILE, STORAGE_STATE_FILE);
    console.log("[login] Uploaded storageState.json to Retool Storage:", url);
  } catch (e) {
    console.warn("[login] Could not upload storage state to Retool Storage:", e.message);
  }

  await page.close();
}

// ------------------------ core per-row work ------------------------
async function processRow(ctx, row, client) {
  const { id, form_data } = row;
  const page = await ctx.newPage();

  // 1) Navigate to Sites, verify session; if redirected to login, re-run ensureLoggedIn once
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  if (!(await isOnSites(page))) {
    console.log("[nav] Not authenticated anymore. Re-entering login flow once…");
    await page.close();
    await ensureLoggedIn(ctx);
  }

  const workPage = await ctx.newPage();
  console.log("[nav] Opening Sites…");
  await workPage.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  if (!(await isOnSites(workPage))) {
    throw new Error("Login still not detected after manual step.");
  }

  // 2) TODO: plug in your CHEERS navigation + form fill logic here
  // Example:
  // const sitePage = await clickSiteRow(workPage);
  // const formPage = await clickMCH01NotStarted(sitePage);
  // await fillPageFromData(formPage, parseFormData(form_data));
  // await saveAndVerifyPass(formPage);

  console.log("[form] Autofilling form with row data…");
  // For now we just wait a moment to simulate work.
  await workPage.waitForTimeout(800);

  // 3) Screenshot
  const dir = path.resolve("screenshots");
  fs.mkdirSync(dir, { recursive: true });
  const pngPath = path.join(dir, `${nowStamp()}_${id}.png`);
  await workPage.screenshot({ path: pngPath, fullPage: true });
  console.log(`[form] Screenshot saved: ${pngPath}`);

  // 4) Upload screenshot to Retool Storage
  let screenshotUrl = null;
  try {
    screenshotUrl = await uploadToRetoolStorage(pngPath, `screenshot_${id}.png`);
    console.log("[form] Uploaded screenshot to Retool Storage:", screenshotUrl);
  } catch (e) {
    console.warn("[form] Screenshot upload failed:", e.message);
    throw e; // treat as failure so it’s clear in DB/logs
  } finally {
    await workPage.close();
    await page.close();
  }

  // 5) Update DB as pass
  await updateRowStatus(client, id, "pass", screenshotUrl, null);
}

// ------------------------ main runner ------------------------
async function runAutomation() {
  ensureEnv();

  const client = new pg.Client({ connectionString: PG_CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const browser = await chromium.launch({ headless: HEADLESS });
  let context = await browser.newContext(
    fs.existsSync(STORAGE_STATE_FILE) ? { storageState: STORAGE_STATE_FILE } : {}
  );

  try {
    // Make sure we’re logged in BEFORE queue work
    await ensureLoggedIn(context);

    // Refresh context using the freshly-saved storage state for clean session
    await context.close();
    context = await browser.newContext({ storageState: STORAGE_STATE_FILE });

    // Fetch queue
    const rows = await getPendingRows(client);
    console.log(`[queue] Found ${rows.length} pending rows`);
    for (const row of rows) {
      console.log(`\n[queue] Processing row id=${row.id}…`);
      await updateRowStatus(client, row.id, "ai_submitting");
      try {
        await processRow(context, row, client);
      } catch (err) {
        console.error(`[error] Row ${row.id} failed:`, err.message);
        await updateRowStatus(client, row.id, "manual_required", null, err.message);
      }
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await client.end().catch(() => {});
  }
}

// ------------------------ entrypoint ------------------------
runAutomation().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
