/* ============================================================
 * Playable Novel Engine · 前端核心逻辑
 * 流程：上传小说 → AI 推演世界卡片 → 选择入口/角色 → 自由互动
 * 存储：localStorage（配置 + 进度），无服务端状态
 * ============================================================ */

/* ---------------- 全局状态 ---------------- */
const state = {
  config: loadConfig(),        // { baseUrl, apiKey, model, useMock }
  novel: null,                 // { title, chapters[], totalChars }
  world: null,                 // AI 推演的世界卡片（Markdown 文本）
  characters: [],              // 提取的人物 [{ name, desc }]
  selectedRole: null,          // 当前扮演身份
  entryChapter: 0,             // 入口章节 id
  history: [],                 // [{ role: 'user'|'ai', content }]
  events: [],                  // 已触发事件摘要
  turn: 0,
  playing: false
};

const $ = id => document.getElementById(id);
const LS_KEY = 'playable-novel-state-v1';

/* ---------------- 初始化 ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  bindUpload();
  bindSettings();
  bindWorld();
  bindChapters();
  bindPlay();
  refreshModeBadge();
  restoreProgress();
});

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
function loadConfig() {
  try {
    return JSON.parse(localStorage.getItem('pn-config') || '{}');
  } catch { return {}; }
}
function saveConfig(cfg) {
  localStorage.setItem('pn-config', JSON.stringify(cfg));
  state.config = cfg;
  refreshModeBadge();
}
function hasLiveKey() {
  return !!(state.config.baseUrl && state.config.apiKey && state.config.model);
}
function refreshModeBadge() {
  const badge = $('modeBadge');
  if (hasLiveKey()) {
    badge.textContent = '⚡ 已连接 ' + state.config.model;
    badge.className = 'mode-badge live';
  } else {
    badge.textContent = '演示模式';
    badge.className = 'mode-badge demo';
  }
}

function bindSettings() {
  $('btnSettings').onclick = () => {
    $('cfgBaseUrl').value = state.config.baseUrl || '';
    $('cfgApiKey').value = state.config.apiKey || '';
    $('cfgModel').value = state.config.model || '';
    $('cfgUseMock').checked = state.config.useMock !== false;
    $('settingsModal').classList.add('open');
  };
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

  $('btnSaveSettings').onclick = () => {
    saveConfig({
      baseUrl: $('cfgBaseUrl').value.trim(),
      apiKey: $('cfgApiKey').value.trim(),
      model: $('cfgModel').value.trim(),
      useMock: $('cfgUseMock').checked
    });
    $('settingsModal').classList.remove('open');
    toast(hasLiveKey() ? '✅ 已连接真实大模型，开始你的故事吧' : '⚙️ 已保存，未配置 Key 时将使用演示模式');
  };
  $('btnClearSettings').onclick = () => {
    localStorage.removeItem('pn-config');
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
}

function readFile(file) {
  if (file.size > 8 * 1024 * 1024) return toast('文件过大，请上传 8MB 以内的 txt');
  const reader = new FileReader();
  reader.onload = () => parseNovel(String(reader.result || ''));
  reader.onerror = () => toast('文件读取失败');
  reader.readAsText(file, 'utf-8');
}

async function parseNovel(text, isSample = false) {
  toast('⚡ 正在解析章节结构……');
  let data;
  try {
    const resp = await fetch('/api/novel/split', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '解析失败');
  } catch (e) {
    return toast('解析失败：' + e.message);
  }

  state.novel = {
    title: isSample ? '星海学院的转学生（内置示例）' : data.title,
    chapters: data.chapters,
    fullText: data.fullText
  };
  renderSideWorld();
  gotoStep('step-world');
  toast(`✅ 解析完成：共 ${data.totalChapters} 章 / ${data.totalChars.toLocaleString()} 字`);
  analyzeWorld();
}

/* ============================================================
 * 步骤 2：AI 推演世界卡片
 * ============================================================ */
function bindWorld() {
  $('btnReanalyze').onclick = analyzeWorld;
  $('btnGoChapters').onclick = () => { renderChapterPicker(); gotoStep('step-chapters'); };
}

async function analyzeWorld() {
  const card = $('worldCard');
  card.classList.add('loading');
  card.textContent = state.playing || hasLiveKey() ? 'AI 正在推演世界设定……' : '演示模式推演中……';
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
  try {
    content = await callAI([
      { role: 'system', content: '你是一位专业的世界观架构师，擅长从小说文本中提炼设定。' },
      { role: 'user', content: prompt }
    ], 0.5, 900);
  } catch (e) {
    content = null;
    toast('AI 推演失败：' + e.message);
  }

  if (!content) {
    // 演示模式的兜底世界卡片
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
function bindPlay() {
  $('btnSend').onclick = sendAction;
  $('actionInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAction(); }
  });
  $('btnRestart').onclick = () => {
    if (!confirm('确定重开本局？当前剧情进度将被清除。')) return;
    state.history = []; state.events = []; state.turn = 0; state.playing = false;
    $('storyFlow').innerHTML = '';
    $('suggestions').innerHTML = '';
    renderSideProgress();
    gotoStep('step-chapters');
    toast('已重开，重新选择入口吧');
  };
  $('btnEnding').onclick = generateEnding;
}

async function startStory(chapterId) {
  state.entryChapter = chapterId;
  state.history = [];
  state.events = [];
  state.turn = 0;
  state.playing = true;

  const ch = state.novel.chapters.find(c => c.id === chapterId) || state.novel.chapters[0];
  $('playChapterTitle').textContent = ch.title;
  $('playRole').textContent = `身份：${state.selectedRole}`;
  $('storyFlow').innerHTML = '';
  $('suggestions').innerHTML = '';
  gotoStep('step-play');
  renderSideProgress();
  saveProgress();

  addSystemNote(`你以「${state.selectedRole}」的身份，从「${ch.title}」踏入这个世界。`);

  // AI 生成开场：基于该章节原文 + 世界设定
  showTyping();
  const chapterText = extractChapterText(chapterId);
  const prompt = buildStoryPrompt(chapterText) +
`\n\n【开场任务】以「${state.selectedRole}」的视角，为这个故事写一个沉浸式开场（150-250字）：
描写你此刻身处何地、周遭正在发生什么、身体与情绪的直观感受。
严格遵循原著设定，第二人称「你」叙述。只输出正文，不要标题。`;

  try {
    const content = await callAI([
      { role: 'system', content: STORY_SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ], 0.85, 500);
    hideTyping();
    let parsed = tryParseJson(content);
    addNarration(parsed ? parsed.narration : content, parsed ? parsed.suggestions : null);
    state.history.push({ role: 'ai', content: parsed ? parsed.narration : content });
    state.turn = 1;
    renderSideProgress();
    saveProgress();
  } catch (e) {
    hideTyping();
    addNarration('（AI 连接失败，已切换到演示模式续写）\n\n' + fallbackNarration(chapterText));
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
  input.value = '';

  addUserMessage(text);
  state.history.push({ role: 'user', content: text });
  showTyping();

  // 组装上下文：世界设定 + 最近剧情 + 用户行动
  const chapterText = extractChapterText(state.entryChapter);
  const recent = state.history.slice(-8).map(h => (h.role === 'user' ? `【你的行动】${h.content}` : `【剧情】${h.content}`)).join('\n');

  const prompt = buildStoryPrompt(chapterText) +
`\n\n【身份】你正在扮演：${state.selectedRole}
【原著章节】${(state.novel.chapters.find(c => c.id === state.entryChapter) || {}).title || ''}

【目前为止的故事】
${recent}

【你刚刚的行动】
${text}

【任务】以「${state.selectedRole}」的视角续写剧情（120-250字）：
1. 世界与人物对这个行动的真实反应（符合原著人物性格）
2. 环境的变化与新信息的揭示
3. 自然引出下一个抉择点
严格遵循原著世界观，第二人称叙述。同时给出 3 个接下来的可选行动建议（JSON 输出）。`;

  try {
    const content = await callAI([
      { role: 'system', content: STORY_SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ], 0.9, 600);
    hideTyping();
    let parsed = tryParseJson(content);
    const narration = parsed ? parsed.narration : content;
    addNarration(narration, parsed ? parsed.suggestions : null);
    state.history.push({ role: 'ai', content: narration });
    state.turn++;
    // 事件摘要
    const summary = text.slice(0, 24);
    if (!state.events.includes(summary)) state.events.push(summary);
    renderSideProgress();
    saveProgress();
  } catch (e) {
    hideTyping();
    addNarration('（AI 连接失败，已切换到演示模式续写）\n\n' + fallbackNarration(chapterText, text));
  }
}

async function generateEnding() {
  if (!state.playing) return toast('先开始一段故事吧');
  showTyping();
  const recent = state.history.slice(-10).map(h => (h.role === 'user' ? `【你的行动】${h.content}` : `【剧情】${h.content}`)).join('\n');
  const prompt = `基于以下互动故事线，为「${state.selectedRole}」写一个结局（150-300字）：
呼应开头、收束本作的关键伏笔，第二人称叙述，可留一个余韵悠长的收尾。

${recent}`;
  try {
    const content = await callAI([
      { role: 'system', content: '你是这个故事的地下城主，现在为这段旅程画上句点。' },
      { role: 'user', content: prompt }
    ], 0.9, 500);
    hideTyping();
    addSystemNote('—— 本局结局 ——');
    addNarration(content, null);
    state.playing = false;
    saveProgress();
  } catch (e) {
    hideTyping();
    toast('结局生成失败：' + e.message);
  }
}

/* ---------------- 提示词构造 ---------------- */
const STORY_SYSTEM_PROMPT =
`你是一部互动小说的「地下城主」（DM）。你的职责是基于原著设定，实时续写玩家行动之后的剧情。
铁律：
1. 严格遵循给定的世界观、人物性格与人物关系，不得 OOC（角色崩坏）
2. 使用第二人称「你」叙述玩家视角
3. 文风贴合原著风格，注重画面感与情绪
4. 玩家的行动必须有真实后果：世界会记住、人物会记住
5. 不要代替玩家做决定，只呈现世界的回应与新的局势
默认以 JSON 输出：{"narration":"剧情正文","suggestions":["建议1","建议2","建议3"],"mood":"当前氛围"}`;

function buildStoryPrompt(chapterText) {
  return `【世界设定】\n${state.world || '（未推演）'}\n\n【原著参考（当前章节上下文）】\n${chapterText.slice(0, 4000)}`;
}

/* ============================================================
 * AI 调用（真实 / 演示双通道）
 * ============================================================ */
async function callAI(messages, temperature = 0.8, maxTokens = 800) {
  if (hasLiveKey()) {
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
    return data.content;
  }
  // 演示模式
  return mockGenerate(messages);
}

async function mockGenerate(messages) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const userText = lastUser ? lastUser.content : '';
  const resp = await fetch('/api/ai/mock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      context: { text: state.novel ? state.novel.fullText.slice(0, 20000) : '' },
      world: { name: guessWorldName(), protagonist: state.selectedRole, style: guessWorldStyle() },
      userInput: userText.slice(-200),
      chapterTitle: (state.novel && state.novel.chapters[state.entryChapter] || {}).title,
      history: state.history
    })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || '演示生成失败');
  // 模拟网络延迟，增强真实感
  await sleep(600 + Math.random() * 800);
  return data.content;
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

/* ============================================================
 * 消息渲染
 * ============================================================ */
function addNarration(text, suggestions) {
  const flow = $('storyFlow');
  const el = document.createElement('div');
  el.className = 'msg narration';
  el.innerHTML = `<span class="msg-tag">◈ 剧情续写</span>${escapeHtml(text).replace(/\n/g, '<br>')}`;
  flow.appendChild(el);
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
  scrollBottom();
}

function addUserMessage(text) {
  const flow = $('storyFlow');
  const el = document.createElement('div');
  el.className = 'msg user';
  el.textContent = text;
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
function gotoStep(id) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  $(id).classList.add('active');
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

/* ---------------- 进度持久化 ---------------- */
function saveProgress() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      novel: state.novel ? { title: state.novel.title, chapters: state.novel.chapters.slice(0, 20), fullText: state.novel.fullText.slice(0, 30000) } : null,
      world: state.world,
      selectedRole: state.selectedRole,
      entryChapter: state.entryChapter,
      history: state.history.slice(-20),
      events: state.events,
      turn: state.turn
    }));
  } catch {}
}
function restoreProgress() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (!s || !s.novel) return;
    state.novel = s.novel;
    state.world = s.world;
    state.selectedRole = s.selectedRole;
    state.entryChapter = s.entryChapter;
    state.history = s.history || [];
    state.events = s.events || [];
    state.turn = s.turn || 0;
    renderSideWorld(); renderSideProgress();
    if (state.world) {
      $('worldCard').classList.remove('loading');
      $('worldCard').textContent = state.world;
      gotoStep('step-chapters');
      toast('已恢复上次的阅读进度');
    }
  } catch {}
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
