/**
 * Playable Novel · 首屏视觉验收（坐标级）
 *
 * 功能 E2E 只能证明"能用"，这里证明"长得对"：
 * 在 1440×900 下断言 Hero 各元素的位置、字号、层级与折叠线关系，
 * 并检查字体自托管、无横向溢出、reduced-motion 无残留不可见元素。
 *
 * 运行（需先 npm start，另开一个终端）：
 *   NODE_PATH=<workspace>/node_modules node tests/visual.js
 *
 * 环境变量：
 *   BASE_URL   默认 http://127.0.0.1:3000
 *   CHROME     默认 /Applications/Google Chrome.app/.../Google Chrome
 */
const puppeteer = require('puppeteer-core');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FILE_URL = 'file://' + path.resolve(__dirname, '../public/index.html');

let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launch() {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--font-render-hinting=none'],
    protocolTimeout: 120000
  });
}

/* 量取 Hero 各元素的几何 + 字号 */
const measure = () => {
  const box = sel => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height),
      top: Math.round(r.top), bottom: Math.round(r.bottom),
      left: Math.round(r.left), right: Math.round(r.right),
      fontSize: parseFloat(cs.fontSize),
      opacity: parseFloat(cs.opacity),
      display: cs.display
    };
  };
  return {
    hero: box('.hero'),
    kicker: box('.hero-kicker'),
    hl1: box('.hero-headline .hl-line:nth-child(1)'),
    hl2: box('.hero-headline .hl-line:nth-child(2)'),
    sub: box('.hero-subline'),
    cta1: box('#heroStart'),
    cta2: box('#heroDemo'),
    f1: box('.hero-feature:nth-child(1)'),
    f2: box('.hero-feature:nth-child(2)'),
    f3: box('.hero-feature:nth-child(3)'),
    dz: box('#dropzone'),
    booting: document.body.classList.contains('booting'),
    fontLoaded: document.fonts.check('16px InterVar'),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    vw: window.innerWidth, vh: window.innerHeight
  };
};

async function waitEntrance(page) {
  await page.waitForFunction(() => !document.body.classList.contains('booting'), { timeout: 15000 });
  await sleep(120);
}

async function runChannel(page, tag, url) {
  console.log(`\n▸ ${tag}`);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(url, { waitUntil: 'networkidle2' });
  await waitEntrance(page);

  const m = await page.evaluate(measure);

  /* --- 字体自托管 --- */
  check('自托管西文字体已加载', m.fontLoaded, 'InterVar');
  check('无外部字体请求',
    !(await page.evaluate(() => [...document.querySelectorAll('link[href]')]
      .some(l => /fonts\.(googleapis|gstatic)\.com/.test(l.href)))));

  /* --- Hero 存在且成规模 --- */
  check('Hero 可见', m.hero && m.hero.display !== 'none' && m.hero.h > 240, `${m.hero && m.hero.h}px 高`);
  check('标题字号 ≈ 60u', Math.abs(m.hl1.fontSize - 60) <= 2, `${m.hl1.fontSize}px`);

  /* --- 纵向层级：kicker → 两行标题 → subline → CTA → 特性卡 --- */
  check('kicker 在标题之上', m.kicker.bottom <= m.hl1.top + 1, `${m.kicker.bottom} → ${m.hl1.top}`);
  check('标题两行依次排列', m.hl1.bottom <= m.hl2.top + 2 && Math.abs(m.hl1.fontSize - m.hl2.fontSize) < 0.5,
    `行2 顶 ${m.hl2.top}`);
  check('subline 在标题之下', m.sub.top >= m.hl2.bottom - 1, `${m.sub.top}`);
  check('CTA 在 subline 之下', m.cta1.top >= m.sub.bottom - 1, `${m.cta1.top}`);

  /* --- 双 CTA 同行，主在左 --- */
  check('双 CTA 同行同高', Math.abs(m.cta1.y - m.cta2.y) <= 1 && Math.abs(m.cta1.h - m.cta2.h) <= 1,
    `y=${m.cta1.y} h=${m.cta1.h}`);
  check('主 CTA 在左', m.cta1.right <= m.cta2.left, `${m.cta1.right} | ${m.cta2.left}`);

  /* --- 三张特性卡一行 --- */
  check('三卡同行', Math.abs(m.f1.y - m.f2.y) <= 1 && Math.abs(m.f2.y - m.f3.y) <= 1, `y=${m.f1.y}`);
  check('三卡左→右等宽', m.f1.left < m.f2.left && m.f2.left < m.f3.left
    && Math.abs(m.f1.w - m.f3.w) <= 2, `${m.f1.w}/${m.f2.w}/${m.f3.w}`);

  /* --- 折叠线：900 高视口下 CTA 必须可见，上传区顶部露出 --- */
  check('主 CTA 在首屏内', m.cta1.bottom < m.vh, `底 ${m.cta1.bottom} < ${m.vh}`);
  check('上传区顶部露出首屏', m.dz.top < m.vh, `顶 ${m.dz.top}`);

  /* --- 无横向溢出 --- */
  check('1440 无横向溢出', m.overflow <= 0, `超出 ${m.overflow}px`);

  /* --- 入场结束态：不能有元素卡在半透明（kicker 设计值为 .92） --- */
  const opacities = [m.kicker, m.hl1, m.hl2, m.sub, m.cta1, m.cta2, m.f1, m.f2, m.f3, m.dz];
  check('入场结束后无元素卡在半透明',
    opacities.every(o => o.opacity >= 0.9), opacities.map(o => o.opacity.toFixed(2)).join(','));

  /* --- 820px：缩放生效且不溢出 --- */
  await page.setViewport({ width: 820, height: 900 });
  await sleep(260);
  const s = await page.evaluate(measure);
  check('820 下标题缩小', s.hl1.fontSize < m.hl1.fontSize - 8, `${m.hl1.fontSize} → ${s.hl1.fontSize}`);
  check('820 无横向溢出', s.overflow <= 0, `超出 ${s.overflow}px`);

  /* --- 375px 手机 --- */
  await page.setViewport({ width: 375, height: 720 });
  await sleep(260);
  const p = await page.evaluate(measure);
  check('375 无横向溢出', p.overflow <= 0, `超出 ${p.overflow}px`);
  check('375 标题可读', p.hl1.fontSize >= 26, `${p.hl1.fontSize}px`);

  /* --- reduced-motion：不能有元素被留在 opacity 0 --- */
  await page.setViewport({ width: 1440, height: 900 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(url, { waitUntil: 'networkidle2' });
  await sleep(400);
  const r = await page.evaluate(measure);
  check('reduced-motion 直接落终态',
    [r.kicker, r.hl1, r.hl2, r.sub, r.cta1, r.cta2, r.f1].every(o => o.opacity >= 0.9)
    && !r.booting, r.booting ? 'booting 未解除' : 'ok');

  check('无 JS 报错', errors.length === 0, errors.join(' | '));
}

(async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await runChannel(page, 'http://', BASE_URL);
    await page.emulateMediaFeatures([]);
    await runChannel(page, 'file://', FILE_URL);
  } finally {
    await browser.close();
  }
  console.log(`\n${failed ? '❌' : '✅'} 视觉验收：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
