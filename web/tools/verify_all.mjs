/* 综合验证：侧边栏/工具互斥/出生点回归/坐标网格 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const PY = path.join(ROOT, '.venv/Scripts/python.exe');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const server = spawn(PY, ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '8127'], {
  cwd: ROOT, stdio: 'ignore',
});
await new Promise(r => setTimeout(r, 4000));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--window-size=1600,1000'],
});
const results = [];
const check = (name, ok, extra = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  page.on('console', m => { if (m.type() === 'error') console.log('[page-err]', m.text()); });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto('http://127.0.0.1:8127/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__mapReady === true', { timeout: 120000 });
  await new Promise(r => setTimeout(r, 1200));
  await page.screenshot({ path: '../sb_expanded.png' });

  // 1. 侧边栏折叠
  await page.click('#sidebar-toggle');
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: '../sb_collapsed.png' });
  const collapsedOk = await page.evaluate(() =>
    document.getElementById('sidebar').classList.contains('collapsed') &&
    getComputedStyle(document.querySelector('#sidebar .sb-txt')).display === 'none');
  check('侧边栏折叠仅图标', collapsedOk);
  await page.click('#sidebar-toggle');
  await new Promise(r => setTimeout(r, 400));

  // 2. 工具互斥：marker-t → tactic → 唯一高亮 + 面板开合
  await page.click('button[data-mode="marker-t"]');
  await new Promise(r => setTimeout(r, 300));
  let st = await page.evaluate(() => ({
    actives: [...document.querySelectorAll('#sidebar button[data-mode].active')].map(b => b.dataset.mode || b.id),
    cursor: document.querySelector('#app canvas').style.cursor,
  }));
  check('marker-t 唯一高亮', st.actives.length === 1 && st.actives[0] === 'marker-t', st.actives.join(','));
  check('标记工具十字光标', st.cursor === 'crosshair', st.cursor);

  await page.click('button[data-mode="tactic"]');
  await new Promise(r => setTimeout(r, 1000));
  st = await page.evaluate(() => ({
    actives: [...document.querySelectorAll('#sidebar button[data-mode].active')].map(b => b.dataset.mode || b.id),
    tacticPanel: document.body.classList.contains('tactic'),
    cursor: document.querySelector('#app canvas').style.cursor,
    actors: window.__scene.getObjectByName('tactic-actors')?.visible,
  }));
  check('切战术后 marker-t 退出', st.actives.length === 1 && st.actives[0] === 'tactic' && st.tacticPanel, st.actives.join(','));
  check('切战术光标还原+演员可见', st.cursor === '' && st.actors === true);
  await page.screenshot({ path: '../sb_tactic.png' });

  // 3. 出生点回归：演员位置 = 修复后的匪家/警家
  const spawnOk = await page.evaluate(() => {
    const g = window.__scene.getObjectByName('tactic-actors');
    const t1 = g.children.find(o => o.userData.actorId === 'T1');
    const ct1 = g.children.find(o => o.userData.actorId === 'CT1');
    // 期望 T1≈(11,*,86~94) CT1≈(64,*,4~12)（grid 偏移 ±4 内）
    const d = (p, x, z) => Math.hypot(p.x - x, p.z - z);
    return d(t1.position, 11, 90) < 6 && d(ct1.position, 64, 8) < 6;
  });
  check('出生点位置回归不变', spawnOk);

  // 4. Esc 回浏览模式
  await page.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 400));
  st = await page.evaluate(() => ({
    actives: document.querySelectorAll('#sidebar button[data-mode].active').length,
    tacticPanel: document.body.classList.contains('tactic'),
    actors: window.__scene.getObjectByName('tactic-actors')?.visible,
  }));
  check('Esc 回浏览（面板关+演员隐）', st.actives === 0 && !st.tacticPanel && st.actors === false);

  // 5. 道具录入中被战术抢模式 → 录入取消
  await page.click('button[data-mode="utility"]');
  await new Promise(r => setTimeout(r, 500));
  await page.click('#utility-add');
  await new Promise(r => setTimeout(r, 300));
  const recBefore = await page.evaluate(() => document.getElementById('utility-entry').style.display);
  await page.click('button[data-mode="tactic"]');
  await new Promise(r => setTimeout(r, 500));
  st = await page.evaluate(() => ({
    entry: document.getElementById('utility-entry').style.display,
    utilityPanel: document.body.classList.contains('utility'),
  }));
  check('录入中切模式→录入取消面板关', recBefore === 'block' && st.entry === 'none' && !st.utilityPanel);

  // 6. Demo 面板
  await page.keyboard.press('Escape');
  await page.click('button[data-mode="demo"]');
  await new Promise(r => setTimeout(r, 600));
  st = await page.evaluate(() => ({ demo: document.body.classList.contains('demo') }));
  check('Demo 面板开合', st.demo);
  await page.keyboard.press('Escape');

  // 7. 坐标网格
  await page.click('#btn-view-top');
  await new Promise(r => setTimeout(r, 600));
  await page.click('#btn-grid');
  await new Promise(r => setTimeout(r, 1500));
  const gridOk = await page.evaluate(() => window.__scene.getObjectByName('coord-grid')?.visible);
  check('正俯视网格可见', gridOk === true, JSON.stringify(gridOk));
} finally {
  await browser.close();
  server.kill();
}
console.log(results.join('\n'));
