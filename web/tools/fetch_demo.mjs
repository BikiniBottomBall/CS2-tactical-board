/* 从 HLTV 抓一个 dust2 demo：过 Cloudflare → 找比赛页 → 拿下载链接 → 浏览器下载 */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const OUT_DIR = path.join(ROOT, 'data/demos/raw');

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--window-size=1400,900'],
});
try {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');

  console.log('打开 results 页…');
  await page.goto('https://www.hltv.org/results?map=de_dust2', { waitUntil: 'networkidle2', timeout: 60000 });
  for (let i = 0; i < 6; i++) {
    const title = await page.title();
    if (!/just a moment|attention required/i.test(title)) break;
    console.log('CF 挑战中，等待…', title);
    await new Promise(r => setTimeout(r, 5000));
  }
  console.log('页面标题:', await page.title());

  const matchUrls = await page.evaluate(() =>
    [...document.querySelectorAll('a[href^="/matches/"]')]
      .map(a => a.getAttribute('href'))
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .slice(0, 8));
  console.log('比赛链接:', matchUrls.length);

  let demoUrl = null;
  for (const mu of matchUrls) {
    await page.goto('https://www.hltv.org' + mu, { waitUntil: 'networkidle2', timeout: 60000 });
    const found = await page.evaluate(() => {
      const a = document.querySelector('a[href*="/download/demo/"]');
      return a ? a.getAttribute('href') : null;
    });
    console.log(mu, '→', found);
    if (found) { demoUrl = new URL(found, 'https://www.hltv.org').href; break; }
  }
  if (!demoUrl) throw new Error('没有找到 demo 下载链接');
  console.log('demo:', demoUrl);

  // 浏览器内下载
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: OUT_DIR });
  const before = new Set(fs.readdirSync(OUT_DIR));
  await page.goto(demoUrl, { timeout: 30000 }).catch(() => {}); // 下载会中断导航
  // 等文件出现且不再增长
  let file = null;
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const now = fs.readdirSync(OUT_DIR).filter(f => !before.has(f) && !f.endsWith('.crdownload'));
    const downloading = fs.readdirSync(OUT_DIR).some(f => f.endsWith('.crdownload'));
    if (now.length && !downloading) { file = now[0]; break; }
    if (i % 10 === 0) console.log('下载中…', fs.readdirSync(OUT_DIR).filter(f => !before.has(f)));
  }
  console.log('下载完成:', file, file ? fs.statSync(path.join(OUT_DIR, file)).size : 0, 'bytes');
} finally {
  await browser.close();
}
