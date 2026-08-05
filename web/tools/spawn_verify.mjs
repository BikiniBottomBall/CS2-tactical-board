/* 出生点验证：读取演员实际位置 → 相机对准 → 截图 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const PY = path.join(ROOT, '.venv/Scripts/python.exe');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const server = spawn(PY, ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '8129'], {
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
  await page.goto('http://127.0.0.1:8129/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__mapReady === true', { timeout: 120000 });
  await page.evaluate(() => document.querySelector('button[data-mode="tactic"]').click());
  await new Promise(r => setTimeout(r, 1000));

  // 打印演员实际场景坐标（供核对）
  const pos = await page.evaluate(() => {
    const g = window.__scene.getObjectByName('tactic-actors');
    const t1 = g.children.find(o => o.userData.actorId === 'T1');
    const ct1 = g.children.find(o => o.userData.actorId === 'CT1');
    return { T1: t1.position.toArray(), CT1: ct1.position.toArray() };
  });
  console.log('演员位置:', JSON.stringify(pos));

  for (const [name, key] of [['spawn_t_real', 'T1'], ['spawn_ct_real', 'CT1']]) {
    await page.evaluate((k) => {
      const g = window.__scene.getObjectByName('tactic-actors');
      const a = g.children.find(o => o.userData.actorId === k);
      const c = window.__camera, ctl = window.__controls;
      c.position.set(a.position.x + 35, a.position.y + 50, a.position.z + 35);
      ctl.target.copy(a.position);
      ctl.update();
    }, key);
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: `../${name}.png` });
    console.log('saved', name);
  }
  // 全景俯视：两个出生区都标出来
  await page.evaluate(() => document.getElementById('btn-view-top').click());
  await new Promise(r => setTimeout(r, 800));
  await page.screenshot({ path: '../spawn_topview_real.png' });
  console.log('saved spawn_topview_real');
} finally {
  await browser.close();
  server.kill();
}
