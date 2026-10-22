/**
 * Playable Novel · 云服务真流量契约（L2/L3）
 *
 * 跑在**已发布域名**上，验证真实数据面：模型目录、真实生成、验证码通道、未登录门禁。
 * 与 flows.test.js 的区别：那边打桩验证业务逻辑，这边打真网验证接线正确。
 *
 * 运行：NODE_PATH=<ws>/node_modules node tests/cloud.live.js
 * 环境：BASE_URL 默认线上分享链接；网络不可达时整体 SKIP（退出码 0，不误报红）。
 *
 * 覆盖清单：BOOT-05 / CHN-03 / CHN-08 / CLD-03 / CLD-01
 * 未覆盖（需真人收码）：CLD-06 / CLD-07 / CLD-08 / CLD-11
 */
const puppeteer = require('puppeteer-core');

const BASE_URL = process.env.BASE_URL || 'https://playable-novel.app.workbuddy.host/?sharecode=FYRPIHWYES';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PREFERRED = ['deepseek-v4.1-flash', 'glm-5.3-flash', 'hy3'];

let passed = 0, failed = 0, skipped = 0;
function check(id, label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${id} ${label}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ❌ ${id} ${label}${detail ? ' — ' + detail : ''}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-gpu'], protocolTimeout: 180000
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  try {
    console.log(`\n▸ 目标：${BASE_URL}`);
    await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForFunction(() => !document.body.classList.contains('booting'), { timeout: 25000 });
    await sleep(2500);

    const boot = await page.evaluate(async () => {
      const st = window.PNCloud ? await window.PNCloud.status() : { ready: false, reason: 'cloud.js 未加载' };
      return {
        sdk: !!window.WorkBuddyCloud,
        ready: st.ready, reason: st.reason,
        cloudOk: typeof CLOUD_OK === 'boolean' ? CLOUD_OK : null,
        badge: (document.getElementById('modeBadge') || {}).textContent || '',
        btn: (document.getElementById('btnCloud') || {}).textContent || ''
      };
    });

    if (!boot.sdk || !boot.ready) {
      skipped++;
      console.log(`  ⏭ SKIP 云服务不可达（${boot.reason || 'SDK 未加载'}）——真流量用例整体跳过`);
      console.log(`\n⏭ 跳过：${skipped}`);
      await browser.close();
      process.exit(0);
    }

    check('BOOT-05', '线上云服务置位且徽标显示云端模型',
      boot.cloudOk === true && /云端模型/.test(boot.badge), boot.badge);
    check('CLD-00', 'SDK 已加载、登录入口可用', boot.sdk && boot.btn.length > 0, boot.btn);

    // CHN-08 默认模型必须是低延迟档（不能是 auto）
    const model = await page.evaluate(() => PNCloud.llm.currentModel());
    check('CHN-08', '默认模型为低延迟模型', PREFERRED.includes(model), String(model));

    // CLD-01 未登录读存档必须被门禁拦下（不发业务请求）
    const gate = await page.evaluate(async () => {
      try { await PNCloud.saves.list(); return { blocked: false }; }
      catch (e) { return { blocked: true, needLogin: !!e.needLogin, message: e.message }; }
    });
    check('CLD-01', '未登录读云端存档被明确拦截',
      gate.blocked && gate.needLogin, gate.message || '');

    // CLD-03 验证码通道（用保留域名，不会真实投递）
    const otp = await page.evaluate(async () => {
      try {
        const p = await PNCloud.auth.sendCode('verify-only@example.com');
        return { ok: !!p.verificationId };
      } catch (e) { return { ok: false, message: e.message }; }
    });
    check('CLD-03', '验证码通道返回 verificationId', otp.ok, otp.message || '');

    // CHN-03 真实生成（一次，验证真流量而非桩）
    const gen = await page.evaluate(async () => {
      const t0 = performance.now();
      let streamed = 0;
      try {
        const r = await PNCloud.llm.chat({
          messages: [
            { role: 'system', content: '你是互动小说叙事引擎，用中文回答，20 字以内。' },
            { role: 'user', content: '用一句话写夜色。' }
          ],
          temperature: 0.8,
          onDelta: d => { streamed += d.length; }
        });
        return {
          ok: !!r.content, len: (r.content || '').length, streamed,
          usage: r.usage ? r.usage.completion_tokens : null,
          ms: Math.round(performance.now() - t0)
        };
      } catch (e) { return { ok: false, message: e.message }; }
    });
    check('CHN-03', '云端真实生成返回正文', gen.ok && gen.len > 0, `${gen.len} 字 / ${gen.ms}ms`);
    check('CHN-03b', '流式增量与 usage 均回传', gen.streamed > 0 && gen.usage > 0, `delta=${gen.streamed} tokens=${gen.usage}`);
    check('CHN-08b', '单轮延迟在可交互区间（<15s）', gen.ms < 15000, `${gen.ms}ms`);

    // 失败路径可用性：错误模型 id 应报可读错误而不是崩
    const bad = await page.evaluate(async () => {
      PNCloud.llm.setModel('__not_a_model__');
      try {
        await PNCloud.llm.chat({
          messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]
        });
        return { threw: false };
      } catch (e) { return { threw: true, message: e.message }; }
      finally { PNCloud.llm.setModel(null); }
    });
    check('CHN-09', '非法模型返回可读错误', bad.threw && /模型|请求|失败|不可用/.test(bad.message || ''), (bad.message || '').slice(0, 40));

    check('ZERO-ERR', '真流量流程零 JS 异常', errors.length === 0, errors.slice(0, 2).join(' | '));
  } catch (e) {
    failed++;
    console.log('  ❌ 运行异常：' + e.message);
  } finally {
    await browser.close();
  }

  console.log('\n' + '='.repeat(46));
  console.log(`${failed ? '❌' : '✅'} 云端契约：${passed} 通过 / ${failed} 失败${skipped ? ` / ${skipped} 跳过` : ''}`);
  console.log('='.repeat(46));
  process.exit(failed ? 1 : 0);
})();
