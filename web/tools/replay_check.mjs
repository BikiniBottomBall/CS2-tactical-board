/* demo 回放验证：加载 synthetic_walk → 多个时间点截图 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const PY = path.join(ROOT, '.venv/Scripts/python.exe');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const server = spawn(PY, ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '8124'], {
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
  await page.goto('http://127.0.0.1:8124/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__mapReady === true', { timeout: 120000 });

  // 打开 demo 面板并选中 synthetic_walk
  await page.evaluate(() => document.querySelector('button[data-mode="demo"]').click());
  await new Promise(r => setTimeout(r, 800));
  await page.evaluate(() => document.querySelector('.demo-item .demo-name').click());
  await page.waitForFunction(
    () => document.getElementById('replay-bar').style.display === 'block', { timeout: 20000 });
  await new Promise(r => setTimeout(r, 800));

  // 斜 45° 默认视角下按时间点截图
  for (const t of [50, 120, 300, 600]) {
    await page.evaluate((tt) => {
      const s = document.getElementById('replay-slider');
      s.value = String(tt);
      s.dispatchEvent(new Event('input'));
    }, t);
    await new Promise(r => setTimeout(r, 700));
    await page.screenshot({ path: `../replay_5e_${t}s.png` });
    console.log('saved', `replay_5e_${t}s.png`);
  }
} finally {
  await browser.close();
  server.kill();
}
