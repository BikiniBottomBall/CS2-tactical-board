/* e2e 截图：起本地服务 → 等地图就绪 → 按需交互 → 截图
 * 用法: node tools/shot.mjs <out.png> [actions]
 *   actions 逗号分隔: shot(正俯视) tactic(打开战术面板显示演员) demo(打开demo面板)
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const [out = 'e2e.png', actions = ''] = process.argv.slice(2);
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const PY = path.join(ROOT, '.venv/Scripts/python.exe');

const server = spawn(PY, ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '8123'], {
  cwd: ROOT, stdio: 'ignore',
});
await new Promise(r => setTimeout(r, 4000));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--window-size=1600,1000'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  page.on('console', m => { if (m.type() === 'error') console.log('[page]', m.text()); });
  await page.goto('http://127.0.0.1:8123/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__mapReady === true', { timeout: 120000 });
  await new Promise(r => setTimeout(r, 1500));

  for (const act of actions.split(',').filter(Boolean)) {
    if (act === 'shot') await page.evaluate(() => document.getElementById('btn-view-top').click());
    if (act === 'tactic') await page.evaluate(() => document.querySelector('button[data-mode="tactic"]').click());
    if (act === 'demo') await page.evaluate(() => document.querySelector('button[data-mode="demo"]').click());
    await new Promise(r => setTimeout(r, 1200));
  }
  await new Promise(r => setTimeout(r, 800));
  await page.screenshot({ path: out });
  console.log('saved', out);
} finally {
  await browser.close();
  server.kill();
}
