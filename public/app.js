/* ============================================================
 * Playable Novel Engine · 前端核心逻辑
 * 流程：上传小说 → AI 推演世界卡片 → 选择入口/角色 → 自由互动
 * 存储：localStorage（配置 + 进度），无服务端状态
 * ============================================================ */

/* ---------------- 全局状态 ---------------- */
const state = {
  config: {},               // { baseUrl, apiKey, model, useMock, stream, imageProvider... }
  novel: null,              // { title, chapters[], fullText }
  world: null,              // AI 推演的世界卡片（Markdown 文本）
  characters: [],           // 提取的人物 [{ name, desc }]
  selectedRole: null,       // 当前扮演身份
  entryChapter: 0,          // 入口章节 id
  history: [],              // [{ id, role, content, suggestions, state?, canonWarn? }]
  events: [],               // 已触发事件摘要
  turn: 0,
  playing: false,
  rollingSummary: '',       // 分层记忆：滚动摘要（故事至今）
  summarizedTurns: 0,       // 已被摘要覆盖的轮数
  usage: { promptTokens: 0, completionTokens: 0, calls: 0 }, // 成本统计
  genAbort: null,           // 当前生成的 AbortController
  worldbook: [],            // P1-5 世界书条目 [{ id, type, name, content, mode, keywords, enabled }]
  charState: null,          // P1-8 角色状态 { location, present[], relations{}, items[], foreshadowing[] }
  factList: '',             // P1-6 Canon Guard 原著事实清单
  lastFactTurn: 0,          // 上次生成事实清单的轮次
  lastCanonCheck: 0,        // 上次冲突检测的轮次
  branchId: null,          // P1-7 当前分支 id
  sourceLang: null,        // P2-13 检测到的原著语言 { code, label, ratio }
  outputLang: 'auto'       // P2-13 输出语言（auto = 跟随原著）
};

/* 后端可用性：null=未探测 true=可用 false=纯本地模式（无 Node 后端） */
let BACKEND_OK = null;

/* 云服务状态：null=未探测 true=可用 false=不可用（离线 / SDK 未加载） */
let CLOUD_OK = null;
/* 云端会话：登录后为 session 对象 */
let cloudSession = null;

const $ = id => document.getElementById(id);

/* ---------------- 初始化 ---------------- */
document.addEventListener('DOMContentLoaded', async () => {
  await DB.migrateFromLocalStorage();
  state.config = (await DB.get(PN_STORE.config, 'main')) || {};
  detectBackend();
  bindUpload();
  bindSettings();
  bindWorld();
  bindChapters();
  bindPlay();
  bindCloud();
  refreshModeBadge();
  await restoreProgress();
  await loadWorldbook();
  await loadBranches();
  loadStarCount();
});

/* 探测 Node 后端是否可用（本地 HTML 直用模式的关键判断） */
async function detectBackend() {
  if (location.protocol === 'file:') { BACKEND_OK = false; return; }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch('api/health', { signal: ctrl.signal });
    BACKEND_OK = r.ok;
    clearTimeout(timer);
  } catch { BACKEND_OK = false; }
  if (!BACKEND_OK && location.protocol !== 'file:') {
    // http(s) 但无后端：静态托管场景，同样进入本地模式
    console.info('[Playable Novel] 未检测到 Node 后端，进入本地直用模式（演示引擎 + 浏览器直连 API）');
  }
}

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ============================================================
 * 配置管理（BYOK）
 * ============================================================ */
function hasLiveKey() {
  return !!(state.config.baseUrl && state.config.apiKey && state.config.model);
}
async function saveConfig(cfg) {
  state.config = cfg;
  await DB.set(PN_STORE.config, 'main', cfg);
  refreshModeBadge();
}
function refreshModeBadge() {
  const badge = $('modeBadge');
  if (hasLiveKey()) {
    badge.textContent = (BACKEND_OK === false ? '本地直连 · ' : '已连接 ') + state.config.model;
    badge.className = 'mode-badge live';
  } else if (CLOUD_OK === true && cloudTrialEnabled() && cloudTrialLeft() > 0) {
    // 用户显式开启、且还有体验次数 → 明确标出「体验」与剩余次数（花的是应用额度）
    badge.textContent = '云端体验 · 剩 ' + cloudTrialLeft() + ' 次';
    badge.className = 'mode-badge live';
  } else if (BACKEND_OK === false) {
    badge.textContent = '本地模式';
    badge.className = 'mode-badge local';
  } else {
    badge.textContent = '演示模式';
    badge.className = 'mode-badge demo';
  }
}

/* ============================================================
 * 云服务：登录（邮箱验证码） + 云端存档 + 免密钥模型通道
 * ============================================================ */
let cloudPending = null;   // 发送验证码后保存的 challenge（提交时复用，绝不重新发码）

async function bindCloud() {
  if (!window.PNCloud) return;
  const st = await PNCloud.status();
  CLOUD_OK = st.ready;
  if (!CLOUD_OK) {
    markCloudDown(st.reason);
    return;
  }
  // 真正探一次数据面：模型列表取不到就视为不可用（例如非发布域名打开），
  // 这样后续生成不会每轮都弹一次失败提示。
  try {
    const models = await PNCloud.llm.listModels();
    if (!models.length) { markCloudDown('云端暂无可用模型'); return; }
    if (state.config.cloudModel) PNCloud.llm.setModel(state.config.cloudModel);
    await PNCloud.llm.pickModel();
    CLOUD_OK = true;
  } catch (e) {
    markCloudDown(e.message || '云服务数据面不可达');
    return;
  }

  $('btnCloud').onclick = () => openCloudModal();
  $('btnCloseCloud').onclick = () => $('cloudModal').classList.remove('open');
  $('cloudModal').onclick = e => { if (e.target.id === 'cloudModal') e.target.classList.remove('open'); };

  // 获取验证码：单独绑定，发送中与倒计时期间不发第二次
  $('btnCloudSend').onclick = async () => {
    const email = $('cloudEmail').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { cloudTip('请输入正确的邮箱地址', 'err'); return; }
    const btn = $('btnCloudSend');
    btn.disabled = true;
    try {
      cloudPending = await PNCloud.auth.sendCode(email);
      cloudTip('验证码已发送到该邮箱，请查收后填入。', 'ok');
      let left = 60;
      btn.textContent = left + ' 秒后重发';
      const timer = setInterval(() => {
        left -= 1;
        if (left <= 0) { clearInterval(timer); btn.textContent = '重发验证码'; btn.disabled = false; }
        else btn.textContent = left + ' 秒后重发';
      }, 1000);
    } catch (e) {
      cloudPending = null;
      cloudTip(e.message || '验证码发送失败', 'err');
      btn.disabled = false;
    }
  };

  // 登录 / 注册：复用已保存的 challenge，只提交验证码
  $('btnCloudSubmit').onclick = async () => {
    if (!cloudPending) { cloudTip('请先点击「获取验证码」', 'err'); return; }
    const token = $('cloudCode').value.trim();
    if (!token) { cloudTip('请输入验证码', 'err'); return; }
    $('btnCloudSubmit').disabled = true;
    try {
      await PNCloud.auth.verifyCode(cloudPending, token);
      cloudPending = null;
      $('cloudCode').value = '';
      cloudTip('登录成功', 'ok');
      await refreshCloudSession();
      $('cloudModal').classList.remove('open');
      toast('已登录 · 云端存档与免密钥模型已就绪');
    } catch (e) {
      cloudTip(e.message || '登录失败，请检查验证码', 'err');
    } finally {
      $('btnCloudSubmit').disabled = false;
    }
  };

  $('btnCloudSignOut').onclick = async () => {
    await PNCloud.auth.signOut();
    cloudSession = null;
    renderCloudButton();
    renderCloudSaves([]);
    cloudTip('已退出登录', 'ok');
  };

  $('btnCloudSave').onclick = () => saveCurrentToCloud();
  $('cloudEmail').oninput = () => { if (cloudPending && cloudPending.email !== $('cloudEmail').value.trim()) cloudPending = null; };

  await refreshCloudSession();
}

/* 云服务置为不可用：按钮给出原因，后续生成直接走本地通道，不反复报错 */
function markCloudDown(reason) {
  CLOUD_OK = false;
  console.info('[Playable Novel] 云服务不可用：' + reason + '（已回退本地模式）');
  const btn = $('btnCloud');
  if (btn) { btn.textContent = '云服务未连接'; btn.title = reason; btn.disabled = true; }
  renderCloudSaves([]);
  refreshModeBadge();
}

function cloudTip(msg, kind) {
  const el = $('cloudTip');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'cloud-tip' + (kind ? ' ' + kind : '');
}

function openCloudModal() {
  cloudTip('', '');
  $('cloudModal').classList.add('open');
  if (cloudSession) {
    const u = cloudSession.user || {};
    cloudTip('当前已登录：' + (u.name || '已登录用户'), 'ok');
  }
}

async function refreshCloudSession() {
  if (!window.PNCloud || CLOUD_OK !== true) return;
  cloudSession = await PNCloud.auth.getSession();
  renderCloudButton();
  if (cloudSession) {
    try { renderCloudSaves(await PNCloud.saves.list()); }
    catch (e) { $('cloudSavesMeta').textContent = ''; renderCloudSaves([]); console.warn('[cloud] list failed:', e.message); }
  } else {
    renderCloudSaves([]);
  }
  refreshModeBadge();
}

function renderCloudButton() {
  const btn = $('btnCloud');
  if (!btn) return;
  if (cloudSession) {
    const u = cloudSession.user || {};
    btn.textContent = u.name || '已登录';
    btn.classList.add('signed');
    btn.title = '点击管理云端登录与存档';
    $('btnCloudSignOut').hidden = false;
  } else {
    btn.textContent = '云端登录';
    btn.classList.remove('signed');
    if ($('btnCloudSignOut')) $('btnCloudSignOut').hidden = true;
  }
}

function renderCloudSaves(rows) {
  const box = $('cloudSavesList');
  const meta = $('cloudSavesMeta');
  if (!box) return;
  if (!cloudSession) { meta.textContent = '未登录'; box.innerHTML = '<div class="side-empty">登录后可把进度同步到云端</div>'; return; }
  meta.textContent = rows.length ? rows.length + ' 条' : '空';
  if (!rows.length) { box.innerHTML = '<div class="side-empty">还没有云端存档</div>'; return; }
  box.innerHTML = '';
  rows.forEach(r => {
    const el = document.createElement('div');
    el.className = 'cloud-save-item';
    const title = document.createElement('span');
    title.className = 'cs-title';
    title.textContent = r.novel_title;
    const meta2 = document.createElement('span');
    meta2.className = 'cs-meta';
    meta2.textContent = '第 ' + ((r.chapter_index || 0) + 1) + ' 章 · ' + new Date(r.created_at).toLocaleDateString();
    const del = document.createElement('span');
    del.className = 'cs-del';
    del.textContent = '✕';
    del.title = '删除这条云端存档';
    del.onclick = async e => {
      e.stopPropagation();
      try {
        const ok = await PNCloud.saves.remove(r.id);
        toast(ok ? '已删除云端存档' : '删除失败：该存档可能不存在或不属于当前账号');
        renderCloudSaves(await PNCloud.saves.list());
      } catch (err) { toast(err.message || '删除失败'); }
    };
    el.appendChild(title); el.appendChild(meta2); el.appendChild(del);
    box.appendChild(el);
  });
}

/* 把当前进度（章节 + 历史 + 世界书 + 分支）存到云端 */
async function saveCurrentToCloud() {
  if (!window.PNCloud || CLOUD_OK !== true) { toast('云服务未连接：当前处于离线状态或 SDK 未加载'); return; }
  if (!cloudSession) { toast('请先登录，再同步到云端'); openCloudModal(); return; }
  if (!state.novel) { toast('还没有加载小说，先上传或粘贴一本'); return; }
  try {
    await PNCloud.saves.save({
      novelTitle: state.novel.title || '未命名小说',
      chapterIndex: state.entryChapter || 0,
      payload: {
        chapters: (state.novel.chapters || []).map(c => ({ title: c.title, preview: (c.content || '').slice(0, 200) })),
        history: (state.history || []).slice(-20),
        worldbook: state.worldbook || [],
        branchId: state.branchId || null,
        savedAt: new Date().toISOString()
      }
    });
    toast('已同步到云端');
    renderCloudSaves(await PNCloud.saves.list());
  } catch (e) {
    toast(e.message || '云端同步失败');
    if (e.needLogin) { cloudSession = null; renderCloudButton(); openCloudModal(); }
  }
}

function bindSettings() {
  $('btnSettings').onclick = () => {
    $('cfgBaseUrl').value = state.config.baseUrl || '';
    $('cfgApiKey').value = state.config.apiKey || '';
    $('cfgModel').value = state.config.model || '';
    $('cfgUseMock').checked = state.config.useMock !== false;
    if ($('cfgCloudTrial')) $('cfgCloudTrial').checked = state.config.cloudTrial === true;
    $('cfgStream').checked = state.config.stream !== false;
    $('cfgImageKey').value = state.config.imageApiKey || '';
    const curImg = state.config.imageProvider || 'none';
    document.querySelectorAll('.chip[data-img]').forEach(x => x.classList.toggle('active', x.dataset.img === curImg));
    $('localModeTip').style.display = BACKEND_OK === false ? '' : 'none';
    $('settingsModal').classList.add('open');
  };
  fillCloudModelOptions();
  $('btnCloseSettings').onclick = () => $('settingsModal').classList.remove('open');
  $('settingsModal').onclick = e => { if (e.target.id === 'settingsModal') e.target.classList.remove('open'); };

  // 预设
  const presets = {
    openai:  { baseUrl: 'https://api.openai.com/v1',      model: 'gpt-4o-mini' },
    deepseek:{ baseUrl: 'https://api.deepseek.com/v1',    model: 'deepseek-chat' },
    qwen:    { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    kimi:    { baseUrl: 'https://api.moonshot.cn/v1',     model: 'moonshot-v1-8k' },
    ollama:  { baseUrl: 'http://localhost:11434/v1',      model: 'qwen2.5:7b' }
  };
  document.querySelectorAll('.chip[data-preset]').forEach(btn => {
    btn.onclick = () => {
      const p = presets[btn.dataset.preset];
      $('cfgBaseUrl').value = p.baseUrl;
      $('cfgModel').value = p.model;
      if (btn.dataset.preset === 'ollama') $('cfgApiKey').value = 'ollama';
    };
  });

  // 图像预设
  document.querySelectorAll('.chip[data-img]').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.chip[data-img]').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      $('cfgImageKey').placeholder = btn.dataset.img === 'pollinations' || btn.dataset.img === 'sdlocal'
        ? '无需 Key'
        : '图像 API Key';
    };
  });

  // P2-13 输出语言选择
  const curLang = state.outputLang || 'auto';
  document.querySelectorAll('.chip[data-lang]').forEach(x => {
    x.classList.toggle('active', x.dataset.lang === curLang);
    x.onclick = () => {
      document.querySelectorAll('.chip[data-lang]').forEach(y => y.classList.remove('active'));
      x.classList.add('active');
      state.outputLang = x.dataset.lang;
      updateLangHint();
    };
  });

  $('btnSaveSettings').onclick = async () => {
    await saveConfig({
      baseUrl: $('cfgBaseUrl').value.trim(),
      apiKey: $('cfgApiKey').value.trim(),
      model: $('cfgModel').value.trim(),
      useMock: $('cfgUseMock').checked,
      stream: $('cfgStream').checked,
      /* 云端通道：默认关闭；开关状态与所选模型必须一起持久化 */
      cloudTrial: !!($('cfgCloudTrial') && $('cfgCloudTrial').checked),
      cloudModel: state.config.cloudModel || '',
      imageProvider: (document.querySelector('.chip[data-img].active') || {}).dataset ? (document.querySelector('.chip[data-img].active') || {}).dataset.img : 'none',
      imageApiKey: $('cfgImageKey').value.trim(),
      outputLang: (document.querySelector('.chip[data-lang].active') || {}).dataset
        ? (document.querySelector('.chip[data-lang].active') || {}).dataset.lang
        : (state.outputLang || 'auto')
    });
    $('settingsModal').classList.remove('open');
    toast(hasLiveKey()
      ? '已连接你自己的 API Key，开始你的故事吧'
      : (cloudTrialEnabled() ? '已开启云端体验（消耗应用额度，剩 ' + cloudTrialLeft() + ' 次）' : '已保存：未填 Key 时使用本地演示模式'));
  };
  $('btnClearSettings').onclick = async () => {
    await DB.clear(PN_STORE.config);
    state.config = {};
    refreshModeBadge();
    $('settingsModal').classList.remove('open');
    toast('已清除配置，回到演示模式');
  };
}

/* ============================================================
 * 步骤 1：上传与解析
 * ============================================================ */
function bindUpload() {
  const dz = $('dropzone');
  const fi = $('fileInput');

  dz.onclick = () => fi.click();
  fi.onchange = e => { if (e.target.files[0]) readFile(e.target.files[0]); };
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('dragover'); }));
  dz.addEventListener('drop', e => {
    const f = e.dataTransfer.files[0];
    if (f) readFile(f);
  });

  $('btnParse').onclick = () => {
    const text = $('pasteArea').value.trim();
    if (text.length < 50) return toast('请先粘贴小说全文或上传文件（至少 50 字）');
    parseNovel(text);
  };
  $('btnSample').onclick = () => parseNovel(SAMPLE_NOVEL, true);

  // P2-11：角色卡导入入口
  const cardBtn = $('btnCharacterCard');
  const cardInput = $('cardInput');
  if (cardBtn && cardInput) {
    cardBtn.onclick = () => cardInput.click();
    cardInput.onchange = e => { if (e.target.files[0]) importCharacterCardFile(e.target.files[0]); };
  }
}

/* P2-12/13：按扩展名分派 TXT / EPUB / PDF；P2-11：PNG 走角色卡通道 */
async function readFile(file) {
  if (!file) return;
  if (file.size > 24 * 1024 * 1024) return toast('文件过大，请控制在 24MB 以内');
  const name = (file.name || '').toLowerCase();
  const isEpub = name.endsWith('.epub');
  const isPdf = name.endsWith('.pdf') || file.type === 'application/pdf';
  const isPng = name.endsWith('.png') || file.type === 'image/png';

  // PNG：交给角色卡导入
  if (isPng) return importCharacterCardFile(file);

  // 文本类
  if (!isEpub && !isPdf) {
    const reader = new FileReader();
    reader.onload = () => parseNovel(String(reader.result || ''));
    reader.onerror = () => toast('文件读取失败');
    return reader.readAsText(file, 'utf-8');
  }

  // EPUB / PDF：读为 ArrayBuffer 后交给前端解析器
  // P2-12 EPUB / P2-13：解析器带回书名（EPUB 来自 OPF metadata，比首行更准确）
  toast(isEpub ? '📘 正在解析 EPUB…' : '📕 正在解析 PDF…');
  const buf = await file.arrayBuffer();
  try {
    const r = isEpub ? await PNParser.parseEpub(buf) : await PNParser.parsePdf(buf);
    if (!r.text || r.text.trim().length < 50) throw new Error('正文内容过少，可能不是可解析的文件');
    toast(`✅ 已从${isEpub ? 'EPUB' : 'PDF'}提取 ${r.text.length.toLocaleString()} 字，正在切分章节…`);
    parseNovel(r.text, false, r.title);
  } catch (e) {
    toast('解析失败：' + e.message);
  }
}

/* P2-11：SillyTavern 角色卡（PNG）→ 世界书条目 */
async function importCharacterCardFile(file) {
  toast('正在读取角色卡…');
  try {
    const buf = await file.arrayBuffer();
    const card = PNParser.parseCharacterCardPNG(buf);
    if (!card) {
      return toast('这不是有效的角色卡 PNG（未找到 SillyTavern 内嵌数据）');
    }
    // 写入世界书（追加，不覆盖已有条目）
    const entries = PNParser.characterCardToWorldbook(card).map((e, i) => ({
      id: 'cc' + Date.now() + '_' + i,
      type: e.type,
      name: e.name,
      content: e.content,
      mode: e.type === 'character' ? 'always' : 'keyword',
      keywords: e.type === 'character' ? [] : [e.name.replace(/ · .+$/, '')],
      enabled: true,
      source: 'character-card'
    }));
    state.worldbook = state.worldbook.concat(entries);
    await saveWorldbook();
    renderWorldbookList();
    renderSideWorld();

    // 同步侧边栏元信息
    const meta = $('worldbookMeta');
    if (meta) meta.textContent = `${state.worldbook.length} 条`;

    toast(`✅ 已导入角色卡「${card.name}」，生成 ${entries.length} 条世界书设定`);
    // 打开世界书弹窗让用户确认
    openWorldbookModal();
    if (card.firstMes) {
      setTimeout(() => toast(`💡 「${card.name}」的开场白已作为设定导入，可在世界书里查看`), 2200);
    }
  } catch (e) {
    toast('角色卡导入失败：' + e.message);
  }
}

async function parseNovel(text, isSample = false, metaTitle = null) {
  toast('正在解析章节结构……');
  let data;
  // 优先走后端；无后端（file:// 本地直用）时自动降级到前端引擎
  if (BACKEND_OK === false) {
    try {
      const r = MockEngine.splitNovel(text);
      data = Object.assign({}, r, { fullText: text });
    } catch (e) {
      return toast('解析失败：' + e.message);
    }
  } else {
    try {
      const resp = await fetch('/api/novel/split', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      data = await resp.json();
    } catch (e) {
      // 后端不可用 → 永久降级本地模式
      BACKEND_OK = false;
      refreshModeBadge();
      try {
        const r = MockEngine.splitNovel(text);
        data = Object.assign({}, r, { fullText: text });
      } catch (e2) {
        return toast('解析失败：' + e2.message);
      }
    }
  }

  state.novel = {
    title: isSample ? '星海学院的转学生（内置示例）' : (metaTitle || data.title),
    chapters: data.chapters,
    fullText: data.fullText || text
  };

  // P2-13 语言自适应：检测原著语言
  state.sourceLang = PNParser.detectLanguage(state.novel.fullText);
  updateLangHint();

  renderSideWorld();
  gotoStep('step-world');
  toast(`✅ 解析完成：共 ${data.totalChapters} 章 / ${(data.totalChars || 0).toLocaleString()} 字 · 原著语言：${state.sourceLang.label}`);
  analyzeWorld();
}

/* P2-13：语言设置提示 */
function updateLangHint() {
  const hint = $('langHint');
  if (!hint) return;
  const src = state.sourceLang ? state.sourceLang.label : '未知';
  const out = (PNParser.OUTPUT_LANGS.find(l => l.code === state.outputLang) || {}).label || '跟随原著';
  hint.textContent = state.outputLang === 'auto'
    ? `已识别原著语言：${src} · 剧情将以${src}续写`
    : `原著：${src} · 剧情将以「${out}」叙述（跨语言扮演）`;
}

/** 语言约束（注入 prompt） */
function langInstruction() {
  return PNParser.languageInstruction(state.sourceLang && state.sourceLang.code, state.outputLang || 'auto');
}

/* ============================================================
 * 步骤 2：AI 推演世界卡片
 * ============================================================ */
function bindWorld() {
  $('btnReanalyze').onclick = analyzeWorld;
  $('btnGoChapters').onclick = () => { renderChapterPicker(); gotoStep('step-chapters'); };
}

/* GitHub Star 实时计数（失败静默，不影响主流程） */
async function loadStarCount() {
  const el = $('starCount');
  if (!el) return;
  // 先展示上次缓存值（离线也有数字）
  try {
    const cached = localStorage.getItem('pn-star-count');
    if (cached) { el.textContent = cached; }
  } catch {}
  try {
    const r = await fetch('https://api.github.com/repos/StarlitSKy88/playable-novel');
    if (!r.ok) return;
    const d = await r.json();
    if (typeof d.stargazers_count === 'number') {
      el.textContent = d.stargazers_count;
      el.title = `${d.stargazers_count} 人点了 Star`;
      try { localStorage.setItem('pn-star-count', String(d.stargazers_count)); } catch {}
    }
  } catch { /* 离线或超限时保持占位 */ }
}

async function analyzeWorld() {
  const card = $('worldCard');
  card.classList.add('loading');
  card.innerHTML = `<span class="typing"><i></i><i></i><i></i></span><span>${state.playing || hasLiveKey() ? 'AI 正在推演世界设定……' : '演示模式推演中……'}</span>`;
  gotoStep('step-world');

  const novel = state.novel;
  // 取样：开头 + 中部 + 结尾，各取一段
  const sample = [
    novel.fullText.slice(0, 3000),
    novel.fullText.slice(Math.floor(novel.fullText.length / 2), Math.floor(novel.fullText.length / 2) + 1500),
    novel.fullText.slice(-1500)
  ].join('\n……\n');

  const prompt =
`你是小说世界的架构师。请阅读下面的小说片段，用简体中文输出一份「世界卡片」，严格按以下格式：

## 世界名称
（给这个世界起个名字，4-10 字）

## 世界观
（3-5 句话概括时代背景、力量体系/核心规则、氛围）

## 核心人物
（列出 3-5 个角色，每行格式：- 名字｜身份｜性格｜与主角的关系）

## 主角
（主角名字与核心处境，一句话）

## 故事风格
（如：热血奇幻 / 言情治愈 / 悬疑权谋……）

## 当前暗流
（2-3 句：此刻世界表面之下正在酝酿的冲突或悬念）

小说片段：
"""${sample}"""`;

  let content;
  // 演示模式没有真实 LLM 可用，直接用本地推演的世界卡片（narrate 通道会返回剧情 JSON，不适用）
  if (!hasLiveKey()) {
    content = demoWorldCard(novel);
  } else {
    try {
      const r = await callAI([
        { role: 'system', content: '你是一位专业的世界观架构师，擅长从小说文本中提炼设定。' },
        { role: 'user', content: prompt }
      ], 0.5, 900);
      content = r.content;
      addUsage(r.usage);
    } catch (e) {
      content = null;
      toast('AI 推演失败：' + e.message);
    }
  }

  if (!content) {
    // 兜底世界卡片
    content = demoWorldCard(novel);
  }

  state.world = content;
  state.characters = extractCharacters(content);
  card.classList.remove('loading');
  card.textContent = content;
  renderSideWorld();
  saveProgress();
}

function extractCharacters(md) {
  const chars = [];
  const re = /^-\s*([^｜|]+)[｜|](.+)$/gm;
  let m;
  while ((m = re.exec(md)) !== null) {
    chars.push({ name: m[1].trim(), desc: m[2].trim() });
  }
  return chars.slice(0, 5);
}

/* ============================================================
 * 步骤 3：章节与角色选择
 * ============================================================ */
function renderChapterPicker() {
  // 角色选项
  const box = $('roleOptions');
  box.innerHTML = '';
  const protagonist = guessProtagonist();
  const roles = [
    { name: protagonist || '主角', desc: '沿用原著命运线' },
    ...state.characters.filter(c => c.name !== protagonist).map(c => ({ name: c.name, desc: c.desc.slice(0, 30) })),
    { name: '旁观者', desc: '以路人视角见证故事' }
  ];
  roles.forEach((r, i) => {
    const el = document.createElement('div');
    el.className = 'role-opt' + (i === 0 ? ' selected' : '');
    el.innerHTML = `<b>${escapeHtml(r.name)}</b><small>${escapeHtml(r.desc)}</small>`;
    el.onclick = () => {
      document.querySelectorAll('.role-opt').forEach(x => x.classList.remove('selected'));
      el.classList.add('selected');
      state.selectedRole = r.name;
    };
    box.appendChild(el);
  });
  state.selectedRole = state.selectedRole || roles[0].name;

  $('btnCustomRole').onclick = () => {
    const name = $('customRoleName').value.trim();
    if (!name) return toast('请输入自定义身份');
    document.querySelectorAll('.role-opt').forEach(x => x.classList.remove('selected'));
    state.selectedRole = name;
    toast(`已切换身份：${name}`);
  };

  // 章节列表
  const list = $('chapterList');
  list.innerHTML = '';
  state.novel.chapters.forEach(ch => {
    const el = document.createElement('div');
    el.className = 'chapter-item';
    el.innerHTML = `<h4>${escapeHtml(ch.title)}</h4><p>${escapeHtml(ch.preview)}</p>
      <div class="ch-meta">约 ${ch.length.toLocaleString()} 字 · 点击从此处进入故事</div>`;
    el.onclick = () => startStory(ch.id);
    list.appendChild(el);
  });
}

/* 步骤 3 的静态事件绑定（章节/角色列表由 renderChapterPicker 动态生成后自行绑定） */
function bindChapters() {
  // 自定义身份输入：回车即切换
  $('customRoleName').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); $('btnCustomRole').click(); }
  });
  // 章节列表为空时给出引导（正常流程不会走到这里）
  const list = $('chapterList');
  if (!list.children.length && state.novel) renderChapterPicker();
}

/* ============================================================
 * P1-8 角色状态面板
 * ============================================================ */
function renderStatePanel() {
  const el = $('sideState');
  const meta = $('stateMeta');
  const s = state.charState;
  if (!s) {
    el.className = 'side-empty';
    el.textContent = '尚未开始 · 进入故事后展示位置/关系/物品';
    meta.textContent = '';
    return;
  }
  el.className = 'state-panel';
  const rel = Object.entries(s.relations || {}).filter(([, v]) => v);
  const rows = [];
  rows.push(`<div class="state-row"><span class="state-k">📍 位置</span>${escapeHtml(s.location || '未知')}</div>`);
  if ((s.present || []).length) rows.push(`<div class="state-row"><span class="state-k">👥 在场</span>${escapeHtml(s.present.join('、'))}</div>`);
  if ((s.items || []).length) rows.push(`<div class="state-row"><span class="state-k">🎒 物品</span>${escapeHtml(s.items.join('、'))}</div>`);
  if (rel.length) {
    rows.push(`<div class="state-row"><span class="state-k">💞 关系</span><div class="state-rels">${rel
      .map(([k, v]) => `<span class="state-rel"><b>${escapeHtml(k)}</b>${escapeHtml(String(v))}</span>`).join('')}</div></div>`);
  }
  if ((s.foreshadowing || []).length) rows.push(`<div class="state-row"><span class="state-k">❓ 伏笔</span>${escapeHtml(s.foreshadowing.join('；'))}</div>`);
  el.innerHTML = rows.join('');
  meta.textContent = s.mood || '';
}

function guessProtagonist() {
  if (!state.world) return '主角';
  const m = state.world.match(/## 主角\s*\n(.+)/);
  if (m) {
    const nameMatch = m[1].match(/^([一-龥A-Za-z]{2,8})/);
    return nameMatch ? nameMatch[1] : '主角';
  }
  return '主角';
}

/* ============================================================
 * 步骤 4：互动舞台
 * ============================================================ */
/* ============================================================
 * P0 记忆分层常量：最近 VERBATIM_KEEP 条逐字进 prompt，
 * 更早的每积累 SUMMARY_BATCH 条压缩进「故事至今」摘要
 * ============================================================ */
const VERBATIM_KEEP = 6;
const SUMMARY_BATCH = 6;
let _hidSeq = 1;
function nextHid() { return _hidSeq++; }

function bindPlay() {
  $('btnSend').onclick = sendAction;
  $('actionInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAction(); }
  });
  $('btnRestart').onclick = () => {
    if (state.genAbort) return toast('正在生成中，请先停止或等待完成');
    if (!confirm('确定重开本局？当前剧情进度将被清除（世界书与历史存档保留）。')) return;
    resetPlayState();
    gotoStep('step-chapters');
    toast('已重开，重新选择入口吧');
  };
  $('btnEnding').onclick = generateEnding;
  $('btnStop').onclick = stopGeneration;
  // P1 新按钮
  $('btnWorldbook').onclick = openWorldbookModal;
  $('btnWorldbookSide').onclick = openWorldbookModal;
  $('btnCloseWorldbook').onclick = () => $('worldbookModal').classList.remove('open');
  $('worldbookModal').onclick = e => { if (e.target.id === 'worldbookModal') e.target.classList.remove('open'); };
  $('btnWbAutoExtract').onclick = autoExtractWorldbook;
  $('btnWbAdd').onclick = wbAddFromForm;
  $('btnExport').onclick = () => $('exportModal').classList.add('open');
  $('btnCloseExport').onclick = () => $('exportModal').classList.remove('open');
  $('exportModal').onclick = e => { if (e.target.id === 'exportModal') e.target.classList.remove('open'); };
  $('btnExportMd').onclick = exportMarkdown;
  $('btnExportJson').onclick = exportJson;
  $('btnExportShare').onclick = exportShareLink;
}

function resetPlayState() {
  state.history = []; state.events = []; state.turn = 0; state.playing = false;
  state.rollingSummary = ''; state.summarizedTurns = 0;
  $('storyFlow').innerHTML = '';
  $('suggestions').innerHTML = '';
  renderSideProgress(); renderMemoryPanel(); saveProgress();
}

function stopGeneration() {
  if (state.genAbort) { state.genAbort.abort(); toast('已停止生成'); }
}

function setGenerating(on) {
  $('btnStop').style.display = on ? '' : 'none';
  $('btnSend').disabled = on;
  $('btnEnding').disabled = on;
  $('actionInput').disabled = on;
}

async function startStory(chapterId) {
  state.entryChapter = chapterId;
  state.history = [];
  state.events = [];
  state.turn = 0;
  state.playing = true;
  state.rollingSummary = '';
  state.summarizedTurns = 0;
  _hidSeq = 1;

  const ch = state.novel.chapters.find(c => c.id === chapterId) || state.novel.chapters[0];
  $('playChapterTitle').textContent = ch.title;
  $('playRole').textContent = `身份：${state.selectedRole}`;
  $('storyFlow').innerHTML = '';
  $('suggestions').innerHTML = '';
  gotoStep('step-play');
  renderSideProgress(); renderMemoryPanel(); renderUsagePanel();
  saveProgress();

  addSystemNote(`你以「${state.selectedRole}」的身份，从「${ch.title}」踏入这个世界。`);

  // AI 生成开场：基于该章节原文 + 世界设定
  const chapterText = extractChapterText(chapterId);
  const openingHid = nextHid();
  const prompt = buildStoryPrompt(chapterText) +
`\n\n【开场任务】以「${state.selectedRole}」的视角，为这个故事写一个沉浸式开场（150-250字）：
描写你此刻身处何地、周遭正在发生什么、身体与情绪的直观感受。
严格遵循原著设定，第二人称「你」叙述。只输出正文，不要标题。`;

  const result = await runGeneration([
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: prompt }
  ], {
    temperature: 0.85, maxTokens: 500, mode: 'story',
    mockUserText: '',
    fallback: () => fallbackNarration(chapterText),
    hid: openingHid
  });

  if (result && result.content) {
    state.history.push({ role: 'ai', content: result.content, id: openingHid, suggestions: result.parsed ? result.parsed.suggestions : null });
    if (result.parsed && result.parsed.state) {
      state.charState = { ...(state.charState || {}), ...result.parsed.state };
      renderStatePanel();
    }
    state.turn = 1;
    renderSideProgress();
    saveProgress();
  }
}

function extractChapterText(chapterId) {
  // 从全文中按标题位置截取该章正文（截取到 6000 字以内供上下文使用）
  const full = state.novel.fullText;
  const ch = state.novel.chapters.find(c => c.id === chapterId);
  if (!ch) return full.slice(0, 4000);
  const idx = full.indexOf(ch.title);
  if (idx === -1) return ch.text;
  const nextCh = state.novel.chapters.find(c => c.id === chapterId + 1);
  const end = nextCh ? full.indexOf(nextCh.title) : full.length;
  return full.slice(idx, end === -1 ? idx + 6000 : end).slice(0, 6000);
}

async function sendAction() {
  const input = $('actionInput');
  const text = input.value.trim();
  if (!text) return;
  if (!state.playing) return toast('请先选择入口章节开始故事');
  if (state.genAbort) return toast('正在生成中，请稍候');
  input.value = '';
  state._lastUserInput = text;   // 供世界书关键词匹配

  state.history.push({ role: 'user', content: text, id: nextHid() });
  renderHistory();
  await generateReply();
}

/* 生成 AI 回复：组装分层上下文 → 统一生成入口 → 落库 → 触发记忆压缩 */
async function generateReply() {
  const chapterText = extractChapterText(state.entryChapter);
  const recent = state.history.slice(-VERBATIM_KEEP)
    .map(h => (h.role === 'user' ? `【你的行动】${h.content}` : `【剧情】${h.content}`)).join('\n');
  const lastUser = [...state.history].reverse().find(h => h.role === 'user');
  const actionText = lastUser ? lastUser.content : '（静观其变）';
  const replyHid = nextHid();

  const prompt = buildStoryPrompt(chapterText) +
`\n\n【身份】你正在扮演：${state.selectedRole}
【原著章节】${(state.novel.chapters.find(c => c.id === state.entryChapter) || {}).title || ''}

【目前为止的故事】
${recent}

【你刚刚的行动】
${actionText}

【任务】以「${state.selectedRole}」的视角续写剧情（120-250字）：
1. 世界与人物对这个行动的真实反应（符合原著人物性格）
2. 环境的变化与新信息的揭示
3. 自然引出下一个抉择点
严格遵循原著世界观，第二人称叙述。同时给出 3 个接下来的可选行动建议（JSON 输出）。`;

  const result = await runGeneration([
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: prompt }
  ], {
    temperature: 0.9, maxTokens: 600, mode: 'story',
    mockUserText: actionText,
    fallback: () => fallbackNarration(chapterText, actionText),
    hid: replyHid
  });

  if (result && result.content) {
    const aiMsg = { role: 'ai', content: result.content, id: replyHid, suggestions: result.parsed ? result.parsed.suggestions : null };
    // P1-8 角色状态
    if (result.parsed && result.parsed.state) {
      state.charState = { ...(state.charState || {}), ...result.parsed.state };
      renderStatePanel();
    }
    state.history.push(aiMsg);
    state.turn++;
    const summary = actionText.slice(0, 24);
    if (summary && !state.events.includes(summary)) state.events.push(summary);
    renderSideProgress();
    await maybeSummarize();
    maybeUpdateFacts();
    await maybeAutoSnapshot();
    // P1-6 Canon Guard 冲突检测（异步，不阻塞阅读）
    checkCanonConflict(result.content).then(reason => {
      if (reason) markCanonWarning(aiMsg.id, reason);
    });
    // P1-9 场景插画（异步，配置后启用）
    if (state.config.imageProvider && state.config.imageProvider !== 'none') {
      genSceneImage(result.content, $('storyFlow').querySelector(`[data-hid="${aiMsg.id}"]`));
    }
    saveProgress();
  }
}
async function generateEnding() {
  if (!state.playing) return toast('先开始一段故事吧');
  if (state.genAbort) return toast('正在生成中，请稍候');
  const recent = state.history.slice(-10).map(h => (h.role === 'user' ? `【你的行动】${h.content}` : `【剧情】${h.content}`)).join('\n');
  addSystemNote('—— 本局结局 ——');
  const endingHid = nextHid();
  const result = await runGeneration([
    { role: 'system', content: '你是这个故事的地下城主，现在为这段旅程画上句点。' },
    { role: 'user', content: `基于以下互动故事线，为「${state.selectedRole}」写一个结局（150-300字）：
呼应开头、收束本作的关键伏笔，第二人称叙述，可留一个余韵悠长的收尾。

${recent}` }
  ], { temperature: 0.9, maxTokens: 500, mode: 'plain', hid: endingHid });

  if (result && result.content) {
    state.history.push({ role: 'ai', content: result.content, id: endingHid });
    state.playing = false;
    saveProgress();
  }
}

/* ============================================================
 * 统一生成入口：流式 / 非流式 · 真实 / 演示 · usage 回写
 * opts: { temperature, maxTokens, mode:'story'|'plain', mockUserText, fallback }
 * 返回 { content, parsed } 或 null（完全失败）
 * ============================================================ */
async function runGeneration(messages, opts = {}) {
  const { temperature = 0.8, maxTokens = 800, mode = 'story', mockUserText = '', fallback = null, hid = null } = opts;
  const useStream = state.config.stream !== false;

  state.genAbort = new AbortController();
  setGenerating(true);

  let buffer = '';
  let usage = null;
  let msgEl = null, bodyEl = null;
  /* 通道降级标注：真实模型不可达、最终由本地引擎顶上时必须让用户知道 */
  let degradedNote = '';

  const bindHid = el => { if (hid != null) el.dataset.hid = hid; return el; };

  const finalize = () => {
    const parsed = mode === 'story' ? tryParseJson(buffer) : null;
    let narration = buffer;
    if (parsed) narration = parsed.narration;
    else if (mode === 'story' && buffer.trim().startsWith('{')) {
      // JSON 解析失败的兜底：提取引号内长文本
      const m = buffer.match(/"([^"]{40,})"/);
      if (m) narration = m[1];
    }
    if (msgEl && bodyEl) {
      renderFinalMessage(msgEl, bodyEl, narration, parsed ? parsed.suggestions : null, mode);
      if (degradedNote) {
        const tag = document.createElement('div');
        tag.className = 'fallback-tag';
        tag.textContent = degradedNote;
        msgEl.appendChild(tag);
      }
    }
    if (usage) addUsage(usage);
    scrollBottom();
    return { content: narration, parsed };
  };

  try {
    if (!useStream) {
      // ---- 非流式：整体等待后一次渲染 ----
      showTyping();
      const r = await callAI(messages, temperature, maxTokens, 'narrate', mockUserText);
      hideTyping();
      buffer = r.content || '';
      usage = r.usage || null;
      const m = createStoryMessage();
      msgEl = bindHid(m.el); bodyEl = m.body;
      return finalize();
    }

    // ---- 流式：SSE 增量渲染 ----
    const m = createStoryMessage();
    msgEl = bindHid(m.el); bodyEl = m.body;
    renderStreamText(bodyEl, '', true);

    // 云端免密钥模型：没填自己的 Key 时优先走真实大模型（真流式）
    if (cloudStreamAvailable()) {
      try {
        const r = await PNCloud.llm.chat({
          messages, temperature, maxTokens,
          signal: state.genAbort.signal,
          onDelta: d => {
            buffer += d;
            renderStreamText(bodyEl, mode === 'story' ? streamPreview(buffer) : buffer, true);
          }
        });
        if (r && r.content) buffer = r.content;
        usage = r && r.usage ? {
          prompt_tokens: r.usage.prompt_tokens || 0,
          completion_tokens: r.usage.completion_tokens || 0,
          cloud: true
        } : null;
        CLOUD_OK = true;
        bumpCloudTrial();   // 一次成功调用 = 消耗一次应用额度
        return finalize();
      } catch (e) {
        if (e && e.name === 'AbortError') {
          return buffer ? finalize() : (msgEl && msgEl.remove(), null);
        }
        CLOUD_OK = false;
        refreshModeBadge();
        degradedNote = '云端模型不可达 · 本段由本地演示引擎生成';
        toast('云端模型不可用：' + (e.message || '未知错误') + '，已回退演示模式');
        // 继续往下走本地演示通道，不静默失败
      }
    }

    // 本地模式（无 Node 后端）：本地生成 + 前端分片假流式
    if (BACKEND_OK === false) {
      let r;
      if (hasLiveKey()) {
        r = await directCallAI(messages, temperature, maxTokens);
      } else {
        await sleep(300 + Math.random() * 400);
        r = localMock('narrate', mockUserText);
      }
      buffer = r.content || '';
      usage = r.usage || null;
      const step = 3;
      for (let i = 0; i < buffer.length; i += step) {
        if (state.genAbort && state.genAbort.signal.aborted) break;
        renderStreamText(bodyEl, mode === 'story' ? streamPreview(buffer.slice(0, i + step)) : buffer.slice(0, i + step), true);
        await sleep(16);
      }
      return finalize();
    }

    const resp = await fetch('/api/ai/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: state.config.baseUrl,
        apiKey: state.config.apiKey,
        model: state.config.model,
        messages, temperature, maxTokens,
        mock: !hasLiveKey(),
        mockBody: buildMockBody('narrate', mockUserText)
      }),
      signal: state.genAbort.signal
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let sseBuf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuf += decoder.decode(value, { stream: true });
      const frames = sseBuf.split('\n\n');
      sseBuf = frames.pop() || '';
      for (const frame of frames) {
        if (!frame.startsWith('data:')) continue;
        let payload;
        try { payload = JSON.parse(frame.slice(5).trim()); } catch { continue; }
        if (payload.error) throw new Error(payload.error);
        if (payload.delta) {
          buffer += payload.delta;
          renderStreamText(bodyEl, mode === 'story' ? streamPreview(buffer) : buffer, true);
        }
        if (payload.done) {
          if (typeof payload.content === 'string' && payload.content) buffer = payload.content;
          usage = payload.usage || null;
        }
      }
    }
    return finalize();
  } catch (e) {
    const aborted = e.name === 'AbortError';
    hideTyping();
    if (aborted) {
      // 用户主动停止：保留已生成部分
      return buffer ? finalize() : (msgEl && msgEl.remove(), null);
    }
    // 真实失败：移除半成品，尝试演示兜底
    if (msgEl) msgEl.remove();
    if (fallback) {
      const fb = fallback();
      const m2 = createStoryMessage();
      bindHid(m2.el);
      renderFinalMessage(m2.el, m2.body, fb, null, mode);
      // 透明标注：这段不是模型写的，避免用户误以为是 AI 输出
      const tag = document.createElement('div');
      tag.className = 'fallback-tag';
      tag.textContent = '模型无响应 · 本段由本地兜底生成';
      m2.el.appendChild(tag);
      return { content: fb, parsed: null };
    }
    toast('生成失败：' + e.message + (hasLiveKey() ? '（可检查 API Key 或切换到演示模式）' : ''));
    return null;
  } finally {
    hideTyping();
    setGenerating(false);
    state.genAbort = null;
  }
}

/* ============================================================
 * P0-1 分层记忆：滚动摘要
 * ============================================================ */
function maybeSummarize() {
  const verbatimStart = Math.max(state.summarizedTurns, state.history.length - VERBATIM_KEEP);
  const pending = state.history.slice(state.summarizedTurns, verbatimStart);
  if (pending.length < SUMMARY_BATCH) return null;
  return summarizeNow(pending);
}

async function summarizeNow(pending) {
  const toCompress = pending.map(h => (h.role === 'user' ? `【你的行动】${h.content}` : `【剧情】${h.content}`)).join('\n');
  const prompt = `你是互动故事的史官。请把以下早期剧情压缩成一段连贯的「故事至今」摘要（150-250字）：
要求：保留关键事件、人物关系变化、已揭示的信息与伏笔；按时间顺序；第二人称「你」的视角。
${state.rollingSummary ? `\n【此前的摘要】\n${state.rollingSummary}\n\n【需要合并的新剧情】\n${toCompress}` : `\n【剧情】\n${toCompress}`}
只输出摘要正文，不要标题和解释。`;

  try {
    toast('记忆体压缩中…', 1500);
    const r = await callAI([
      { role: 'system', content: '你是互动故事的历史记录者，负责把剧情压缩为连贯摘要。' },
      { role: 'user', content: prompt }
    ], 0.3, 500, 'summarize');
    state.rollingSummary = r.content;
    state.summarizedTurns = Math.max(0, state.history.length - VERBATIM_KEEP);
    renderMemoryPanel();
  } catch (e) {
    console.warn('记忆压缩失败（不影响剧情继续）:', e.message);
  }
}

/* ============================================================
 * P0-3 消息干预：编辑 / 重写 / 删除回溯
 * ============================================================ */
function renderHistory() {
  const flow = $('storyFlow');
  flow.innerHTML = '';
  state.history.forEach(h => {
    if (h.role === 'user') addUserMessage(h.content, h.id);
    else addNarration(h.content, h.suggestions, h.id, h.canonWarn);
  });
  scrollBottom();
}

function truncateFrom(hid) {
  const idx = state.history.findIndex(h => h.id === Number(hid));
  if (idx < 0) return;
  if (state.genAbort) return toast('正在生成中，请先停止');
  if (!confirm('将删除此条及其后的全部剧情，确定回溯？')) return;
  state.history = state.history.slice(0, idx);
  state.summarizedTurns = Math.min(state.summarizedTurns, state.history.length);
  renderHistory(); renderMemoryPanel(); saveProgress();
  toast('已回溯到该节点');
}

async function rewriteAiMessage(hid) {
  if (state.genAbort) return toast('正在生成中，请稍候');
  const idx = state.history.findIndex(h => h.id === Number(hid));
  if (idx < 0) return;
  state.history = state.history.slice(0, idx);
  state.summarizedTurns = Math.min(state.summarizedTurns, state.history.length);
  renderHistory();
  await generateReply();
}

function editUserMessage(el) {
  if (state.genAbort) return toast('正在生成中，请稍候');
  const hid = Number(el.dataset.hid);
  const h = state.history.find(x => x.id === hid);
  if (!h) return;
  el.innerHTML = '';
  const ta = document.createElement('textarea');
  ta.className = 'msg-edit';
  ta.value = h.content;
  const row = document.createElement('div');
  row.className = 'msg-edit-row';
  const ok = document.createElement('button');
  ok.className = 'btn small primary'; ok.textContent = '保存并重写后续';
  const cancel = document.createElement('button');
  cancel.className = 'btn small ghost'; cancel.textContent = '取消';
  row.append(cancel, ok);
  el.append(ta, row);
  ta.focus();
  cancel.onclick = () => renderHistory();
  ok.onclick = async () => {
    const val = ta.value.trim();
    if (!val) return toast('内容不能为空');
    const idx = state.history.findIndex(x => x.id === hid);
    state.history = state.history.slice(0, idx);
    state.history.push({ role: 'user', content: val, id: hid });
    state.summarizedTurns = Math.min(state.summarizedTurns, state.history.length);
    renderHistory(); renderMemoryPanel();
    await generateReply();
  };
}

/* ============================================================
 * P0-4 成本统计
 * ============================================================ */
const PRICE_TABLE = [
  { match: /gpt-4o-mini/i,          in: 0.15, out: 0.60 },
  { match: /gpt-4\.1-mini/i,        in: 0.10, out: 0.40 },
  { match: /gpt-4o(?!-mini)/i,      in: 2.50, out: 10.0 },
  { match: /gpt-4\.1(?!-mini)/i,    in: 2.00, out: 8.00 },
  { match: /o[34]-mini/i,           in: 1.10, out: 4.40 },
  { match: /deepseek/i,             in: 0.14, out: 0.28 },
  { match: /qwen-plus/i,            in: 0.80, out: 2.00 },
  { match: /qwen-turbo/i,           in: 0.30, out: 0.60 },
  { match: /qwen/i,                 in: 0.40, out: 1.20 },
  { match: /moonshot|kimi/i,        in: 0.60, out: 2.00 },
  { match: /claude/i,               in: 3.00, out: 15.0 },
  { match: /glm/i,                  in: 0.10, out: 0.10 },
  { match: /ernie/i,                in: 0.08, out: 0.20 },
  { match: /hunyuan/i,              in: 0.10, out: 0.30 }
];

function addUsage(usage) {
  if (!usage) return;
  state.usage.promptTokens += usage.prompt_tokens || 0;
  state.usage.completionTokens += usage.completion_tokens || 0;
  state.usage.calls += 1;
  renderUsagePanel();
}

function renderUsagePanel() {
  const el = $('sideUsage');
  const u = state.usage;
  const isMock = !hasLiveKey();
  if (!u.calls) {
    el.className = 'side-empty';
    el.textContent = '尚未产生调用';
    return;
  }
  el.className = '';
  const price = PRICE_TABLE.find(p => p.match.test(state.config.model || ''));
  let costLine = '<div class="usage-note">当前模型暂无公开价格数据，仅统计 tokens</div>';
  if (price) {
    const usd = (u.promptTokens / 1e6 * price.in) + (u.completionTokens / 1e6 * price.out);
    costLine = `<div class="usage-row"><span>估算费用</span><b>$${usd.toFixed(4)}</b></div>
      <div class="usage-note">≈ ¥${(usd * 7.2).toFixed(3)} · 按 ${escapeHtml(state.config.model)} 公开价${isMock ? '（演示估算）' : ''}估算</div>`;
  } else if (isMock) {
    costLine = '<div class="usage-note">演示模式：数据为本地模拟，仅作展示</div>';
  }
  el.innerHTML = `
    <div class="usage-row"><span>调用次数</span><b>${u.calls}</b></div>
    <div class="usage-row"><span>输入 tokens</span><b>${u.promptTokens.toLocaleString()}</b></div>
    <div class="usage-row"><span>输出 tokens</span><b>${u.completionTokens.toLocaleString()}</b></div>
    ${costLine}`;
}

function renderMemoryPanel() {
  const el = $('sideMemory');
  const meta = $('memoryMeta');
  const total = state.history.length;
  if (!total) {
    el.className = 'side-empty';
    el.textContent = '尚无摘要 · 近期对话将逐字保留';
    meta.textContent = '';
    return;
  }
  el.className = '';
  const covered = Math.min(state.summarizedTurns, total);
  const pct = total ? Math.round(covered / total * 100) : 0;
  const bar = `<div class="mem-bar"><i style="width:${pct}%"></i></div>`;
  if (state.rollingSummary) {
    el.innerHTML = `<span class="mem-latest">${escapeHtml(state.rollingSummary.slice(0, 400))}${state.rollingSummary.length > 400 ? '…' : ''}</span>
      ${bar}<div class="mem-meta">已压缩 ${covered}/${total} 条对话 · 最近 ${Math.min(VERBATIM_KEEP, total)} 条逐字保留</div>`;
  } else {
    el.innerHTML = `<div class="mem-meta">尚无摘要 · 最近 ${Math.min(VERBATIM_KEEP, total)} 条对话逐字保留中（旧对话累计 ${SUMMARY_BATCH} 条后自动压缩）</div>${bar}`;
  }
  meta.textContent = covered ? `${pct}%` : '';
}

/* ---------------- 提示词构造 ---------------- */
/* P2-13：系统提示词随输出语言动态生成 */
function buildSystemPrompt() {
  const lang = state.outputLang || 'auto';
  const src = state.sourceLang ? state.sourceLang.code : 'zh';
  // 非中文输出时给出对应语言的规则说明（JSON 键名保持不变，避免解析失败）
  const i18n = {
    zh: '使用第二人称「你」叙述玩家视角。',
    en: 'Narrate in English, addressing the player as "you" in second person.',
    ja: '日本語でナレーションし、二人称の「あなた」を使って語ってください。',
    ko: '한국어로 서술하고, 2인칭「당신」을 사용해 주세요.'
  };
  const personRule = (lang !== 'auto' && i18n[lang]) ? i18n[lang]
    : (src === 'en' ? i18n.en : src === 'ja' ? i18n.ja : src === 'ko' ? i18n.ko : i18n.zh);

  return `你是一部互动小说的「地下城主」（DM）。你的职责是基于原著设定，实时续写玩家行动之后的剧情。
铁律：
1. 严格遵循给定的世界观、人物性格与人物关系，不得 OOC（角色崩坏）
2. ${personRule}
3. 文风贴合原著风格，注重画面感与情绪
4. 玩家的行动必须有真实后果：世界会记住、人物会记住
5. 不得违背「世界书」锁定设定与「已确立事实」
6. 不要代替玩家做决定，只呈现世界的回应与新的局势
默认以 JSON 输出（键名固定为英文，不要翻译键名）：
{"narration":"剧情正文","suggestions":["建议1","建议2","建议3"],"mood":"当前氛围","state":{"location":"当前位置","present":["在场人物"],"relations":{"人物":"关系描述"},"items":["持有物品"],"foreshadowing":["未解伏笔"]}}`;
}

function buildStoryPrompt(chapterText) {
  const parts = [`【世界设定】\n${state.world || '（未推演）'}`];
  // P0-1 分层记忆：早期剧情以摘要形式注入
  if (state.rollingSummary) {
    parts.push(`【故事至今 · 早期剧情摘要】\n${state.rollingSummary}`);
  }
  // P1-5 世界书注入（常驻 + 关键词触发）
  const wbText = buildWorldbookInjection();
  if (wbText) parts.push(wbText);
  // P1-6 Canon Guard：已确立事实清单
  if (state.factList) {
    parts.push(`【已确立事实 · 不得违背】\n${state.factList}`);
  }
  // P2-13 语言自适应：输出语言约束
  if (state.sourceLang) {
    parts.push(langInstruction());
  }
  parts.push(`【原著参考（当前章节上下文）】\n${chapterText.slice(0, 4000)}`);
  return parts.join('\n\n');
}

/* ============================================================
 * P1-5 世界书（Lorebook）
 * ============================================================ */
const WB_TYPE_LABEL = { character: '人物', location: '地点', item: '物品', rule: '规则', foreshadow: '伏笔' };

async function loadWorldbook() {
  state.worldbook = (await DB.all(PN_STORE.worldbook)) || [];
  renderWorldbookPanel();
}
async function saveWorldbook() {
  // 全量覆盖式保存：先清空再写入（条目量小，简单可靠）
  await DB.clear(PN_STORE.worldbook);
  for (const e of state.worldbook) await DB.add(PN_STORE.worldbook, e);
  renderWorldbookPanel();
}

/* 从世界卡片自动提炼条目 */
async function autoExtractWorldbook() {
  if (!state.world) return toast('请先完成世界推演');
  const entries = [];
  const nameM = state.world.match(/## 世界名称\s*\n(.+)/);
  if (nameM) entries.push({ type: 'rule', name: nameM[1].trim(), content: `本世界观名称为「${nameM[1].trim()}」，一切设定以此为基准。`, mode: 'always', keywords: [], enabled: true, source: 'auto' });

  const loreM = state.world.match(/## 世界观\s*\n([\s\S]*?)(?=\n##|$)/);
  if (loreM) entries.push({ type: 'rule', name: '世界观总纲', content: loreM[1].trim().slice(0, 300), mode: 'always', keywords: [], enabled: true, source: 'auto' });

  const charSec = state.world.match(/## 核心人物\s*\n([\s\S]*?)(?=\n##|$)/);
  if (charSec) {
    charSec[1].split('\n').forEach(line => {
      const m = line.match(/^-\s*([^｜|]+)[｜|](.+)$/);
      if (m) entries.push({ type: 'character', name: m[1].trim(), content: m[2].trim(), mode: 'keyword', keywords: [m[1].trim()], enabled: true, source: 'auto' });
    });
  }
  const darkM = state.world.match(/## 当前暗流\s*\n([\s\S]*?)(?=\n##|$)/);
  if (darkM) entries.push({ type: 'foreshadow', name: '暗流伏笔', content: darkM[1].trim().slice(0, 300), mode: 'always', keywords: [], enabled: true, source: 'auto' });

  if (!entries.length) return toast('未能从世界卡片提炼出条目');
  // 去重：同名同类型跳过
  const exist = new Set(state.worldbook.map(e => e.type + '|' + e.name));
  let added = 0;
  for (const e of entries) {
    const key = e.type + '|' + e.name;
    if (exist.has(key)) continue;
    e.id = Date.now() + Math.floor(Math.random() * 10000);
    state.worldbook.push(e);
    added++;
  }
  await saveWorldbook();
  toast(added ? `已提炼 ${added} 条设定` : '条目已全部存在，无新增');
}

/* 生成注入文本：常驻 + 近期上下文命中关键词的触发条目 */
function buildWorldbookInjection() {
  const enabled = state.worldbook.filter(e => e.enabled !== false);
  if (!enabled.length) return '';
  const always = enabled.filter(e => e.mode === 'always');
  // 关键词匹配范围：最近 3 条对话 + 当前输入（由调用方传入的 mockUserText 之外，这里扫 history 尾部）
  const scanText = state.history.slice(-3).map(h => h.content).join(' ') + ' ' + (state._lastUserInput || '');
  const triggered = enabled.filter(e => e.mode === 'keyword' && (e.keywords || []).some(k => scanText.includes(k)));
  const fmt = e => `- [${WB_TYPE_LABEL[e.type] || '设定'}] ${e.name}：${e.content}`;
  const lines = [];
  if (always.length) lines.push('【常驻设定】', ...always.map(fmt));
  if (triggered.length) lines.push('【触发设定】', ...triggered.map(fmt));
  if (!lines.length) return '';
  return `【世界书 · 以下设定已被锁定，AI 不得违背】\n${lines.join('\n')}`;
}

function renderWorldbookPanel() {
  const el = $('sideWorldbook');
  const meta = $('worldbookMeta');
  if (!el) return;
  const n = state.worldbook.length;
  meta.textContent = n ? `${n} 条` : '';
  if (!n) {
    el.className = 'side-empty';
    el.textContent = '从世界卡片自动提炼，或手动添加设定条目';
    return;
  }
  el.className = 'wb-mini';
  el.innerHTML = state.worldbook.slice(0, 5).map(e =>
    `<div class="wb-mini-item"><span class="wb-tag wb-tag-${e.type}">${WB_TYPE_LABEL[e.type] || '设定'}</span>${escapeHtml(e.name)}${e.enabled === false ? ' <i>（停用）</i>' : ''}</div>`
  ).join('') + (n > 5 ? `<div class="wb-mini-more">…共 ${n} 条</div>` : '');
}

function openWorldbookModal() {
  renderWorldbookList();
  $('worldbookModal').classList.add('open');
}

function renderWorldbookList() {
  const list = $('wbList');
  $('wbCount').textContent = state.worldbook.length ? `共 ${state.worldbook.length} 条` : '';
  if (!state.worldbook.length) {
    list.innerHTML = '<div class="wb-empty">暂无条目 · 点击上方「自动提炼」或手动添加</div>';
    return;
  }
  list.innerHTML = '';
  state.worldbook.forEach(e => {
    const item = document.createElement('div');
    item.className = 'wb-item' + (e.enabled === false ? ' disabled' : '');
    item.innerHTML = `
      <div class="wb-item-head">
        <span class="wb-tag wb-tag-${e.type}">${WB_TYPE_LABEL[e.type] || '设定'}</span>
        <b>${escapeHtml(e.name)}</b>
        <span class="wb-mode">${e.mode === 'always' ? '常驻' : '触发'}</span>
        <span class="wb-item-ops">
          <button class="wb-op" data-act="toggle" title="${e.enabled === false ? '启用' : '停用'}">${e.enabled === false ? '▶' : '⏸'}</button>
          <button class="wb-op danger" data-act="del" title="删除">✕</button>
        </span>
      </div>
      <div class="wb-item-content">${escapeHtml(e.content)}</div>
      ${e.mode === 'keyword' && (e.keywords || []).length ? `<div class="wb-item-kw">触发词：${e.keywords.map(escapeHtml).join(' / ')}</div>` : ''}`;
    item.querySelector('[data-act="toggle"]').onclick = async () => {
      e.enabled = e.enabled === false ? true : false;
      await saveWorldbook(); renderWorldbookList();
    };
    item.querySelector('[data-act="del"]').onclick = async () => {
      state.worldbook = state.worldbook.filter(x => x.id !== e.id);
      await saveWorldbook(); renderWorldbookList();
    };
    list.appendChild(item);
  });
}

async function wbAddFromForm() {
  const name = $('wbNewName').value.trim();
  const content = $('wbNewContent').value.trim();
  if (!name || !content) return toast('名称和内容不能为空');
  const entry = {
    id: Date.now() + Math.floor(Math.random() * 10000),
    type: $('wbNewType').value,
    name, content,
    mode: $('wbNewMode').value,
    keywords: $('wbNewMode').value === 'keyword'
      ? $('wbNewKeywords').value.split(/[,，]/).map(s => s.trim()).filter(Boolean)
      : [],
    enabled: true,
    source: 'manual'
  };
  if (entry.mode === 'keyword' && !entry.keywords.length) entry.keywords = [name];
  state.worldbook.push(entry);
  await saveWorldbook(); renderWorldbookList();
  $('wbNewName').value = ''; $('wbNewContent').value = ''; $('wbNewKeywords').value = '';
  toast('✅ 已添加世界书条目');
}

/* ============================================================
 * P1-6 Canon Guard 原著一致性守护
 * 每 FACT_INTERVAL 轮生成「已确立事实清单」注入 prompt；
 * 每次生成后用轻量校验检测冲突，冲突段落标黄 + 一键重写/接受
 * ============================================================ */
const FACT_INTERVAL = 8;   // 事实清单更新间隔（轮）
const CHECK_INTERVAL = 4;  // 冲突检测间隔（轮）

function maybeUpdateFacts() {
  if (state.turn - state.lastFactTurn < FACT_INTERVAL) return null;
  state.lastFactTurn = state.turn;
  return updateFacts();
}

async function updateFacts() {
  const recent = state.history.slice(-FACT_INTERVAL * 2)
    .map(h => (h.role === 'user' ? `【你的行动】${h.content}` : `【剧情】${h.content}`)).join('\n');
  const prompt = `你是原著设定守护者。请从以下剧情中提取「已确立事实」清单（不超过 8 条）：
包括：已发生的关键事件、人物当前状态与关系、主角获得的物品、已揭示的秘密。
${state.factList ? `\n【此前清单】\n${state.factList}\n\n【新剧情】\n${recent}\n请合并更新（过时的事实要替换）。` : `\n【剧情】\n${recent}`}
每行一条，格式：- 事实内容。只输出清单。`;
  try {
    const r = await callAI([
      { role: 'system', content: '你是严谨的剧情事实记录员。' },
      { role: 'user', content: prompt }
    ], 0.2, 400, 'summarize');
    state.factList = r.content;
  } catch (e) { console.warn('事实清单更新失败:', e.message); }
}

/* 生成后校验：新剧情是否与已确立事实冲突 */
async function checkCanonConflict(narration) {
  if (!state.factList || !narration) return null;
  if (state.turn - state.lastCanonCheck < CHECK_INTERVAL) return null;
  state.lastCanonCheck = state.turn;
  const prompt = `【已确立事实】\n${state.factList}\n\n【新生成的剧情】\n${narration}\n\n请判断新剧情是否与已确立事实矛盾（如人物状态、已发生事件、持有物品、关系变化）。
只输出 JSON：{"conflict":true/false,"reason":"冲突说明（无冲突则空字符串）"}`;
  try {
    const r = await callAI([
      { role: 'system', content: '你是严格的逻辑校验员，只做矛盾检测，不做创作。' },
      { role: 'user', content: prompt }
    ], 0.1, 200);
    const m = (r.content || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]);
    return obj.conflict ? (obj.reason || '与已确立事实存在冲突') : null;
  } catch (e) { return null; }
}

/* ============================================================
 * P1-7 分支存档（简化版：时间线 + 快照）
 * ============================================================ */
async function loadBranches() {
  state.branches = (await DB.all(PN_STORE.saves)) || [];
  renderTimeline();
}
async function saveSnapshot(name) {
  const snap = {
    name: name || `第 ${state.turn} 回合`,
    createdAt: Date.now(),
    turn: state.turn,
    entryChapter: state.entryChapter,
    selectedRole: state.selectedRole,
    chapterTitle: (state.novel.chapters.find(c => c.id === state.entryChapter) || {}).title || '',
    snapshot: {
      history: state.history.slice(-40),
      rollingSummary: state.rollingSummary,
      summarizedTurns: state.summarizedTurns,
      events: state.events,
      factList: state.factList,
      charState: state.charState,
      turn: state.turn
    }
  };
  const id = await DB.add(PN_STORE.saves, snap);
  snap.id = id;
  state.branches.unshift(snap);
  renderTimeline();
  return snap;
}

/* 自动快照：每 AUTO_SNAPSHOT 轮一次 */
async function maybeAutoSnapshot() {
  if (state.turn > 0 && state.turn % AUTO_SNAPSHOT === 0) {
    const exist = state.branches.find(b => b.turn === state.turn);
    if (!exist) await saveSnapshot(`自动存档 · 第 ${state.turn} 回合`);
  }
}
const AUTO_SNAPSHOT = 5;

function renderTimeline() {
  const el = $('timelineList');
  if (!el) return;
  $('timelineMeta').textContent = state.branches.length ? `${state.branches.length} 个存档` : '';
  if (!state.branches.length) {
    el.innerHTML = '<div class="side-empty">尚无存档 · 剧情推进中自动创建快照</div>';
    return;
  }
  el.innerHTML = '';
  state.branches.slice(0, 12).forEach(b => {
    const item = document.createElement('div');
    item.className = 'timeline-item';
    const d = new Date(b.createdAt);
    const time = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    item.innerHTML = `${escapeHtml(b.name)}<small>${time} · ${escapeHtml(b.chapterTitle)} · ${b.snapshot.history.length} 条剧情</small>`;
    item.title = '点击读取此存档';
    item.onclick = () => loadBranch(b.id);
    el.appendChild(item);
  });
}

async function loadBranch(id) {
  const b = state.branches.find(x => x.id === id);
  if (!b) return;
  if (state.genAbort) return toast('正在生成中，请先停止');
  if (!confirm(`读取存档「${b.name}」？当前未保存的进度将被替换。`)) return;
  state.history = b.snapshot.history.map(h => ({ ...h, id: h.id || nextHid() }));
  _hidSeq = state.history.reduce((m, h) => Math.max(m, h.id || 0), 0) + 1;
  state.rollingSummary = b.snapshot.rollingSummary || '';
  state.summarizedTurns = b.snapshot.summarizedTurns || 0;
  state.events = b.snapshot.events || [];
  state.factList = b.snapshot.factList || '';
  state.charState = b.snapshot.charState || null;
  state.turn = b.snapshot.turn || 0;
  state.entryChapter = b.entryChapter;
  state.selectedRole = b.selectedRole;
  state.playing = true;
  const ch = state.novel.chapters.find(c => c.id === state.entryChapter);
  if (ch) $('playChapterTitle').textContent = ch.title;
  $('playRole').textContent = `身份：${state.selectedRole || '-'}`;
  gotoStep('step-play');
  renderHistory(); renderSideProgress(); renderMemoryPanel(); renderStatePanel();
  saveProgress();
  toast(`已读取存档：${b.name}`);
}

async function deleteBranch(id) {
  state.branches = state.branches.filter(x => x.id !== id);
  await DB.delete(PN_STORE.saves, id);
  renderTimeline();
}

/* ============================================================
 * P1-10 导出与分享
 * ============================================================ */
function exportMarkdown() {
  if (!state.novel) return toast('尚未加载小说');
  const lines = [];
  lines.push(`# ${state.novel.title || '未命名故事'} · 互动实录`);
  lines.push('');
  lines.push(`> 由 Playable Novel 可玩小说引擎生成 · ${new Date().toLocaleString('zh-CN')}`);
  lines.push(`> 身份：${state.selectedRole || '-'} · 入口：${(state.novel.chapters.find(c => c.id === state.entryChapter) || {}).title || '-'} · 回合数：${state.turn}`);
  lines.push('');
  if (state.world) { lines.push('## 世界卡片', '', state.world, ''); }
  if (state.factList) { lines.push('## 已确立事实', '', state.factList, ''); }
  lines.push('## 故事实录', '');
  state.history.forEach(h => {
    if (h.role === 'user') lines.push(`### 你的行动`, '', h.content, '');
    else lines.push(`### 剧情`, '', h.content, '');
  });
  if (state.charState) {
    lines.push('## 终局状态', '', `- 位置：${state.charState.location || '未知'}`);
    if ((state.charState.items || []).length) lines.push(`- 物品：${state.charState.items.join('、')}`);
    if ((state.charState.foreshadowing || []).length) lines.push(`- 未解伏笔：${state.charState.foreshadowing.join('；')}`);
  }
  downloadFile(`${state.novel.title || 'story'}-互动实录.md`, lines.join('\n'), 'text/markdown');
  toast('Markdown 故事书已导出');
}

function exportJson() {
  const data = {
    app: 'playable-novel', version: 1,
    exportedAt: new Date().toISOString(),
    novel: { title: state.novel.title, chapters: state.novel.chapters.map(c => ({ id: c.id, title: c.title, preview: c.preview })), fullText: state.novel.fullText },
    world: state.world,
    selectedRole: state.selectedRole,
    entryChapter: state.entryChapter,
    history: state.history,
    events: state.events,
    rollingSummary: state.rollingSummary,
    summarizedTurns: state.summarizedTurns,
    factList: state.factList,
    charState: state.charState,
    turn: state.turn,
    worldbook: state.worldbook,
    usage: state.usage
  };
  downloadFile(`${state.novel.title || 'story'}-存档.json`, JSON.stringify(data, null, 2), 'application/json');
  toast('🗃 JSON 存档已导出');
}

function exportShareLink() {
  if (!state.history.length) return toast('先开始一段故事再分享');
  // 轻量分享包：世界卡片 + 剧情 + 身份（不含原文全文，控制 URL 长度）
  const payload = {
    t: state.novel.title, w: (state.world || '').slice(0, 2000),
    r: state.selectedRole, c: (state.novel.chapters.find(c => c.id === state.entryChapter) || {}).title,
    h: state.history.slice(-30).map(h => [h.role, h.content.slice(0, 500)])
  };
  const json = JSON.stringify(payload);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  const url = location.origin + location.pathname + '#share=' + encodeURIComponent(b64);
  $('shareLinkBox').style.display = '';
  $('shareLinkText').value = url;
  navigator.clipboard.writeText(url).then(() => toast('分享链接已复制'), () => toast('链接已生成，请手动复制'));
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* ============================================================
 * P1-9 场景插画（可选，默认关闭）
 * ============================================================ */
const IMAGE_PRESETS = {
  none:      { label: '关闭' },
  pollinations: { label: 'Pollinations（免费无需 Key）', url: 'https://image.pollinations.ai/prompt/{prompt}?width=768&height=432&nologo=true', keyless: true },
  openai:    { label: 'OpenAI DALL·E 3', endpoint: 'https://api.openai.com/v1/images/generations', model: 'dall-e-3' },
  openrouter: { label: 'OpenRouter（flux/sd）', endpoint: 'https://openrouter.ai/api/v1/images/generations', model: 'black-forest-labs/flux-schnell' },
  sdlocal:   { label: 'SD 本地（Automatic1111）', endpoint: 'http://127.0.0.1:7860/sdapi/v1/txt2img', model: '' }
};

async function genSceneImage(narration, msgEl) {
  const provider = state.config.imageProvider;
  if (!provider || provider === 'none') return;
  if (!narration || narration.length < 30) return;

  // 缓存键：剧情内容哈希
  const cacheKey = 'img_' + hashStr(narration.slice(0, 120));
  const cached = await DB.get(PN_STORE.gallery, cacheKey);
  if (cached) { renderSceneImage(msgEl, cached); return; }

  const prompt = `anime style scene illustration, cinematic lighting: ${narration.slice(0, 200)}`;
  try {
    let imgUrl = '';
    const p = IMAGE_PRESETS[provider];
    if (p.keyless) {
      imgUrl = p.url.replace('{prompt}', encodeURIComponent(prompt));
      // 预热：确认可加载
      await preloadImage(imgUrl);
    } else {
      const resp = await fetch(p.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (state.config.imageApiKey || '') },
        body: JSON.stringify({ model: p.model, prompt, n: 1, size: '1024x576' })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error && data.error.message || ('HTTP ' + resp.status));
      imgUrl = data.data && data.data[0] && (data.data[0].url || (data.data[0].b64_json && ('data:image/png;base64,' + data.data[0].b64_json)));
    }
    if (!imgUrl) throw new Error('未获取到图片');
    await DB.set(PN_STORE.gallery, cacheKey, imgUrl);
    renderSceneImage(msgEl, imgUrl);
  } catch (e) {
    console.warn('插画生成失败:', e.message);
  }
}

function renderSceneImage(msgEl, url) {
  if (!msgEl || msgEl.querySelector('.scene-img')) return;
  const wrap = document.createElement('div');
  wrap.className = 'scene-img';
  const img = document.createElement('img');
  img.src = url;
  img.alt = '场景插画';
  img.loading = 'lazy';
  wrap.appendChild(img);
  msgEl.appendChild(wrap);
  scrollBottom();
}

function preloadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = resolve;
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = url;
    setTimeout(reject, 20000);
  });
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return (h >>> 0).toString(36);
}

/* ============================================================
 * AI 调用（三通道：Node 代理 / 浏览器直连 / 本地演示引擎）
 * 返回 { content, usage }
 * ============================================================ */
/* 云端模型下拉：让用户自己选免密钥模型（默认已挑低延迟的） */
async function fillCloudModelOptions() {
  const sel = $('cfgCloudModel');
  if (!sel) return;
  if (!window.PNCloud || CLOUD_OK === false) {
    $('cloudModelRow').style.display = 'none';
    return;
  }
  $('cloudModelRow').style.display = '';
  try {
    const models = await PNCloud.llm.listModels();
    const cur = state.config.cloudModel || PNCloud.llm.currentModel() || '';
    sel.innerHTML = '';
    models.forEach(m => {
      const op = document.createElement('option');
      op.value = m.id;
      op.textContent = (m.name || m.id) + (m.credits ? ' · ' + m.credits : '');
      if (m.id === cur) op.selected = true;
      sel.appendChild(op);
    });
    if (cur && !models.some(m => m.id === cur)) {
      const op = document.createElement('option');
      op.value = cur; op.textContent = cur + '（当前）'; op.selected = true;
      sel.insertBefore(op, sel.firstChild);
    }
    sel.onchange = async () => {
      state.config.cloudModel = sel.value;
      await saveConfig(state.config);
      if (window.PNCloud) PNCloud.llm.setModel(sel.value);
      refreshModeBadge();
      toast('云端模型已切换为 ' + sel.value);
    };
  } catch (e) {
    sel.innerHTML = '<option value="">云端模型不可用</option>';
  }
}

/* ============================================================
 * 云端模型通道的「谁付钱」策略
 * ------------------------------------------------------------
 * 免密钥通道消耗的是**应用所有者的云服务额度**（按 credits 计费）。
 * 因此它不能是默认通道：
 *   ① 默认关闭，必须用户在设置里显式勾选「使用云端体验」；
 *   ② 即使开启，也只给每浏览器固定次数（CLOUD_TRIAL_LIMIT），用完自动回退演示；
 *   ③ 有自己 Key 的用户永远走自己的 Key，不碰应用额度。
 * ============================================================ */
const CLOUD_TRIAL_LIMIT = 6;
const CLOUD_TRIAL_KEY = 'pn_cloud_trial_used';

function cloudTrialUsed() {
  const n = parseInt(localStorage.getItem(CLOUD_TRIAL_KEY) || '0', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function cloudTrialLeft() {
  return Math.max(0, CLOUD_TRIAL_LIMIT - cloudTrialUsed());
}
function cloudTrialEnabled() {
  return state.config && state.config.cloudTrial === true;
}
function bumpCloudTrial() {
  const n = cloudTrialUsed() + 1;
  try { localStorage.setItem(CLOUD_TRIAL_KEY, String(n)); } catch { /* 隐私模式忽略 */ }
  if (cloudTrialLeft() === 0) {
    toast('云端体验次数已用完，已切回演示模式；填入自己的 API Key 可继续使用真实模型', 4200);
  }
  refreshModeBadge();
  return cloudTrialLeft();
}

/* 云端通道是否可用：SDK 就绪 + 没自带 Key + 用户显式开启 + 还有剩余次数 */
function cloudStreamAvailable() {
  return !!window.PNCloud && CLOUD_OK !== false && !hasLiveKey()
    && cloudTrialEnabled() && cloudTrialLeft() > 0;
}

async function callAI(messages, temperature = 0.8, maxTokens = 800, mockAction = 'narrate', mockUserText = '') {
  if (hasLiveKey()) {
    // 优先走 Node 代理（规避 CORS、Key 不暴露在页面网络面板）
    if (BACKEND_OK !== false) {
      try {
        const resp = await fetch('/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            baseUrl: state.config.baseUrl,
            apiKey: state.config.apiKey,
            model: state.config.model,
            messages, temperature, maxTokens
          })
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
        return { content: data.content, usage: data.usage };
      } catch (e) {
        if (BACKEND_OK === true) { BACKEND_OK = false; toast('后端不可用，已切换本地直连模式'); }
        // 落到浏览器直连
        return directCallAI(messages, temperature, maxTokens);
      }
    }
    return directCallAI(messages, temperature, maxTokens);
  }
  // 无自带 Key：先试云端免密钥模型，失败再回退本地演示引擎
  if (cloudStreamAvailable()) {
    try {
      const r = await PNCloud.llm.chat({ messages, temperature, maxTokens });
      if (r && r.content) {
        CLOUD_OK = true;
        bumpCloudTrial();
        return {
          content: r.content,
          usage: r.usage ? {
            prompt_tokens: r.usage.prompt_tokens || 0,
            completion_tokens: r.usage.completion_tokens || 0,
            cloud: true
          } : null
        };
      }
    } catch (e) {
      CLOUD_OK = false;
      refreshModeBadge();
      console.warn('[cloud] 调用失败：', e.message);
    }
  }
  return localMock(mockAction, mockUserText);
}

/* 浏览器直连 OpenAI 兼容接口（本地 HTML 模式；需服务商支持 CORS） */
async function directCallAI(messages, temperature, maxTokens) {
  const url = state.config.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + state.config.apiKey
    },
    body: JSON.stringify({ model: state.config.model, messages, temperature, max_tokens: maxTokens })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error && data.error.message ? data.error.message : ('上游接口错误 ' + resp.status));
  const content = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
  return { content, usage: data.usage };
}

/* 构造演示模式请求体（流式/非流式共用） */
function buildMockBody(mockAction = 'narrate', mockUserText = '') {
  return {
    action: mockAction,
    context: { text: state.novel ? state.novel.fullText.slice(0, 20000) : '' },
    world: {
      name: guessWorldName(),
      protagonist: state.selectedRole,
      style: guessWorldStyle(),
      characters: state.characters.map(c => c.name)
    },
    userInput: mockUserText,
    chapterTitle: (state.novel && state.novel.chapters[state.entryChapter] || {}).title,
    history: state.history
  };
}

/* 本地演示引擎（mock-engine.js），无后端时使用 */
function localMock(mockAction = 'narrate', mockUserText = '') {
  const body = buildMockBody(mockAction, mockUserText);
  const content = mockAction === 'summarize'
    ? MockEngine.summarize(body)
    : MockEngine.narrate(body);
  return {
    content,
    usage: {
      prompt_tokens: Math.ceil(JSON.stringify(body).length / 2),
      completion_tokens: Math.ceil(content.length / 2),
      mock: true
    }
  };
}

/* 旧 mockGenerate 保留兼容（内部转调 localMock） */
async function mockGenerate(messages, mockAction = 'narrate', mockUserText = '') {
  if (BACKEND_OK === false) {
    await sleep(300 + Math.random() * 400);
    return localMock(mockAction, mockUserText);
  }
  const resp = await fetch('/api/ai/mock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildMockBody(mockAction, mockUserText))
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || '演示生成失败');
  await sleep(300 + Math.random() * 400);
  return {
    content: data.content,
    usage: {
      prompt_tokens: Math.ceil(JSON.stringify(messages).length / 2),
      completion_tokens: Math.ceil((data.content || '').length / 2),
      mock: true
    }
  };
}

function guessWorldName() {
  if (!state.world) return '未知之境';
  const m = state.world.match(/## 世界名称\s*\n(.+)/);
  return m ? m[1].trim() : '未知之境';
}
function guessWorldStyle() {
  if (!state.world) return '奇幻冒险';
  const m = state.world.match(/## 故事风格\s*\n(.+)/);
  return m ? m[1].trim() : '奇幻冒险';
}

function fallbackNarration(chapterText, action) {
  // 演示兜底：直接截取原文 + 行动回显
  const snippet = chapterText.replace(/\s+/g, ' ').slice(100, 320);
  return `${snippet}……\n\n你${action ? '选择了「' + action.slice(0, 30) + '」' : '深吸一口气'}，周围的空气随之震颤，仿佛这个世界正在回应你的意志。命运的丝线在看不见的地方悄然收紧——下一步，由你决定。`;
}

function demoWorldCard(novel) {
  const head = novel.fullText.slice(0, 600).replace(/\s+/g, ' ');
  return `## 世界名称
${novel.title || '未命名之境'}

## 世界观
（演示模式 · 基于原文片段推断）故事发生在一个规则独特的架空世界之中。从开篇来看，这里有明确的等级或力量秩序，人物命运彼此交织，一步错则全局皆动。

## 核心人物
- 主角｜命运的漩涡中心｜意志坚定｜故事的核心
- 引路人｜神秘的指引者｜亦正亦邪｜推动剧情的关键
- 对手｜阻挡在前方的阴影｜傲慢而强大｜主角必须跨越的存在
- 同伴｜并肩而行的伙伴｜忠诚可靠｜情感线的锚点

## 主角
${head.slice(0, 60)}……

## 故事风格
沉浸叙事 · 强氛围感

## 当前暗流
（配置 API Key 后，AI 将在这里深度解析原著的伏笔与冲突。当前为演示模式，先随意体验流程吧！）`;
}

/* P1-6：给某条剧情消息打上冲突警告（标黄 + 横幅 + 重写/接受） */
function markCanonWarning(hid, reason) {
  const h = state.history.find(x => x.id === hid);
  if (!h) return;
  h.canonWarn = reason;
  const el = $('storyFlow').querySelector(`[data-hid="${hid}"]`);
  if (!el) return;
  el.classList.add('canon-warn');
  const banner = document.createElement('div');
  banner.className = 'canon-banner';
  banner.innerHTML = `<span>⚠️ 可能与已确立事实冲突：${escapeHtml(reason)}</span>`;
  const btnRewrite = document.createElement('button');
  btnRewrite.className = 'btn small';
  btnRewrite.textContent = '🔄 重写此段';
  btnRewrite.onclick = () => {
    banner.remove();
    el.classList.remove('canon-warn');
    rewriteAiMessage(hid);
  };
  const btnAccept = document.createElement('button');
  btnAccept.className = 'btn small ghost';
  btnAccept.textContent = '✓ 接受此段';
  btnAccept.onclick = () => {
    banner.remove();
    el.classList.remove('canon-warn');
    delete h.canonWarn;
    // 接受即成为新事实：追加进事实清单
    state.factList = (state.factList ? state.factList + '\n' : '') + '- （玩家接受）' + h.content.slice(0, 80);
    saveProgress();
    toast('已接受该段并记入事实清单');
  };
  banner.append(btnRewrite, btnAccept);
  el.appendChild(banner);
  saveProgress();
}

/* ============================================================
 * 消息渲染（含 P0-3 操作栏 / P0-2 流式 / P1-6 冲突横幅）
 * ============================================================ */

/* 创建一条流式占位消息，返回 { el, body } */
function createStoryMessage() {
  const el = document.createElement('div');
  el.className = 'msg narration';
  el.innerHTML = `<span class="msg-tag">◈ 剧情续写</span><div class="msg-body"></div>`;
  $('storyFlow').appendChild(el);
  return { el, body: el.querySelector('.msg-body') };
}

/* 流式增量渲染（story 模式做 JSON 内 narration 字段的渐进提取） */
function renderStreamText(bodyEl, text, streaming) {
  const cursor = streaming ? '<span class="stream-cursor"></span>' : '';
  bodyEl.innerHTML = (text ? escapeHtml(text).replace(/\n/g, '<br>') : '') + cursor;
  scrollBottom();
}

/* 从流式 JSON buffer 中渐进提取 narration 文本（容忍不完整 JSON） */
function streamPreview(buf) {
  const m = buf.match(/"narration"\s*:\s*"([\s\S]*)$/);
  if (m) {
    let raw = m[1];
    const close = raw.indexOf('", "');
    if (close >= 0) raw = raw.slice(0, close + 1);
    raw = raw.replace(/\\$/, '');
    try { return JSON.parse('"' + raw + '"'); }
    catch {
      return raw.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    }
  }
  if (buf.includes('"narration"')) return '';
  return buf.length > 60 ? buf : '';
}

/* 生成结束：渲染最终消息 + 建议 chips + 操作栏 */
function renderFinalMessage(el, body, narration, suggestions, mode) {
  body.innerHTML = escapeHtml(narration).replace(/\n/g, '<br>');
  if (mode === 'story' && suggestions && suggestions.length) {
    const chips = document.createElement('div');
    chips.className = 'suggest-chips';
    suggestions.forEach(s => {
      const b = document.createElement('button');
      b.className = 'suggest-chip';
      b.textContent = s;
      b.onclick = () => { $('actionInput').value = s; $('actionInput').focus(); };
      chips.appendChild(b);
    });
    el.appendChild(chips);
  }
  el.appendChild(buildMsgOps(el, 'ai'));
}

/* P0-3：消息操作栏（悬停显示） */
function buildMsgOps(el, kind, hid) {
  const ops = document.createElement('div');
  ops.className = 'msg-ops';
  if (kind === 'user') {
    const edit = document.createElement('button');
    edit.textContent = '编辑';
    edit.title = '编辑这条行动，并基于新输入重写后续剧情';
    edit.onclick = () => editUserMessage(el);
    ops.appendChild(edit);
  } else if (kind === 'canon') {
    const rw = document.createElement('button');
    rw.textContent = '重写此段';
    rw.onclick = () => { el.classList.remove('canon-warn'); const b = el.querySelector('.canon-banner'); if (b) b.remove(); rewriteAiMessage(hid); };
    ops.appendChild(rw);
    const ok = document.createElement('button');
    ok.textContent = '✓ 接受';
    ok.onclick = () => {
      el.classList.remove('canon-warn');
      const b = el.querySelector('.canon-banner'); if (b) b.remove();
      const h = state.history.find(x => x.id === hid);
      if (h) { delete h.canonWarn; state.factList = (state.factList ? state.factList + '\n' : '') + '- （玩家接受）' + h.content.slice(0, 80); saveProgress(); }
      toast('已接受该段并记入事实清单');
    };
    ops.appendChild(ok);
  } else {
    const rw = document.createElement('button');
    rw.textContent = '重写';
    rw.title = '重新生成这段剧情';
    rw.onclick = () => rewriteAiMessage(el.dataset.hid);
    ops.appendChild(rw);
  }
  const del = document.createElement('button');
  del.textContent = '回溯';
  del.className = 'danger';
  del.title = '删除此条及其后的全部剧情';
  del.onclick = () => truncateFrom(el.dataset.hid);
  ops.appendChild(del);
  return ops;
}

function addNarration(text, suggestions, hid, canonWarn) {
  const flow = $('storyFlow');
  const el = document.createElement('div');
  el.className = 'msg narration' + (canonWarn ? ' canon-warn' : '');
  el.dataset.hid = hid;
  el.innerHTML = `<span class="msg-tag">◈ 剧情续写</span><div class="msg-body">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
  if (suggestions && suggestions.length) {
    const chips = document.createElement('div');
    chips.className = 'suggest-chips';
    suggestions.forEach(s => {
      const b = document.createElement('button');
      b.className = 'suggest-chip';
      b.textContent = s;
      b.onclick = () => { $('actionInput').value = s; $('actionInput').focus(); };
      chips.appendChild(b);
    });
    el.appendChild(chips);
  }
  if (canonWarn) {
    const banner = document.createElement('div');
    banner.className = 'canon-banner';
    banner.innerHTML = `<span>⚠️ 可能与已确立事实冲突：${escapeHtml(canonWarn)}</span>`;
    banner.appendChild(buildMsgOps(el, 'canon', hid));
    el.appendChild(banner);
    // 有冲突横幅时不再附加常规操作栏（横幅内已含重写/接受/回溯）
  } else {
    el.appendChild(buildMsgOps(el, 'ai'));
  }
  flow.appendChild(el);
  scrollBottom();
}

function addUserMessage(text, hid) {
  const flow = $('storyFlow');
  const el = document.createElement('div');
  el.className = 'msg user';
  el.dataset.hid = hid;
  el.textContent = text;
  el.appendChild(buildMsgOps(el, 'user'));
  flow.appendChild(el);
  scrollBottom();
}

function addSystemNote(text) {
  const flow = $('storyFlow');
  const el = document.createElement('div');
  el.className = 'msg system-note';
  el.textContent = text;
  flow.appendChild(el);
  scrollBottom();
}

let typingEl = null;
function showTyping() {
  hideTyping();
  const flow = $('storyFlow');
  typingEl = document.createElement('div');
  typingEl.className = 'msg narration';
  typingEl.innerHTML = `<span class="msg-tag">◈ DM 思考中</span><span class="typing"><i></i><i></i><i></i></span>`;
  flow.appendChild(typingEl);
  scrollBottom();
}
function hideTyping() { if (typingEl) { typingEl.remove(); typingEl = null; } }
function scrollBottom() {
  const flow = $('storyFlow');
  flow.scrollTop = flow.scrollHeight;
}

/* ============================================================
 * 侧边栏 & 步骤切换
 * ============================================================ */
/* 步骤切换：面板 + 顶部步骤进度条联动 */
const STEP_ORDER = ['upload', 'world', 'chapters', 'play'];
function gotoStep(id) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  $(id).classList.add('active');
  const step = id.replace('step-', '');
  document.body.dataset.step = step;   // 驱动首屏 Hero 的显隐
  const idx = STEP_ORDER.indexOf(step);
  document.querySelectorAll('.step-bar-item').forEach((el, i) => {
    el.classList.toggle('active', i === idx);
    el.classList.toggle('done', i < idx);
  });
  document.querySelectorAll('.step-bar-sep').forEach((el, i) => {
    el.classList.toggle('done', i < idx);
  });
}
function renderSideWorld() {
  const el = $('sideWorld');
  if (!state.novel) { el.className = 'side-empty'; el.textContent = '尚未加载小说'; return; }
  el.className = '';
  el.innerHTML = `<b>${escapeHtml(state.novel.title)}</b><br>
    <span style="color:var(--text-dim)">${state.novel.chapters.length} 章 · ${(state.novel.fullText || '').length.toLocaleString()} 字</span>`;
}
function renderSideProgress() {
  const el = $('sideProgress');
  if (!state.playing && state.turn === 0) { el.className = 'side-empty'; el.textContent = '未开始'; }
  else {
    el.className = '';
    el.innerHTML = `第 <b>${state.turn}</b> 轮回合<br><span style="color:var(--text-dim)">身份：${escapeHtml(state.selectedRole || '-')}</span>`;
  }
  const ev = $('sideEvents');
  if (!state.events.length) { ev.innerHTML = '<li class="side-empty">暂无</li>'; }
  else ev.innerHTML = state.events.slice(-8).map(e => `<li>${escapeHtml(e)}</li>`).join('');
}

/* ---------------- 进度持久化（IndexedDB） ---------------- */
async function saveProgress() {
  try {
    if (state.novel) {
      await DB.set(PN_STORE.novel, 'main', {
        title: state.novel.title,
        chapters: state.novel.chapters,
        fullText: state.novel.fullText
      });
    }
    await DB.set(PN_STORE.progress, 'main', {
      world: state.world,
      selectedRole: state.selectedRole,
      entryChapter: state.entryChapter,
      history: state.history.slice(-60),
      events: state.events,
      turn: state.turn,
      rollingSummary: state.rollingSummary,
      summarizedTurns: state.summarizedTurns,
      usage: state.usage,
      charState: state.charState,
      factList: state.factList,
      lastFactTurn: state.lastFactTurn,
      sourceLang: state.sourceLang,
      outputLang: state.outputLang,
      lastCanonCheck: state.lastCanonCheck || 0
    });
  } catch (e) { console.warn('保存进度失败:', e.message); }
}
async function restoreProgress() {
  try {
    const novel = await DB.get(PN_STORE.novel, 'main');
    if (!novel) return;
    const s = await DB.get(PN_STORE.progress, 'main');
    state.novel = novel;
    state.world = s ? s.world : null;
    state.selectedRole = s ? s.selectedRole : null;
    state.entryChapter = s ? s.entryChapter : 0;
    state.history = (s && s.history) || [];
    state.events = (s && s.events) || [];
    state.turn = (s && s.turn) || 0;
    state.rollingSummary = (s && s.rollingSummary) || '';
    state.summarizedTurns = (s && s.summarizedTurns) || 0;
    state.usage = (s && s.usage) || { promptTokens: 0, completionTokens: 0, calls: 0 };
    state.charState = (s && s.charState) || null;
    state.factList = (s && s.factList) || '';
    state.lastFactTurn = (s && s.lastFactTurn) || 0;
    state.lastCanonCheck = (s && s.lastCanonCheck) || 0;
    // P2-13 语言状态
    state.sourceLang = (s && s.sourceLang) || (state.novel ? PNParser.detectLanguage(state.novel.fullText || '') : null);
    state.outputLang = (s && s.outputLang) || state.config.outputLang || 'auto';
    updateLangHint();
    // 兼容旧数据：补齐消息 id
    state.history.forEach(h => { if (h.id == null) h.id = nextHid(); });
    _hidSeq = state.history.reduce((m, h) => Math.max(m, h.id || 0), 0) + 1;
    renderSideWorld(); renderSideProgress(); renderMemoryPanel(); renderStatePanel(); renderUsagePanel();
    if (state.world) {
      $('worldCard').classList.remove('loading');
      $('worldCard').textContent = state.world;
      if (state.history.length) {
        // 有进行中的剧情：直接回到互动舞台
        const ch = state.novel.chapters.find(c => c.id === state.entryChapter) || state.novel.chapters[0];
        $('playChapterTitle').textContent = ch ? ch.title : '';
        $('playRole').textContent = `身份：${state.selectedRole || '-'}`;
        gotoStep('step-play');
        renderHistory();
      } else {
        gotoStep('step-chapters');
      }
      toast('已恢复上次的阅读进度');
    }
  } catch (e) { console.warn('恢复进度失败:', e.message); }
}

/* ---------------- 工具 ---------------- */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function tryParseJson(text) {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]);
    return obj.narration ? obj : null;
  } catch { return null; }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ============================================================
 * 内置示例小说（零配置完整体验）
 * ============================================================ */
const SAMPLE_NOVEL = `星海学院的转学生

第一章 陌生的天花板

林辰睁开眼睛，映入眼帘的是一盏雕刻着星图的水晶吊灯。他记得自己明明只是在旧书店里翻阅一本没有封皮的旧书，怎么一觉醒来就躺在了这张四柱大床上？

"终于醒了？"一个冷淡的女声从床边传来，"你昏倒在学院大门外整整一天，守门人差点把你当成弃尸。"

说话的少女穿着一袭深蓝色的学院制服，银色短发之下是一双仿佛能看透人心的灰眸。她胸前别着一枚徽章——"星海学院 · 监察会"。

"这里是……"林辰撑起身子，太阳穴突突直跳。

"星海学院，悬浮在云海之上的魔法学院。"少女合上手中的书，"我是苏璃，监察会三年生。既然醒了，就解释一下吧——你身上为什么会有'那个印记'？"

林辰低头看向自己的手背。一个从未见过的淡金色纹路正在皮肤下缓缓流转，像是某种活着的文字。

"我不知道……"他喃喃道。但就在他开口的瞬间，手背上的印记骤然发烫，一段不属于他的记忆涌入了脑海——那座沉在海底的古城，和城门前站着的一排排沉默人影。

"看来是真的。"苏璃的瞳孔微微一缩，"入学测验要提前了。林辰，不管你以前是谁，从今天起，你的名字会写进星海的名册。"

第二章 云海之上的测验

第二天的入学测验设在学院中央的浮空竞技场。三千名新生围坐在环形看台上，看着场地中央那块足有三人高的水晶石。

"那是'真言晶'。"苏璃不知何时出现在林辰身侧，压低声音解释道，"它会读取你灵魂的波长，折射出你最真实的属性。注意，不要抵抗它——越抵抗，反噬越强。"

林辰点点头，掌心却不自觉地握紧。他能感觉到，无数道视线正落在自己身上，其中几道格外冰冷。

"下一批，东区十七号！"

机械的唱名声响起。林辰深吸一口气，踏入竞技场。真言晶在他靠近的瞬间爆发出刺目的光芒，那光芒并非单一的蓝色或红色，而是金与紫交织的旋涡，像是有两股截然不同的力量在他体内撕扯。

看台上炸开了锅。

"双属性共鸣？！这十年里只有一个人做到过——"

"那个人后来成了'叛序者'。"

林辰听不清周围的喧哗。他的视野里，水晶深处浮现出一行古老的文字，只有他能看见：

"当群星归位之时，封印之物将再度醒来。"

测验结束的钟声响起时，一个身披黑色斗篷的中年男人拦住了他的去路。男人微笑着递来一张烫金名片。

"林辰同学，有兴趣谈谈吗？关于你手背上的印记——以及，你的父亲。"

第三章 暗流

夜幕降临，林辰躺在宿舍的床上，反复端详那张名片。名片的背面只有一个地址：旧图书馆，地下三层。

窗外的云海翻涌如墨，将星海学院托举在万丈高空。远处，尖塔顶端的风灯明明灭灭，像是某种古老生物缓慢眨动的眼睛。

林辰闭上眼。父亲的面容在他记忆中已经模糊了——十年前的那场"事故"之后，家里再没有人提起过那个名字。

但手背上的印记告诉他，有些事情，从未真正结束。

他起身披上外套，推开门，走进了星光黯淡的走廊。`;
