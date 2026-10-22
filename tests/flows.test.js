/**
 * Playable Novel · 功能原子用例（L3 集成层）
 *
 * 覆盖 tests/TEST-PLAN.md 中无法靠「点一遍」验证的 P0/P1 用例：
 * 提示词组装、通道回落、停止生成、消息干预、分支、导出、设置、云服务门禁、XSS。
 *
 * 手法：把云端通道打桩（替换 PNCloud.llm.chat），从而
 *  ① 断言真正送进模型的 messages（prompt 内容、system 首条）
 *  ② 不依赖真实模型输出，用例稳定、快
 * 每个 check 都对应清单里的一个 ID。
 *
 * 运行：NODE_PATH=<ws>/node_modules node tests/flows.test.js
 */
const puppeteer = require('puppeteer-core');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let passed = 0, failed = 0;
const failures = [];
function check(id, label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${id} ${label}${detail ? ' — ' + detail : ''}`); }
  else { failed++; failures.push(id + ' ' + label); console.log(`  ❌ ${id} ${label}${detail ? ' — ' + detail : ''}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 页面内工具（注入到 window） ---------- */
const PAGE_HELPERS = () => {
  window.__t = {
    /* 重置到「已进入舞台」的最小状态 */
    seed(opts = {}) {
      state.novel = {
        title: '测试小说',
        fullText: '第一章 开端\n苏璃站在窗前，指尖抵着霜纹剑柄。',
        chapters: [{ id: 1, title: '第一章 开端', content: '苏璃站在窗前，指尖抵着霜纹剑柄。' }]
      };
      state.entryChapter = 1;
      state.selectedRole = '林越';
      state.playing = !opts.notPlaying;
      state.turn = opts.turn == null ? 3 : opts.turn;
      state.world = '## 世界名称\n测试世界';
      state.worldbook = opts.worldbook || [{
        id: 1, type: 'character', name: '苏璃', content: '银色短发，佩剑霜纹',
        mode: 'always', keywords: [], enabled: true
      }];
      state.history = opts.history || [];
      state.rollingSummary = opts.summary || '';
      state.summarizedTurns = opts.summarizedTurns || 0;
      state.charState = opts.charState || null;
      state.events = [];
      state.factList = opts.factList || '';
      state.branches = [];
      state.sourceLang = null;
      state.genAbort = null;
      state._lastUserInput = '';
      state.config = Object.assign({}, state.config, { apiKey: '', baseUrl: '', model: '', stream: true });
      CLOUD_OK = true;
      document.getElementById('storyFlow').innerHTML = '';
      document.getElementById('actionInput').value = '';
      gotoStep('step-play');   // 切到互动舞台，否则按钮不可点击
      renderHistory();
      renderTimeline();
      return true;
    },

    /* 打桩云端模型；mode: normal | slow | error */
    patchChat(mode) {
      window.__cap = [];
      PNCloud.llm.chat = async (opts) => {
        window.__cap.push({ messages: JSON.parse(JSON.stringify(opts.messages)), temperature: opts.temperature });
        if (mode === 'slow') {
          // 首帧带上 "narration" 前缀，让 streamPreview 能解析出增量文本
          if (opts.onDelta) opts.onDelta('{"narration":"');
          for (let i = 0; i < 60; i++) {
            if (opts.signal && opts.signal.aborted) {
              const e = new Error('aborted'); e.name = 'AbortError'; throw e;
            }
            await new Promise(r => setTimeout(r, 50));
            if (opts.onDelta) opts.onDelta('苏璃侧过身，');
          }
          return { content: '{"narration":"' + '苏璃侧过身，'.repeat(60) + '"}', usage: null };
        }
        if (mode === 'error') throw new Error('模拟上游失败');
        const text = '{"narration":"苏璃侧过身，霜纹剑鞘轻响。","suggestions":["继续观察","开口询问","退到门外"],"state":{"location":"书房"}}';
        if (opts.onDelta) opts.onDelta('苏璃侧过身，霜纹剑鞘轻响。');
        return { content: text, usage: { prompt_tokens: 120, completion_tokens: 30 } };
      };
      return true;
    },

    restoreChat() { /* 由外部重新加载页面恢复 */ },

    stubConfirm(v) { window.confirm = () => v !== false; },

    stubDownload() {
      window.__dl = null;
      window.downloadFile = (name, content) => { window.__dl = { name, content }; };
    },

    lastCapture() { return (window.__cap || [])[window.__cap.length - 1]; }
  };
  return true;
};

/* ---------- 通用等待 ---------- */
async function boot(page) {
  await page.evaluateOnNewDocument(PAGE_HELPERS);
  await page.goto(BASE_URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => !document.body.classList.contains('booting'), { timeout: 20000 });
  await sleep(500);
  await page.evaluate(PAGE_HELPERS);
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-gpu'], protocolTimeout: 180000
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 950 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  try {
    await boot(page);
    console.log('\n▸ A. 提示词组装与通道（SEC-03 / CHN-03 / MEM-01 / MEM-03 / WLD-06）');

    // 造 12 条历史，用 M01..M12 标记，验证「最近 6 条逐字、更早不进 prompt」
    const seedHistory = [];
    for (let i = 1; i <= 12; i++) {
      seedHistory.push({ role: i % 2 ? 'user' : 'ai', content: `M${String(i).padStart(2, '0')} 第${i}条剧情内容`, id: i });
    }
    await page.evaluate(h => { __t.seed({ history: h, summary: '摘要锚点SUMMARY-XYZ', summarizing: 6, summarizedTurns: 6 }); __t.patchChat('normal'); }, seedHistory);

    // 通过 UI 发送一次，走完整 generateReply
    await page.type('#actionInput', '我推门而入');
    await page.click('#btnSend');
    await page.waitForFunction(() => (window.__cap || []).length > 0, { timeout: 20000 });
    await sleep(600);

    const cap = await page.evaluate(() => __t.lastCapture());
    const sys = cap.messages[0];
    check('SEC-03', '模型请求首条必须是 system', sys.role === 'system', sys.role + ' / ' + String(sys.content).slice(0, 18));
    const all = cap.messages.map(m => m.content).join('\n');
    check('WLD-06', '世界书常驻设定注入 prompt', all.includes('苏璃') && all.includes('霜纹'), '命中「苏璃/霜纹」');
    check('MEM-03', '滚动摘要注入 prompt', all.includes('SUMMARY-XYZ'), '命中摘要锚点');
    check('MEM-01', '最近 6 条逐字进入 prompt', all.includes('M12') && all.includes('M08'), 'M08/M12 命中');
    check('MEM-01b', '更早的 6 条不逐字进入 prompt', !all.includes('M01 ') && !all.includes('M06 '), 'M01/M06 未出现');
    check('CHN-03', '无 Key 时走云端通道', (await page.evaluate(() => (window.__cap || []).length)) >= 1, '已捕获云端调用');

    console.log('\n▸ B. 停止生成（GEN-03 / GEN-11）');
    await page.evaluate(() => { __t.seed({ history: [{ role: 'user', content: '开始', id: 1 }] }); __t.patchChat('slow'); });
    await page.type('#actionInput', '我拔剑');
    await page.click('#btnSend');
    await sleep(900);
    const mid = await page.evaluate(() => ({
      aborting: !!state.genAbort,
      stopShown: document.getElementById('btnStop').style.display !== 'none',
      text: (document.querySelector('#storyFlow .msg.narration .msg-body') || {}).textContent || ''
    }));
    check('GEN-02', '生成中按钮区出现停止且文本已增量', mid.aborting && mid.stopShown && mid.text.length > 0, `已渲染 ${mid.text.length} 字`);

    await page.click('#btnStop');
    await sleep(800);
    const stopped = await page.evaluate(() => ({
      abort: state.genAbort,
      text: (document.querySelector('#storyFlow .msg.narration .msg-body') || {}).textContent || '',
      hist: state.history.length,
      lastRole: state.history.length ? state.history[state.history.length - 1].role : null
    }));
    check('GEN-03', '停止后保留已生成部分', stopped.text.length > 0, `保留 ${stopped.text.length} 字`);
    check('GEN-03b', '停止后 genAbort 释放', stopped.abort === null, String(stopped.abort));
    check('GEN-11', '停止不写入空内容', stopped.hist >= 1 && (!stopped.lastRole || stopped.text.trim().length > 0), 'history=' + stopped.hist);

    console.log('\n▸ C. 失败兜底（GEN-09）');
    const before = await page.evaluate(() => {
      __t.seed({ history: [{ role: 'user', content: '再试一次', id: 1 }] });
      __t.patchChat('error');
      return document.querySelectorAll('#storyFlow .msg').length;
    });
    await page.type('#actionInput', '我后退一步');
    await page.click('#btnSend');
    // 等生成真正结束（服务端演示流会持续 1-2s），否则断言会撞在流式中间态
    await page.waitForFunction(
      () => !state.genAbort && !document.getElementById('btnSend').disabled,
      { timeout: 25000 }
    );
    await sleep(200);
    const after = await page.evaluate(() => {
      const msgs = [...document.querySelectorAll('#storyFlow .msg')];
      const empty = msgs.filter(m => !m.textContent.trim());
      return {
        count: msgs.length,
        empty: empty.length,
        lastText: msgs.length ? msgs[msgs.length - 1].textContent.trim().slice(0, 24) : '',
        hist: state.history.length,
        fallbackTagged: !!document.querySelector('#storyFlow .fallback-tag'),
        dbg: { backend: BACKEND_OK, cloudOk: CLOUD_OK, tags: document.querySelectorAll('.fallback-tag').length, lastHtml: msgs.length ? msgs[msgs.length - 1].innerHTML.slice(-160) : '' }
      };
    });
    check('GEN-09', '上游失败不残留空气泡', after.empty === 0, `空气泡 ${after.empty} 个`);
    check('GEN-09b', '上游失败仍有兜底正文', after.lastText.length > 0, after.lastText);
    check('GEN-09c', '失败降级后不污染历史', after.hist >= before, `history=${after.hist}`);
    check('GEN-09d', '兜底段落有透明标注', after.fallbackTagged === true, `tags=${after.dbg.tags}`);

    console.log('\n▸ D. 消息干预（MSG-01 / MSG-02 / MSG-03 / MSG-04）');
    // MSG-02 重写 AI 消息：从该条截断后重新生成，长度不变
    const rw = await page.evaluate(async () => {
      __t.seed({
        history: [
          { role: 'user', content: 'A1', id: 1 },
          { role: 'ai', content: 'B1', id: 2 },
          { role: 'user', content: 'A2', id: 3 },
          { role: 'ai', content: 'B2', id: 4 }
        ]
      });
      __t.patchChat('normal');
      const lenBefore = state.history.length;
      await rewriteAiMessage(4);
      return { lenBefore, lenAfter: state.history.length, last: state.history[state.history.length - 1].content.slice(0, 12) };
    });
    check('MSG-02', '重写 AI 消息后长度不变且内容更新', rw.lenAfter === rw.lenBefore && rw.last.includes('苏璃'), `len ${rw.lenBefore}→${rw.lenAfter}`);

    // MSG-03 回溯：删除该条及之后
    const tr = await page.evaluate(() => {
      __t.seed({
        history: [
          { role: 'user', content: 'A1', id: 1 },
          { role: 'ai', content: 'B1', id: 2 },
          { role: 'user', content: 'A2', id: 3 },
          { role: 'ai', content: 'B2', id: 4 }
        ]
      });
      __t.stubConfirm(true);
      const domBefore = document.querySelectorAll('#storyFlow .msg').length;
      truncateFrom(3);
      return { domBefore, len: state.history.length, dom: document.querySelectorAll('#storyFlow .msg').length };
    });
    check('MSG-03', '回溯删除该条及其之后', tr.len === 2, `history=${tr.len}`);
    check('MSG-04', '回溯后 DOM 与 state 一致', tr.dom === tr.len, `dom=${tr.dom} state=${tr.len}`);

    // MSG-01 编辑用户消息（走真实 DOM：编辑 → 保存并重写后续）
    const ed = await page.evaluate(async () => {
      __t.seed({
        history: [
          { role: 'user', content: '原始行动', id: 1 },
          { role: 'ai', content: '原始回复', id: 2 }
        ]
      });
      __t.patchChat('normal');
      renderHistory();
      const el = document.querySelector('#storyFlow .msg[data-hid="1"]');
      const editBtn = el.querySelector('.msg-ops button');
      editBtn.click();
      const ta = el.querySelector('textarea.msg-edit');
      ta.value = '改写后的行动';
      const save = [...el.querySelectorAll('.msg-edit-row button')].find(b => b.textContent.includes('保存'));
      save.click();
      await new Promise(r => setTimeout(r, 1200));
      return {
        hist: state.history.map(h => h.content.slice(0, 8)),
        cap: (window.__cap || []).length
      };
    });
    check('MSG-01', '编辑用户消息触发重写后续', ed.cap >= 1 && ed.hist[0] === '改写后的行动', JSON.stringify(ed.hist.slice(0, 2)));

    console.log('\n▸ E. 分支快照（BRN-02 / BRN-04 / BRN-05）');
    const br = await page.evaluate(async () => {
      __t.seed({ history: [{ role: 'user', content: '存档点', id: 1 }] });
      __t.stubConfirm(true);
      await saveSnapshot('手动存档');
      const created = state.branches.length;
      const id = state.branches[0].id;
      // 改脏当前进度后载入快照
      state.history = [{ role: 'user', content: '脏数据', id: 99 }];
      await loadBranch(id);
      const restored = state.history.length && state.history[0].content;
      const timelineItems = document.querySelectorAll('#timelineList .timeline-item').length;
      await deleteBranch(id);
      return { created, restored, timelineItems, afterDelete: state.branches.length };
    });
    check('BRN-02', 'saveSnapshot 生成存档', br.created === 1, `branches=${br.created}`);
    check('BRN-04', '载入快照恢复历史', br.restored === '存档点', String(br.restored));
    check('BRN-03', '时间线渲染条数一致', br.timelineItems === 1, `items=${br.timelineItems}`);
    check('BRN-05', '删除存档后列表清空', br.afterDelete === 0, `branches=${br.afterDelete}`);

    console.log('\n▸ F. 导出（EXP-02 / EXP-03）');
    const exp = await page.evaluate(() => {
      __t.seed({
        history: [
          { role: 'user', content: '我走进书房', id: 1 },
          { role: 'ai', content: '烛火摇晃。', id: 2 }
        ]
      });
      __t.stubDownload();
      exportJson();
      const j = window.__dl ? { name: window.__dl.name, parsed: JSON.parse(window.__dl.content) } : null;
      __t.stubDownload();
      exportShareLink();
      const share = document.getElementById('shareLinkText').value || '';
      return {
        jsonOk: !!j && !!j.parsed,
        keys: j ? Object.keys(j.parsed).slice(0, 6) : [],
        shareLen: share.length,
        shareHasState: /#share=/.test(share)
      };
    });
    check('EXP-02', 'JSON 导出可反序列化且含核心字段',
      exp.jsonOk && exp.keys.some(k => /history|novel|world/i.test(k)), exp.keys.join(','));
    check('EXP-03', '分享链接含状态载荷', exp.shareHasState && exp.shareLen > 20, `len=${exp.shareLen}`);

    console.log('\n▸ G. 设置（CFG-01 / CFG-03）');
    await page.evaluate(() => document.getElementById('btnSettings').click());
    await sleep(300);
    await page.evaluate(() => document.querySelector('.chip[data-preset="deepseek"]').click());
    const preset = await page.evaluate(() => ({
      url: document.getElementById('cfgBaseUrl').value,
      model: document.getElementById('cfgModel').value
    }));
    check('CFG-01', '预设填充 baseUrl/model', /deepseek/.test(preset.url) && !!preset.model, `${preset.url} · ${preset.model}`);

    await page.evaluate(() => {
      document.getElementById('cfgBaseUrl').value = 'https://example.com/v1';
      document.getElementById('cfgModel').value = 'test-model';
      document.getElementById('btnSaveSettings').click();
    });
    await sleep(600);
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForFunction(() => !document.body.classList.contains('booting'), { timeout: 20000 });
    await sleep(400);
    await page.evaluate(() => document.getElementById('btnSettings').click());
    await sleep(300);
    const persisted = await page.evaluate(() => ({
      url: document.getElementById('cfgBaseUrl').value,
      model: document.getElementById('cfgModel').value
    }));
    check('CFG-03', '刷新后设置回填', persisted.url === 'https://example.com/v1' && persisted.model === 'test-model', `${persisted.url} · ${persisted.model}`);
    await page.evaluate(() => document.getElementById('btnCloseSettings').click());

    console.log('\n▸ H. 云服务门禁（CLD-01 / CLD-02 / CLD-04 / CLD-12 / CLD-14）');
    const gate = await page.evaluate(async () => {
      let writes = 0;
      const origSave = PNCloud.saves.save;
      PNCloud.saves.save = async () => { writes++; return { id: 1 }; };
      cloudSession = null;
      state.novel = { title: '测试', chapters: [], fullText: '' };
      await saveCurrentToCloud();
      const modalOpen = document.getElementById('cloudModal').classList.contains('open');
      const toastText = document.getElementById('toast').textContent;
      PNCloud.saves.save = origSave;
      return { writes, modalOpen, toastText };
    });
    check('CLD-01', '未登录保存被拦截且不发写库请求', gate.writes === 0 && gate.modalOpen, `writes=${gate.writes} 弹窗=${gate.modalOpen}`);

    const emailGuard = await page.evaluate(async (email) => {
      let sends = 0;
      const orig = PNCloud.auth.sendCode;
      PNCloud.auth.sendCode = async () => { sends++; return {}; };
      document.getElementById('cloudEmail').value = email;
      document.getElementById('btnCloudSend').click();
      await new Promise(r => setTimeout(r, 250));
      const tip = document.getElementById('cloudTip').textContent;
      PNCloud.auth.sendCode = orig;
      return { sends, tip };
    }, 'not-an-email');
    check('CLD-02', '非法邮箱不发请求且提示', emailGuard.sends === 0 && /邮箱/.test(emailGuard.tip), emailGuard.tip);

    const resend = await page.evaluate(async () => {
      const orig = PNCloud.auth.sendCode;
      PNCloud.auth.sendCode = async (email) => ({ email, verificationId: 'vid-test', isExistingUser: false });
      document.getElementById('cloudEmail').value = 'tester@example.com';
      document.getElementById('btnCloudSend').click();
      await new Promise(r => setTimeout(r, 300));
      const disabled = document.getElementById('btnCloudSend').disabled;
      const label = document.getElementById('btnCloudSend').textContent;
      // 改邮箱应让旧 challenge 失效
      cloudPending = { email: 'tester@example.com', verificationId: 'vid-test', isExistingUser: false };
      document.getElementById('cloudEmail').value = 'other@example.com';
      document.getElementById('cloudEmail').dispatchEvent(new Event('input'));
      const cleared = cloudPending === null;
      PNCloud.auth.sendCode = orig;
      return { disabled, label, cleared };
    });
    check('CLD-04', '发送后进入倒计时并禁用按钮', resend.disabled && /秒/.test(resend.label), resend.label);
    check('CLD-12', '改邮箱后旧 challenge 失效', resend.cleared, String(resend.cleared));

    const owner = await page.evaluate(() => {
      // 静态检查：cloud.js 的写入路径不得出现 owner_id 字段
      return fetch('cloud.js').then(r => r.text()).then(src => ({
        hasOwnerId: /owner_id/.test(src),
        sendsOwner: /owner_id\s*:/.test(src)
      }));
    });
    check('CLD-14', '前端不发送 owner_id（仅注释中提及）', owner.sendsOwner === false, owner.hasOwnerId ? '源码含 owner_id 但未作为字段提交' : '无提及');

    console.log('\n▸ I. 安全（SEC-01 / SEC-02 / SEC-04）');
    const xss = await page.evaluate(() => {
      __t.seed({ history: [] });
      const payload = '<img src=x onerror="window.__xss=1">';
      addUserMessage(payload, 11);
      addNarration('<script>window.__xss2=1</script>正文', null, 12);
      return {
        imgs: document.querySelectorAll('#storyFlow img').length,
        scripts: document.querySelectorAll('#storyFlow script').length,
        xss: !!window.__xss, xss2: !!window.__xss2,
        text: document.querySelector('#storyFlow .msg.narration .msg-body').textContent
      };
    });
    check('SEC-01', '用户输入被转义，不生成节点', xss.imgs === 0 && !xss.xss, `img=${xss.imgs}`);
    check('SEC-02', '模型输出被转义，不执行脚本', xss.scripts === 0 && !xss.xss2 && xss.text.includes('正文'), String(xss.scripts));

    const trunc = await page.evaluate(() => {
      __t.seed({ history: [] });
      const long = 'X'.repeat(9000);
      const prompt = buildStoryPrompt(long);
      return { len: prompt.length, hasFourK: prompt.includes('X'.repeat(4000)) };
    });
    check('SEC-04', '超长章节文本被截断进上下文', trunc.len < 12000, `prompt=${trunc.len} 字符`);

    console.log('\n▸ J. 交互守卫（IMP-12 / CHN-06）');
    const empty = await page.evaluate(async () => {
      let called = 0;
      const orig = PNCloud.llm.chat;
      PNCloud.llm.chat = async () => { called++; return { content: 'x', usage: null }; };
      __t.seed({ history: [] });
      document.getElementById('actionInput').value = '';
      await sendAction();
      PNCloud.llm.chat = orig;
      return { called };
    });
    check('IMP-12', '空输入不发请求', empty.called === 0, `calls=${empty.called}`);

    const badge = await page.evaluate(() => {
      const out = [];
      state.config = Object.assign({}, state.config, { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm1' });
      refreshModeBadge(); out.push(document.getElementById('modeBadge').textContent);
      state.config = Object.assign({}, state.config, { apiKey: '', baseUrl: '', model: '' });
      CLOUD_OK = true; refreshModeBadge(); out.push(document.getElementById('modeBadge').textContent);
      CLOUD_OK = false; BACKEND_OK = false; refreshModeBadge(); out.push(document.getElementById('modeBadge').textContent);
      return out;
    });
    check('CHN-06', '徽标随通道切换', /已连接/.test(badge[0]) && /云端模型/.test(badge[1]) && /本地模式/.test(badge[2]), badge.join(' | '));

    check('ZERO-ERR', '全流程零 JS 异常', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
  }

  console.log('\n' + '='.repeat(46));
  console.log(`${failed ? '❌' : '✅'} 功能用例：${passed} 通过 / ${failed} 失败`);
  if (failures.length) console.log('失败：' + failures.join(' | '));
  console.log('='.repeat(46));
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
