/* 层级探针：对 T/CT 出生实体坐标做 __probeLayers 诊断 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const PY = path.join(ROOT, '.venv/Scripts/python.exe');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const server = spawn(PY, ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '8131'], {
  cwd: ROOT, stdio: 'ignore',
});
await new Promise(r => setTimeout(r, 4000));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--use-angle=default', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8131/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__mapReady === true', { timeout: 120000 });
  const res = await page.evaluate(() => ({
    T: window.__probeLayers(-756, -791, 145),
    CT: window.__probeLayers(281, 2269, -109),
  }));
  console.log(JSON.stringify(res, null, 1));
} finally {
  await browser.close();
  server.kill();
}
