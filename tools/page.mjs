// Open an engine page headlessly at a given surface scale, wait for its hooks.
import { createRequire } from 'node:module';
// Playwright is an optional peer dependency (npm i -D playwright && npx playwright install chromium).
// require() also finds a globally installed copy through NODE_PATH.
const { chromium } = createRequire(import.meta.url)('playwright');
import { serve, repoRoot } from './serve.mjs';
export async function openPage(pagePath, { scale = 1, hooks = '__fold', root = repoRoot } = {}) {
  // a page given as a full URL is opened where it is (a live show's page, served by its control room)
  const absolute = /^https?:\/\//.test(pagePath);
  const { server, url } = absolute ? { server: null, url: '' } : await serve(root);
  const address = absolute ? pagePath : `${url}/${pagePath}`;
  const browser = await chromium.launch();
  // first load at scale 1 to read the stage size, then size the viewport to it
  const probe = await (await browser.newContext()).newPage();
  const errors = []; probe.on('pageerror', e => errors.push(String(e)));
  const sep = pagePath.includes('?') ? '&' : '?';
  await probe.goto(`${address}${sep}export`); await probe.waitForFunction(h => globalThis[h]?.ready, hooks, { timeout: 60000 });
  const surf = await probe.evaluate(h => globalThis[h].surface(), hooks); await probe.close();
  const ctx = await browser.newContext({ viewport: { width: Math.ceil(surf.w), height: Math.ceil(surf.h) }, deviceScaleFactor: scale });
  const page = await ctx.newPage(); page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`${address}${sep}export`); await page.waitForFunction(h => globalThis[h]?.ready, hooks, { timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
  const H = (fn, ...a) => page.evaluate(([h, f, args]) => globalThis[h][f](...args), [hooks, fn, a]);
  return { page, browser, server, errors, surf: await H('surface'), H, close: async () => { await browser.close(); server?.close(); } };
}
