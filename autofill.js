// autofill.js
// Run: node autofill.js
// Prereqs: npm i playwright

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// ---------- CONFIG ----------
const FORM_URL = 'https://substackcaio.retool.com/apps/324fca62-721a-11f0-821f-a73d885d25a1/Mobile_Automation_Form/page1';

// Tuning knobs (feel free to adjust)
const ITERATIONS = 10;                // number of cycles
const DELAY_BEFORE_LOAD_MS = 2_000;   // wait before each run (reduced for testing)
const RENDER_SETTLE_MS = 8_000;       // wait for Retool widgets to render

// Windows Chrome profile path (POINT DIRECTLY TO THE PROFILE FOLDER)
const PROFILE_DIR_PATH = path.join(
  'C:\\', 'Users', 'HP', 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Profile 18'
);

// Artifacts folder
const OUT_DIR = path.join(process.cwd(), 'run_artifacts');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ---------- FIELD MAP ----------
const FIELD_MAP = {
  "CMF": "CFM", "CZ2": "CZ:", "XTOn": "x Tons", "sqft": "SQFT", "Rater": "Rater",
  "date2": "2025-08-29T23:53:52.206+0500", "email": "Email", "time2": "2025-08-29T23:53:52.207+0500",
  "CFM300": true, "CFM350": true, "TXV_10": "(10 is Default)", "Address": "Homeowner", "PSI_Red": "PSI Red",
  "TXVPass": "+5/-5 = pass", "Tsupply": "T supply", "checkno": "Check #", "milesto": "Miles to",
  "rooftop": "Location of Unit  Roof Top", "switch6": true, "switch7": true, "switch8": true, "switch9": true,
  "DBSmoke2": "DB Smoke", "GrillDim": "Grill Dim", "NoTXV_18": "#18 - #15", "PSI_Blue": "PSI Blue",
  "R_value2": "R-Value:", "cityzip2": "City/Zip", "switch10": true, "GrillDimX": "X", "HomeOwner": "Homeowner",
  "TReturnDB": "T Return DB", "TReturnWB": "T Return WB", "TXV_17_19": "#17 - #19", "Tliquid19": "Tsuction (18)",
  "TragetFWD": "Traget FWD", "bedsrooms": "# BedsRooms", "textArea7": "", "textArea8": "", "textArea9": "",
  "CMFX45_max": "X .45 = max", "Contractcr": "Contractor", "NoTXVChart": "No TXV Chart (ref #13 & #20)",
  "NoTXV_Pass": "+5/-5 = pass", "RaterNote2": "Rater Notes:", "Tsuction18": "Tsuction (18)",
  "actualCFM2": "Actual CFM", "filtersize": "Filter Size", "yearofhome": "Year of Home", "FurnaceSeer": "Furnace Seer",
  "GrillDim144": "/144", "MECH04_X218": "Furnace x 217 =", "MeasuredCMF": "Measured CFM", "MeasuredFWD": "Measured FWD",
  "SuperHeat15": "#15", "SuperHeat18": "#18", "checkamount": "Check Amount $", "filtersizeX": "X",
  "radioGroup2": "yes", "textInput45": "Duct Location", "CondenserTon": "Condenser  Ton", "WattMeasured": "Watt Measured",
  "CondenserSeer": "Seer", "CondenserTon1": "Ton", "CondenserX400": "Condenser x400", "DuctLocation2": "Duct Location",
  "FuranceBrand2": " Furnace  Brand", "FurnaceOutput": "Furnace Ton",
  "Out_Door_Temp": "Out Door Temp At Min. 55 deg. To test Condenser",
  "SuperHeat4_25": "4 to 25 = pass", "CondenserModel": "Model#", "LocationofUnit": "Location of Unit",
  "NumberOfReturn": "", "OriginalOrder2": "Original Order / Paperwork from office:\n", "RCA_weight_in2": "RCA weight-in",
  "checkboxGroup5": ["Asbestos", "Less than 25' of Duck in Uncod Space"],
  "checkboxGroup6": ["Split System", "Heating Only", "Package unit", "Mini Split"],
  "checkboxGroup7": ["MECH-20 (5%CE)", "MECH-20 (10%DB)", "MECH-22 (FWD)", "MECH-23 (CCA)", "MECH_25 (RCA)"],
  "coolingmethod5": "5", "heatingMethod5": "5 `", "CondenserSerial": "Serial#", "CondenserX05_10": "x 05/ 10",
  "FuranceBrand_X6": "x 05/ 10", "Lineset_Length2": "Lineset Length:", "LocationOutside": "Location of Unit  Outside",
  "MECH_04_Output2": "Furnace  Output", "On_SiteChanges2": "On-Site Changes To Order From Rater:\n",
  "PcondenserRed17": "Pcondenser Red (17)", "coolingmethod10": "10", "heatingMethod10": "10",
  "DuctsNewExisting": "Ducts New / Existing !", "Pavaporator_Blue": "Pavaporator Blue (sat 15)",
  "FaranceRefrigerant": "Furnace Refrigerant Type", "FuranceBrandModel2": "Furnace  Model",
  "FuranceBrandSerial2": "Furnace Serial #", "CondenserRefrigerant": "Refrigerant Type",
  "CondenserFuranceBrand": "Furance Brand"
};

// ---------- HELPERS ----------
const looksLikeISO = (s) =>
  typeof s === 'string' && /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s);

async function getBestFormScope(page) {
  const frames = page.frames();
  let best = page;
  let bestScore = await countInputs(page).catch(() => 0);
  for (const f of frames) {
    const url = f.url().toLowerCase();
    const score = await countInputs(f).catch(() => 0);
    if (url.includes('retool') || url.includes('substackcaio.retool')) {
      if (score >= bestScore) { best = f; bestScore = score; }
    } else if (score > bestScore) {
      best = f; bestScore = score;
    }
  }
  return best;
}

async function countInputs(scope) {
  return await scope.locator('input,textarea,select,[role="textbox"]').count();
}

async function ensureReady(scope) {
  await scope.waitForSelector('input,textarea,select,[role="textbox"]', { timeout: 30_000 });
  await scope.waitForTimeout(800);
}

async function scrollIntoViewAndType(el, text) {
  try { await el.scrollIntoViewIfNeeded().catch(() => {}); } catch {}
  await el.click({ timeout: 5_000 }).catch(() => {});
  // Prefer fill over type for reliability
  await el.fill(String(text)).catch(async () => {
    await el.type(String(text), { delay: 15 }).catch(() => {});
  });
}

async function fillTextLike(scope, labelText, value) {
  if (!labelText) return false;

  // 1) ARIA label
  try {
    const ctl = scope.getByLabel(labelText, { exact: false }).first();
    if (await ctl.isVisible().catch(() => false)) {
      await scrollIntoViewAndType(ctl, value);
      return true;
    }
  } catch {}

  // 2) label text → following control
  const lower = labelText.toLowerCase();
  const labelNode = scope.locator(
    `xpath=//*[contains(translate(normalize-space(string(.)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), "${lower}")]`
  ).first();

  if (await labelNode.isVisible().catch(() => false)) {
    const control = labelNode.locator(
      'xpath=.//following::input[1] | .//following::textarea[1] | .//following::select[1] | .//following::*[@role="textbox"][1]'
    ).first();
    if (await control.isVisible().catch(() => false)) {
      const tag = await control.evaluate(el => (el.tagName || '').toLowerCase()).catch(() => '');
      if (tag === 'select') {
        await control.selectOption({ label: String(value) }).catch(async () => {
          await control.selectOption({ value: String(value) }).catch(async () => {
            await scrollIntoViewAndType(control, value);
          });
        });
      } else {
        await scrollIntoViewAndType(control, value);
      }
      return true;
    }
  }

  // 3) Sweep inputs by placeholder/aria-label/name/id
  const all = scope.locator('input,textarea,select,[role="textbox"]');
  const count = await all.count();
  for (let i = 0; i < count; i++) {
    const el = all.nth(i);
    const attrs = await el.evaluate(n => ({
      pl: n.getAttribute && n.getAttribute('placeholder') || '',
      al: n.getAttribute && n.getAttribute('aria-label') || '',
      name: n.getAttribute && n.getAttribute('name') || '',
      id: n.id || ''
    })).catch(() => null);
    if (!attrs) continue;
    const concat = `${attrs.pl} ${attrs.al} ${attrs.name} ${attrs.id}`.toLowerCase();
    if (concat.includes(lower)) {
      const tag = await el.evaluate(e => (e.tagName || '').toLowerCase()).catch(() => '');
      if (tag === 'select') {
        await el.selectOption({ label: String(value) }).catch(async () => {
          await el.selectOption({ value: String(value) }).catch(async () => {
            await scrollIntoViewAndType(el, value);
          });
        });
      } else {
        await scrollIntoViewAndType(el, value);
      }
      return true;
    }
  }

  return false;
}

async function clickCheckboxLike(scope, labelText) {
  if (!labelText) return false;
  const byRole = scope.getByRole('checkbox', { name: new RegExp(labelText, 'i') }).first();
  if (await byRole.isVisible().catch(() => false)) {
    await byRole.check().catch(async () => byRole.click());
    return true;
  }
  const lower = labelText.toLowerCase();
  const labelNode = scope.locator(
    `xpath=//*[contains(translate(normalize-space(string(.)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), "${lower}")]`
  ).first();

  if (await labelNode.isVisible().catch(() => false)) {
    const box = labelNode.locator('xpath=.//following::input[@type="checkbox"][1]').first();
    if (await box.isVisible().catch(() => false)) {
      const isChecked = await box.isChecked().catch(() => false);
      if (!isChecked) await box.check().catch(async () => box.click());
      return true;
    }
    // Retool switches may be div/button with same label
    await labelNode.click().catch(() => {});
    return true;
  }
  return false;
}

async function clickRadioLike(scope, optionText) {
  const radio = scope.getByRole('radio', { name: new RegExp(optionText, 'i') }).first();
  if (await radio.isVisible().catch(() => false)) {
    await radio.check().catch(async () => radio.click());
    return true;
  }
  const lower = optionText.toLowerCase();
  const node = scope.locator(
    `xpath=//*[contains(translate(normalize-space(string(.)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), "${lower}")]`
  ).first();
  if (await node.isVisible().catch(() => false)) {
    const input = node.locator('xpath=.//following::input[@type="radio"][1]').first();
    if (await input.isVisible().catch(() => false)) {
      await input.check().catch(async () => input.click());
      return true;
    }
    await node.click().catch(() => {});
    return true;
  }
  return false;
}

async function trySubmit(scope) {
  const candidates = [
    scope.getByRole('button', { name: /submit/i }),
    scope.getByRole('button', { name: /save/i }),
    scope.locator('button:has-text("Submit")'),
    scope.locator('button:has-text("Save")'),
    scope.locator('[data-testid*="Button"]').filter({ hasText: /submit|save/i }),
    scope.locator('[class*="button"]').filter({ hasText: /submit|save/i }),
  ];
  for (const loc of candidates) {
    const ok = await loc.first().isVisible().catch(() => false);
    if (ok) {
      await loc.first().scrollIntoViewIfNeeded().catch(() => {});
      await loc.first().click().catch(() => {});
      return true;
    }
  }
  return false;
}

function deriveValue(key, labelText, providedValue, runIndex) {
  if (/duct/i.test(String(labelText)) || /duct/i.test(String(providedValue)) || /duct/i.test(String(key))) {
    return `Duct(${runIndex})`;
  }
  if (looksLikeISO(providedValue)) return providedValue;
  if (typeof providedValue === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(providedValue)) {
    return `${providedValue}-${runIndex}`;
  }
  return `${key}-${runIndex}`;
}

// ---------- MAIN ----------
(async () => {
  // Basic validation for profile path
  if (!fs.existsSync(PROFILE_DIR_PATH)) {
    console.error('❌ Profile path not found:', PROFILE_DIR_PATH);
    console.error('→ Update PROFILE_DIR_PATH to your actual Chrome profile folder (e.g., ...\\User Data\\Profile 18)');
    process.exit(1);
  }

  console.log('[launch] Starting Chrome persistent context with profile:', PROFILE_DIR_PATH);
  const context = await chromium.launchPersistentContext(PROFILE_DIR_PATH, {
    channel: 'chrome',      // use system Chrome
    headless: false,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const page = await context.newPage();

  // Helpful diagnostics
  page.on('console', msg => console.log('[console]', msg.type(), msg.text()));
  page.on('pageerror', err => console.warn('[pageerror]', err));
  page.on('requestfailed', req => console.warn('[requestfailed]', req.method(), req.url(), req.failure()?.errorText));

  for (let i = 1; i <= ITERATIONS; i++) {
    console.log(`\n[Run ${i}] waiting ${Math.round(DELAY_BEFORE_LOAD_MS / 1000)}s before loading…`);
    await page.waitForTimeout(DELAY_BEFORE_LOAD_MS);

    console.log(`[Run ${i}] goto form…`);
    await page.bringToFront();

    try {
      await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    } catch (e) {
      console.error(`[Run ${i}] goto failed:`, e.message);
      await page.screenshot({ path: path.join(OUT_DIR, `run_${i}_goto_error.png`), fullPage: true });
      continue;
    }

    // Wait for Retool widgets to render
    await page.waitForTimeout(RENDER_SETTLE_MS);

    // Choose best scope (page or iframe)
    const scope = await getBestFormScope(page);
    const scopeType = scope === page ? 'page' : 'frame';
    const scopeUrl = (scope.url && typeof scope.url === 'function') ? scope.url() : 'n/a';
    console.log(`[Run ${i}] scope chosen → ${scopeType} (${scopeUrl})`);

    // Ensure inputs are ready
    try {
      await ensureReady(scope);
    } catch {
      console.warn(`[Run ${i}] inputs not detected — saving screenshot…`);
      await page.screenshot({ path: path.join(OUT_DIR, `run_${i}_no_inputs.png`), fullPage: true });
      continue;
    }

    // If looks logged out, capture and continue (optional heuristic)
    const mightBeLoggedOut = await page.getByText(/log ?in|sign ?in/i).first().isVisible().catch(() => false);
    if (mightBeLoggedOut) {
      console.warn(`[Run ${i}] looks logged out — check Chrome profile authentication.`);
      await page.screenshot({ path: path.join(OUT_DIR, `run_${i}_login_needed.png`), fullPage: true });
      continue;
    }

    // ----- FILL -----
    for (const [key, labelOrConfig] of Object.entries(FIELD_MAP)) {
      try {
        if (typeof labelOrConfig === 'boolean') {
          if (labelOrConfig) {
            const tried =
              await clickCheckboxLike(scope, key) ||
              await clickCheckboxLike(scope, key.replace(/_/g, ' '));
            console.log(`[Run ${i}] [check] ${key} → ${tried ? 'clicked' : 'not found'}`);
          }
          continue;
        }

        if (Array.isArray(labelOrConfig)) {
          let hits = 0;
          for (const opt of labelOrConfig) {
            const ok = await clickCheckboxLike(scope, opt);
            if (ok) hits++;
          }
          console.log(`[Run ${i}] [group] ${key} → ${hits}/${labelOrConfig.length} checked`);
          continue;
        }

        const labelText = String(labelOrConfig || key);

        if (/radio/i.test(key)) {
          const ok = await clickRadioLike(scope, labelText);
          console.log(`[Run ${i}] [radio] ${key}=${labelText} → ${ok ? 'clicked' : 'not found'}`);
          continue;
        }

        const value = deriveValue(key, labelText, labelOrConfig, i);
        const ok =
          await fillTextLike(scope, labelText, value) ||
          await fillTextLike(scope, key, value) ||
          await fillTextLike(scope, key.replace(/_/g, ' '), value);

        console.log(`[Run ${i}] [fill] ${key} (${labelText}) = "${value}" → ${ok ? 'filled' : 'not found'}`);
      } catch (err) {
        console.warn(`[Run ${i}] [warn] ${key}: ${err?.message || err}`);
      }
    }

    // ----- SUBMIT -----
    const submitted = await trySubmit(scope);
    console.log(`[Run ${i}] submit → ${submitted ? 'clicked' : 'not found'}`);

    // Snapshot after each run
    await page.screenshot({ path: path.join(OUT_DIR, `run_${i}_after.png`), fullPage: true });
    await page.waitForTimeout(1_000);
  }

  console.log('\nAll runs done. Cleaning up…');
  await context.close();
  console.log('✅ Done. Check the "run_artifacts" folder for screenshots.');
})().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
