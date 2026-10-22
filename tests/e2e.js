/**
 * Playable Novel · 全流程 E2E 冒烟测试
 *
 * 用真实浏览器走完：上传 → 世界推演 → 章节选择 → 8 轮互动 → 消息干预 → 导出 → 刷新恢复
 * 同时覆盖 file:// 本地直用模式（无 Node 后端）。
 *
 * 运行（需先 npm start，另开一个终端）：
 *   npm i -D puppeteer-core
 *   node tests/e2e.js
 *
 * 环境变量：
 *   BASE_URL   默认 http://127.0.0.1:3000
 *   CHROME     默认 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
 */
const puppeteer = require('puppeteer-core');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FILE_URL = 'file://' + require('path').resolve(__dirname, '../public/index.html');

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
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
    protocolTimeout: 180000
  });
}

/* 等待一次生成真正结束：无 streaming 态 + 停止按钮隐藏 */
function waitGeneration(page, minNarrations) {
  return page.waitForFunction(
    n => document.querySelectorAll('#storyFlow .msg.narration').length >= n &&
         !document.querySelector('.msg.streaming') &&
         getComputedStyle(document.getElementById('btnStop')).display === 'none',
    { timeout: 30000 }, minNarrations
  );
}

async function runFlow(page, tag) {
  console.log(`\n▸ ${tag}`);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(tag === 'file://' ? FILE_URL : BASE_URL, { waitUntil: 'networkidle2' });
  check('页面加载', (await page.title()).includes('Playable Novel'));

  const badge = await page.evaluate(() => document.getElementById('modeBadge').textContent);
  check('模式标识', !!badge, badge);

  await page.evaluate(() => document.getElementById('btnSample').click());
  await page.waitForFunction(
    () => document.getElementById('worldCard').textContent.includes('## 世界名称'),
    { timeout: 20000 }
  );
  check('世界卡片推演', true,
    (await page.evaluate(() => document.getElementById('worldCard').textContent.length)) + ' 字符');

  await page.evaluate(() => document.getElementById('btnGoChapters').click());
  await sleep(700);
  const chCount = await page.evaluate(() => document.querySelectorAll('#chapterList .chapter-item').length);
  const roleCount = await page.evaluate(() => document.querySelectorAll('#roleOptions .role-opt').length);
  check('章节切分', chCount >= 2, chCount + ' 章');
  check('角色选项', roleCount >= 3, roleCount + ' 个');

  await page.evaluate(() => document.getElementById('btnWbAutoExtract').click());
  await sleep(1800);
  const wbCount = await page.evaluate(() => document.getElementById('worldbookMeta').textContent);
  check('世界书自动提炼', /\d/.test(wbCount), wbCount);

  await page.evaluate(() => document.querySelectorAll('#chapterList .chapter-item')[1].click());
  await waitGeneration(page, 1);
  check('开场生成', true);

  const actions = [
    '我走向窗边的苏璃', '询问真言晶印记的来历', '连夜翻窗前往旧图书馆',
    '在书架深处找到那本残卷', '把残卷塞进怀里快步离开', '迎面撞上巡查的成员',
    '亮出伪造的徽章蒙混过关', '回到宿舍摊开残卷细读'
  ];
  for (let i = 0; i < actions.length; i++) {
    await page.evaluate(() => { document.getElementById('actionInput').value = ''; });
    await page.type('#actionInput', actions[i]);
    await page.click('#btnSend');
    await waitGeneration(page, i + 2);
  }
  check('连续 8 轮互动', true);

  const st = await page.evaluate(() => ({
    narration: document.querySelectorAll('#storyFlow .msg.narration').length,
    state: document.getElementById('sideState').className,
    mem: document.getElementById('memoryMeta').textContent,
    usage: document.getElementById('sideUsage').textContent,
    timeline: document.querySelectorAll('#timelineList .timeline-item').length
  }));
  check('角色状态面板', st.state === 'state-panel');
  check('记忆体压缩', parseInt(st.mem) > 0, st.mem);
  check('成本统计', /tokens/.test(st.usage));
  check('分支快照', st.timeline >= 1, st.timeline + ' 个');

  // 导出
  await page.evaluate(() => document.getElementById('btnExport').click());
  await sleep(600);
  check('导出弹窗', await page.evaluate(() => !!document.querySelector('#exportModal.open')));
  const md = await page.evaluate(() => new Promise(res => {
    let cap = null;
    window.downloadFile = (fn, content) => { cap = { fn, len: content.length }; };
    document.getElementById('btnExportMd').click();
    setTimeout(() => res(cap), 400);
  }));
  check('Markdown 导出', !!md && md.len > 200, md ? `${md.len} 字符` : '');
  await page.evaluate(() => document.getElementById('btnCloseExport').click());

  // 刷新恢复
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(3000);
  const restored = await page.evaluate(() => ({
    onStage: !!document.querySelector('#step-play.active'),
    msgs: document.querySelectorAll('#storyFlow .msg').length
  }));
  check('刷新自动恢复', restored.onStage && restored.msgs > 0,
    restored.msgs + ' 条消息');

  const realErrors = errors.filter(e => !/github|api\.github/.test(e));
  check('零 JS 异常', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));
}

(async () => {
  const browser = await launch();

  // 通道一：Node 服务端模式
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 950 });
    page.on('dialog', d => d.accept());
    await runFlow(page, BASE_URL);
    await page.close();
  } catch (e) {
    failed++;
    console.log('  ❌ 服务端模式异常：' + e.message);
  }

  // 通道二：file:// 本地直用
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 950 });
    page.on('dialog', d => d.accept());
    await runFlow(page, 'file://');
    await page.close();
  } catch (e) {
    failed++;
    console.log('  ❌ 本地模式异常：' + e.message);
  }

  await browser.close();
  console.log(`\n${'='.repeat(46)}`);
  console.log(`结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();