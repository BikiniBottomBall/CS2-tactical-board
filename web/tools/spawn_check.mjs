/* 出生点近景验证：相机对准 T/CT 出生区截图 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const PY = path.join(ROOT, '.venv/Scripts/python.exe');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const server = spawn(PY, ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '8125'], {
  cwd: ROOT, stdio: 'ignore',
});
await new Promise(r => setTimeout(r, 4000));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--window-size=1600,1000'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  page.on('console', m => { if (m.type() === 'error') console.log('[page]', m.text()); });
  await page.goto('http://127.0.0.1:8125/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__mapReady === true', { timeout: 120000 });
  await page.evaluate(() => document.querySelector('button[data-mode="tactic"]').click());
  await new Promise(r => setTimeout(r, 1000));

  const views = [
    ['spawn_t', 15, 90],   // 匪家
    ['spawn_ct', 68, 8],  // 警家
  ];
  for (const [name, x, z] of views) {
    await page.evaluate((tx, tz) => {
      const c = window.__camera, ctl = window.__controls;
      c.position.set(tx + 30, 45, tz + 30);
      ctl.target.set(tx, 5, tz);
      ctl.update();
    }, x, z);
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: `../${name}.png` });
    console.log('saved', name);
  }
} finally {
  await browser.close();
  server.kill();
}
