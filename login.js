const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 80 });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('[login] Opening CHEERS login page…');
  await page.goto('https://www.cheers.org/app/login', { waitUntil: 'domcontentloaded' });

  console.log('[login] Log in manually in the browser.');
  console.log('[login] Once you reach the dashboard (Sites list), come back here and press Enter…');

  // Wait for Enter key press
  await new Promise((resolve) => process.stdin.once('data', resolve));

  // Save your session so future runs don’t need login
  await context.storageState({ path: 'storageState.json' });
  console.log('[login] ✅ Saved session to storageState.json');

  await browser.close();
})();
