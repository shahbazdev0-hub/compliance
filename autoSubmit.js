// autoSubmit.js
// npm i playwright pg
//
// Flow:
// 1) Reuse storageState.json if present; otherwise allow login then save it
// 2) Open https://www.cheers.org/app/sites
// 3) Click site row: "111 Auto Entry, San Diego" (handles new tab / SPA / tab-close)
// 4) Click "MCH01 Not Started"
// 5) Autofill form from Retool DB (form_data column)
// 6) Click Save icon (title="Save form and continue editing")
// 7) Wait for green "Pass" to be visible
// 8) Take full-page screenshot -> ./screenshots/<timestamp>_MCH01b.png
// 9) Update DB row with screenshot_url, ai_updated, status

const TARGET_URL = "https://www.cheers.org/app/sites";
const PG_CONNECTION_STRING =
  "postgresql://retool:npg_Ar0ZIzDg2Ocw@ep-sweet-breeze-a6zz899z.us-west-2.retooldb.com/retool?sslmode=require";

const HEADLESS = false;
const MANUAL_LOGIN_WINDOW_MS = 60000;

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const pg = require("pg");

// ---------- tiny utils ----------
function norm(s) {
  return (s ?? "")
    .toString()
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\u00ad\u200b\u200c\u200d\u2060\uFEFF]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function cssEscape(s = "") {
  return s.replace(/["\\]/g, "\\$&");
}
function preview(v) {
  const s = String(v ?? "");
  return s.length > 70 ? s.slice(0, 67) + "..." : s;
}
function stamp(name = "MCH01b") {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}_${name}`;
}
function isMeaningful(v) {
  if (v === null || v === undefined) return false;
  const s = String(v).trim();
  if (s === "") return false;
  return true; // "0" and numbers are allowed
}

// ---------- alias map (heuristics) ----------
const FIELD_ALIASES = {
  CondenserTon1: ["condenser ton", "tonnage", "ton", "size", "capacity"],
  CondenserTon: ["condenser ton", "tonnage", "ton", "size", "capacity"],
  CondenserX400: ["cfm per ton", "airflow per ton", "x400"],
  MeasuredCMF: ["measured cfm", "actual cfm", "airflow", "supply cfm"],
  actualCFM2: ["measured cfm", "actual cfm"],
  CFM: ["cfm", "airflow"],
  CMF: ["cfm", "airflow"],
  MeasuredFWD: ["fan watt draw", "fwd", "watts", "watt measured", "fan power"],
  WattMeasured: ["watts", "fan watts", "fan power", "watt measured"],
  filtersize: ["filter size", "filter", "grille size"],
  Filtersize: ["filter size", "filter", "grille size"],
  Address: ["address", "homeowner address", "site address", "street"],
  HomeOwner: ["homeowner", "customer name", "owner name", "home owner", "name"],
  cityzip2: ["city zip", "city/zip", "city", "zip", "postal"],
  email: ["email", "e-mail", "contact email"],
  R_value2: ["r value", "r-value", "duct r value", "insulation r"],
  DuctLocation2: ["duct location", "supply duct location", "return duct location", "location of duct"],
  textInput45: ["duct location", "supply duct location", "return duct location"],
  Out_Door_Temp: ["outdoor temp", "outside temperature", "ambient", "oat"],
  TReturnDB: ["return db", "return dry bulb", "return temp db"],
  TReturnWB: ["return wb", "return wet bulb"],
  Tsupply: ["supply temp", "supply air temp", "supply temperature"],
  CondenserSeer: ["seer", "seasonal efficiency"],
  FurnaceSeer: ["furnace seer", "afue", "efficiency"],
  FuranceBrand2: ["furnace brand", "ahu brand", "air handler brand"],
  FuranceBrandModel2: ["furnace model", "ahu model", "air handler model", "model #", "model"],
  FuranceBrandSerial2: ["furnace serial", "ahu serial", "air handler serial", "serial #", "serial"],
  CondenserModel: ["condenser model", "outdoor model", "model #", "model"],
  CondenserSerial: ["condenser serial", "outdoor serial", "serial #", "serial"],
  Lineset_Length2: ["lineset length", "line set length", "refrigerant line length"],
  FaranceRefrigerant: ["furnace refrigerant type", "indoor refrigerant", "refrigerant type"],
  CondenserRefrigerant: ["condenser refrigerant", "outdoor refrigerant", "refrigerant type"],
  GrillDim: ["grille dimension", "filter grille size", "grill dim", "grille size"],
  GrillDimX: ["grille x", "dimension x", "width"],
  GrillDim144: ["grille area", "sqin", "/144", "area"],
  Rater: ["rater", "inspector", "technician", "tested by"],
  date2: ["date", "inspection date", "visit date"],
  time2: ["time", "inspection time"],
  checkno: ["check number", "check #", "payment reference", "ref #"],
  checkamount: ["check amount", "amount paid", "payment amount"],
  RaterNote2: ["notes", "comments", "remarks", "rater notes"],
  DuctsNewExisting: ["ducts new existing", "existing ducts", "new ducts"],
  LocationofUnit: ["location of unit", "indoor unit location", "ahu location"],
  LocationOutside: ["location of unit outside", "outdoor location", "condenser location"]
};

function scoreMatch(fieldText, srcKey) {
  const t = norm(fieldText);
  if (!t) return 0;
  const exact = norm(srcKey);
  let score = 0;
  if (t === exact) score += 10;
  if (t.includes(exact)) score += 6;
  const aliases = FIELD_ALIASES[srcKey] || [];
  for (const a of [srcKey, ...aliases]) {
    const na = norm(a);
    if (!na) continue;
    if (t === na) score += 9;
    else if (t.includes(na)) score += 5;
    const tSet = new Set(t.split(" "));
    const aSet = new Set(na.split(" "));
    let overlap = 0;
    for (const w of aSet) if (tSet.has(w)) overlap++;
    score += Math.min(overlap, 3);
  }
  return score;
}
function digitsOnlyOrNull(s) {
  const t = String(s).replace(/[^0-9.]/g, "");
  return t.trim() === "" ? null : t;
}
function transformValue(key, val) {
  if (val == null) return null;
  const s = String(val);
  if (/^email$/i.test(key)) return s.trim().toLowerCase();
  if (/date/i.test(key)) return s.includes("T") ? s.split("T")[0] : s;
  if (/time/i.test(key)) return s.includes("T") ? s.split("T")[1].replace(/Z$/, "") : s.replace(/Z$/, "");
  // 🔹 Special case: Heating Capacity field (CondenserTon / CondenserTon1)
  if (/CondenserTon1?|HeatingCapacity/i.test(key)) {
    const t = s.replace(/[^0-9.]/g, "");
    return t.trim() === "" ? "0" : t; // fallback to "0" if nothing present
  }
  if (/(^|_)CFM|CMF|MeasuredCFM|actualCFM/i.test(key)) return digitsOnlyOrNull(s);
  if (/Seer|Watt|Length/i.test(key)) return digitsOnlyOrNull(s);
  if (/zip/i.test(key)) {
    const t = s.replace(/[^0-9-]/g, "");
    return t.trim() === "" ? null : t;
  }
  return s.trim() === "" ? null : s.trim();
}

// ---------- DB read ----------
async function readFormDataFromRetool() {
  const client = new pg.Client({ connectionString: PG_CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
  await client.connect();
  // Prefer public.submissions with a form_data column if it exists.
  let table_schema = "public";
  let table_name = "submissions";
  const sub = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'submissions' AND column_name = 'form_data'
     LIMIT 1`
  );
  if (!sub.rows.length) {
    // fallback: first table that has form_data
    const tables = await client.query(
      `SELECT table_schema, table_name FROM information_schema.columns
       WHERE column_name = 'form_data'
       ORDER BY table_schema, table_name LIMIT 1`
    );
    if (!tables.rows.length) {
      await client.end();
      throw new Error("No table with a 'form_data' column found.");
    }
    table_schema = tables.rows[0].table_schema;
    table_name = tables.rows[0].table_name;
  }
  const res = await client.query(`SELECT form_data FROM "${table_schema}"."${table_name}" LIMIT 1`);
  await client.end();
  if (!res.rows.length) throw new Error(`No rows in ${table_schema}.${table_name}`);
  let blob = res.rows[0].form_data;
  if (typeof blob === "string") {
    try { blob = JSON.parse(blob); }
    catch { blob = { form_data_text: blob }; }
  }
  if (!blob || typeof blob !== "object") {
    throw new Error("form_data is not a JSON object.");
  }
  return blob;
}

// ---------- page helpers ----------
async function getFieldDescriptor(page, el) {
  const id = await el.getAttribute("id");
  const name = await el.getAttribute("name");
  const placeholder = await el.getAttribute("placeholder");
  const aria = await el.getAttribute("aria-label");
  let labelText = "";
  if (id) {
    const lbl = page.locator(`label[for="${cssEscape(id)}"]`).first();
    if (await lbl.count()) labelText = (await lbl.innerText()).trim();
  }
  if (!labelText) {
    const labelParent = el.locator("xpath=ancestor::label[1]");
    if (await labelParent.count()) labelText = (await labelParent.innerText()).trim();
  }
  const nearby = await el.evaluate((node) => {
    const s = [];
    let p = node.parentElement;
    let hops = 0;
    while (p && hops < 2) {
      s.push(p.innerText || "");
      p = p.parentElement;
      hops++;
    }
    return s.join(" ");
  });
  let desc = [labelText, aria, placeholder, name, id, nearby].filter(Boolean).join(" | ");
  desc = desc.replace(/\[Select][\s\S]*/i, "");
  desc = desc.replace(/\s+/g, " ").trim();
  return desc;
}

async function getCurrentValue(page, el) {
  const tag = (await el.evaluate((n) => n.tagName)).toLowerCase();
  if (tag === "select") {
    return el.evaluate((select) => {
      const opt = select.selectedOptions && select.selectedOptions[0];
      return opt ? (opt.label || opt.textContent || opt.value || "").trim() : "";
    });
  }
  if (tag === "textarea") return (await el.inputValue().catch(() => "")) || "";
  if (tag === "input") {
    const type = (await el.getAttribute("type") || "").toLowerCase();
    if (type === "checkbox") return (await el.isChecked()) ? "checked" : "";
    if (type === "radio") {
      const name = await el.getAttribute("name");
      if (!name) return "";
      const group = page.locator(`input[type="radio"][name="${cssEscape(name)}"]`);
      const count = await group.count();
      for (let i = 0; i < count; i++) {
        const r = group.nth(i);
        if (await r.isChecked()) {
          const valAttr = await r.getAttribute("value");
          const labelText = await r.locator("xpath=following::label[1]").innerText().catch(() => "");
          return (valAttr || labelText || "").trim();
        }
      }
      return "";
    }
    return (await el.inputValue().catch(() => "")) || "";
  }
  return "";
}

async function selectClosestOption(el, rawVal) {
  const v = String(rawVal);
  const vNorm = norm(v);
  const options = await el.evaluate((select) => {
    return Array.from(select.querySelectorAll("option")).map((o) => ({
      value: o.value,
      label: (o.innerText || "").trim()
    }));
  });
  for (const o of options) if (o.value === v) return el.selectOption(o.value);
  for (const o of options) if (o.label === v) return el.selectOption({ label: o.label });
  for (const o of options) if (norm(o.label) === vNorm) return el.selectOption({ label: o.label });
  for (const o of options) if (norm(o.label).includes(vNorm)) return el.selectOption({ label: o.label });
  let best = null, bestScore = -1;
  const vSet = new Set(vNorm.split(" ").filter(Boolean));
  for (const o of options) {
    const oSet = new Set(norm(o.label).split(" ").filter(Boolean));
    let overlap = 0;
    for (const t of vSet) if (oSet.has(t)) overlap++;
    if (overlap > bestScore) {
      bestScore = overlap;
      best = o;
    }
  }
  if (best) await el.selectOption({ label: best.label }).catch(() => {});
}

async function setField(page, el, value) {
  if (!isMeaningful(value)) return; // never write empties
  const tag = (await el.evaluate((n) => n.tagName)).toLowerCase();
  if (tag === "select") return selectClosestOption(el, value);
  if (tag === "textarea") return el.fill(String(value));
  if (tag === "input") {
    const type = (await el.getAttribute("type") || "").toLowerCase();
    if (type === "checkbox") {
      const truthy = typeof value === "boolean"
        ? value
        : (typeof value === "string" ? /^(true|yes|on|1|checked)$/i.test(value) : Boolean(value));
      if (truthy) await el.check().catch(() => {});
      else await el.uncheck().catch(() => {});
      return;
    }
    if (type === "radio") {
      const name = await el.getAttribute("name");
      if (name) {
        const group = page.locator(`input[type="radio"][name="${cssEscape(name)}"]`);
        const count = await group.count();
        for (let i = 0; i < count; i++) {
          const r = group.nth(i);
          const valAttr = await r.getAttribute("value");
          const labelText = await r.locator("xpath=following::label[1]").innerText().catch(() => "");
          const candidate = (valAttr || labelText || "").trim();
          if (norm(candidate) === norm(String(value))) {
            await r.check().catch(() => {});
            return;
          }
        }
      }
      await el.check().catch(() => {});
      return;
    }
    return el.fill(String(value)).catch(() => {});
  }
}

async function fillPageFromData(page, data) {
  const fields = page.locator("input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])");
  const count = await fields.count();
  if (!count) {
    console.warn("No interactive fields found on page.");
    return;
  }
  const descriptors = [];
  for (let i = 0; i < count; i++) {
    const el = fields.nth(i);
    const desc = await getFieldDescriptor(page, el);
    descriptors.push({ el, desc });
  }
  const usedKeys = new Set();
  for (let i = 0; i < descriptors.length; i++) {
    const { el, desc } = descriptors[i];
    let bestKey = null;
    let bestScore = 0;
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined || v === null || v === "") continue;
      if (usedKeys.has(k)) continue;
      const s = scoreMatch(desc, k);
      if (s > bestScore) {
        bestScore = s;
        bestKey = k;
      }
    }
    if (bestKey && bestScore >= 6) {
      const transformed = transformValue(bestKey, data[bestKey]);
      if (!isMeaningful(transformed)) {
        console.log(`↷ Skip [${bestKey}] → "${desc}" | (empty after transform)`);
        continue;
      }
      const current = await getCurrentValue(page, el);
      if (isMeaningful(current)) {
        console.log(`↷ Keep existing → "${desc}" | current: ${preview(current)}`);
        usedKeys.add(bestKey);
        continue;
      }
      console.log(`→ Match [${bestKey}] → field "${desc}" | value: ${preview(transformed)}`);
      try {
        await setField(page, el, transformed);
        usedKeys.add(bestKey);
      } catch (e) {
        console.warn(`Could not set field for key ${bestKey}:`, e.message);
      }
    }
  }
}

// ---------- submit + screenshot ----------
async function saveAndScreenshot(page) {
  const saveBtn = page.locator('button[title="Save form and continue editing"]').first();
  if (await saveBtn.count()) {
    console.log("[submit] Clicking Save form button…");
    await saveBtn.click({ force: true }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);
  }
  const passBtn = page.locator('a.btn.btn-success:has-text("Pass")').first();
  console.log("[submit] Waiting for Pass button to be visible…");
  await passBtn.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(300);
  const dir = path.resolve(process.cwd(), "screenshots");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stamp("MCH01b")}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`[submit] Full-page screenshot saved: ${file}`);
  const screenshotUrl = "https://example.com/screenshots/demo.png"; // replace with your real URL
  try {
    const client = new pg.Client({ connectionString: PG_CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
    await client.connect();
    const sql = `
      UPDATE public.submissions
      SET attempted_ai = 'yes', screenshot_url = $1, status = 'pass', updated_at = NOW()
      WHERE ctid IN (
        SELECT ctid FROM public.submissions
        ORDER BY updated_at DESC NULLS LAST, ctid DESC LIMIT 1
      )`;
    await client.query(sql, [screenshotUrl]);
    console.log("[db] Updated attempted_ai, screenshot_url, status, updated_at ✅");
    await client.end();
  } catch (err) {
    console.error("[db] Failed to update DB:", err.message);
  }
}

// ---------- navigation helpers ----------
async function clickSiteRow(page) {
  const siteRegex = /111\s*Auto\s*Entry,\s*San\s*Diego/i;
  console.log("[nav] Waiting for site list…");
  const siteEl = page.getByText(siteRegex, { exact: false }).first();
  await siteEl.waitFor({ state: "visible", timeout: 30000 });
  console.log('[nav] Clicking site row: "111 Auto Entry, San Diego"…');
  const popupPromise = page.waitForEvent("popup", { timeout: 15000 }).catch(() => null);
  const navPromise = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => null);
  await siteEl.click({ force: true }).catch((e) => {
    console.warn("[nav] Initial click failed, retrying once:", e.message);
  });
  const popup = await popupPromise;
  const nav = await navPromise;
  if (popup) {
    console.log("[nav] Site opened in a NEW TAB. Switching to it.");
    await popup.waitForLoadState("domcontentloaded").catch(() => {});
    return popup;
  }
  if (nav) {
    console.log("[nav] Site navigated in the SAME TAB:", page.url());
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
    if (!page.isClosed()) return page;
  }
  if (page.isClosed()) {
    console.warn("[nav] Original page is CLOSED. Finding newest page in context…");
    const pages = page.context().pages();
    const target = pages[pages.length - 1];
    if (target) {
      console.log("[nav] Switched to latest page. URL:", target.url());
      await target.waitForLoadState("domcontentloaded").catch(() => {});
      await target.waitForTimeout(500);
      return target;
    }
    throw new Error("No page is available after click (original closed, no popup found).");
  } else {
    console.log("[nav] Original page still open (likely SPA route). URL:", page.url());
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
    return page;
  }
}

async function clickMCH01NotStarted(targetPage) {
  let button = targetPage
    .locator("button.formbutton")
    .filter({ has: targetPage.locator("span", { hasText: /MCH01/i }) })
    .filter({ has: targetPage.locator("span", { hasText: /Not\s*Started/i }) })
    .first();
  console.log('[nav] Waiting for "MCH01 Not Started" button…');
  try {
    await button.waitFor({ state: "visible", timeout: 20000 });
  } catch {
    button = targetPage.locator("button", { hasText: /MCH01/i }).first();
    await button.waitFor({ state: "visible", timeout: 10000 });
  }
  console.log('[nav] Clicking "MCH01…" button…');
  await Promise.all([
    targetPage.waitForLoadState("networkidle").catch(() => {}),
    button.click({ force: true })
  ]);
  await targetPage.waitForTimeout(800);
  console.log("[nav] Target form view should now be visible.");
  return targetPage;
}

// ---------- main ----------
(async () => {
  try {
    console.log("Reading form_data from Retool Postgres…");
    const data = await readFormDataFromRetool();
    console.log("Loaded form_data keys:", Object.keys(data).length);
    const hasStorage = fs.existsSync("storageState.json");
    if (hasStorage) console.log("Using existing storageState.json for authenticated session.");
    else console.log("storageState.json not found — will allow manual login window and then save it.");
    const browser = await chromium.launch({ headless: HEADLESS, slowMo: 0 });
    const ctx = await browser.newContext(hasStorage ? { storageState: "storageState.json" } : {});
    const page = await ctx.newPage();
    console.log("Navigating to:", TARGET_URL);
    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    if (!hasStorage) {
      console.log(`If login is required, complete it now (waiting up to ${Math.round(MANUAL_LOGIN_WINDOW_MS/1000)}s)…`);
      await page.waitForTimeout(MANUAL_LOGIN_WINDOW_MS);
      try {
        await ctx.storageState({ path: "storageState.json" });
        console.log("Saved storageState.json ✅");
      } catch (e) {
        console.warn("Could not save storageState.json:", e.message);
      }
    }
    await Promise.race([
      page.getByText(/111\s*Auto\s*Entry,\s*San\s*Diego/i).waitFor({ state: "visible", timeout: 30000 }),
      page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {})
    ]).catch(() => {});
    const afterSitePage = await clickSiteRow(page);
    const formPage = await clickMCH01NotStarted(afterSitePage);
    console.log("Scanning fields and filling with mapped data…");
    await fillPageFromData(formPage, data);
    await saveAndScreenshot(formPage);
    console.log("Done.");
    await formPage.waitForTimeout(1500);
    await browser.close();
  } catch (err) {
    console.error("Fatal error:", err.message);
    process.exitCode = 1;
  }
})();

