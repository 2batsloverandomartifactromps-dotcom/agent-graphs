// Ad-hoc screenshot helper for manual review (not part of the suite).
import { chromium } from '@playwright/test';

const out = process.env.OUT ?? '.';
const base = process.env.BASE ?? 'http://localhost:5173';
const urls = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errors = [];
for (const u of urls) {
  const [path, name, theme] = u.split('|');
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${name}: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`${name}: ${String(e)}`));
  await page.addInitScript((t) => {
    localStorage.setItem(
      'agent-graphs.settings',
      JSON.stringify({ state: { theme: t || 'dark', actorName: 'Maintainer' }, version: 0 }),
    );
  }, theme ?? 'dark');
  await page.goto(base + path);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/${name}.png` });
  await page.close();
}
console.log(errors.slice(0, 30).join('\n'));
await browser.close();
