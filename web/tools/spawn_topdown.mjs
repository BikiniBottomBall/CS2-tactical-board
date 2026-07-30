/* 出生点俯视验证：正俯拍两个出生区，确定平台范围 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const PY = path.join(ROOT, '.venv/Scripts/python.exe');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const server = spawn(PY, ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '8126'], {
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
  await page.goto('http://127.0.0.1:8126/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__mapReady === true', { timeout: 120000 });
  await page.evaluate(() => document.querySelector('button[data-mode="tactic"]').click());
  await new Promise(r => setTimeout(r, 1000));

  const views = [
    ['topdown_t', 5, 95],
    ['topdown_ct', 62, 5],
  ];
  for (const [name, x, z] of views) {
    await page.evaluate((tx, tz) => {
      const c = window.__camera, ctl = window.__controls;
      c.position.set(tx, 120, tz + 0.01);
      ctl.target.set(tx, 0, tz);
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
