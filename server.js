/**
 * Playable Novel Engine - 可玩小说引擎
 * 参赛项目：WorkBuddy 1024 造物挑战
 *
 * 轻量后端：静态托管 + AI 代理（OpenAI 兼容接口）+ 演示模式生成器
 * 零数据库，状态全部保存在浏览器 localStorage
 */
const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- 健康检查 ---------------- */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, name: 'playable-novel', version: '1.0.0' });
});

/* ---------------- 章节分割 ----------------
 * 输入小说全文，按「第X章 / Chapter X / 卷」等模式切分为章节数组
 * 找不到章节标记时退化为按固定字数分段
 */
app.post('/api/novel/split', (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || typeof text !== 'string' || text.trim().length < 50) {
      return res.status(400).json({ error: '文本太短或为空，至少需要 50 个字符' });
    }

    const raw = text.replace(/\r\n/g, '\n');
    // 匹配常见章节标题：第1章 / 第一章 / Chapter 1 / 第001章 / 序章 / 序子
    const chapterRe = /(^|\n)\s*(第[0-9零一二三四五六七八九十百千]{1,9}[章回节卷部]|Chapter\s+\d+|序章|序子|终章|尾声|后记)\s*[:：、.\-]?\s*([^\n]{0,60})/gi;

    const matches = [];
    let m;
    while ((m = chapterRe.exec(raw)) !== null) {
      matches.push({ index: m.index, title: m[0].trim().replace(/^[\s\n]+/, '') });
    }

    let chapters = [];
    if (matches.length >= 2) {
      for (let i = 0; i < matches.length; i++) {
        const start = matches[i].index;
        const end = i + 1 < matches.length ? matches[i + 1].index : raw.length;
        const body = raw.slice(start, end).trim();
        // 过滤掉短得像目录的伪章节（阈值 30 字，兼容短章节）
        if (body.replace(matches[i].title, '').trim().length >= 30) {
          chapters.push({ id: chapters.length, title: matches[i].title, text: body });
        }
      }
    }

    // 退化方案：按 ~1500 字分段
    if (chapters.length < 2) {
      const size = 1500;
      chapters = [];
      for (let i = 0; i < raw.length; i += size) {
        chapters.push({
          id: chapters.length,
          title: `片段 ${chapters.length + 1}`,
          text: raw.slice(i, i + size).trim()
        });
      }
    }

    const totalChars = raw.length;
    res.json({
      title: guessTitle(raw),
      totalChapters: chapters.length,
      totalChars,
      chapters: chapters.slice(0, 60).map(c => ({
        id: c.id,
        title: c.title,
        preview: c.text.replace(/\s+/g, ' ').slice(0, 120),
        length: c.text.length
      })),
      // 完整章节文本单独返回，避免预览 payload 过大
      fullText: raw.slice(0, 200000)
    });
  } catch (e) {
    res.status(500).json({ error: '解析失败：' + e.message });
  }
});

function guessTitle(text) {
  const firstLine = text.split('\n').map(s => s.trim()).find(s => s.length > 1 && s.length < 40);
  return firstLine || '未命名小说';
}

/* ---------------- AI 代理（OpenAI 兼容） ----------------
 * 前端传入 baseUrl / apiKey / model / messages，后端转发
 * 支持 OpenAI、DeepSeek、Moonshot、通义、本地 Ollama 等任何兼容接口
 */
app.post('/api/ai/chat', async (req, res) => {
  try {
    const { baseUrl, apiKey, model, messages, temperature = 0.8, maxTokens = 800 } = req.body || {};
    if (!baseUrl || !apiKey || !model || !Array.isArray(messages)) {
      return res.status(400).json({ error: '缺少 baseUrl / apiKey / model / messages 参数' });
    }

    const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens
      }),
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(resp.status).json({ error: `上游接口错误 ${resp.status}: ${errText.slice(0, 300)}` });
    }

    const data = await resp.json();
    const content = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
    res.json({ content, usage: data.usage || null });
  } catch (e) {
    const msg = e.name === 'AbortError' ? '请求超时（60s），请检查网络或更换模型' : e.message;
    res.status(500).json({ error: 'AI 请求失败：' + msg });
  }
});

/* ---------------- 演示模式生成器 ----------------
 * 没有 API Key 也能完整体验产品流程：
 * 基于小说原文 + 用户输入做关键词匹配 + 模板拼装，产出"伪 AI"剧情
 * action = 'narrate'（默认，剧情续写）| 'summarize'（记忆压缩）
 */
app.post('/api/ai/mock', (req, res) => {
  try {
    const { action = 'narrate' } = req.body || {};
    if (action === 'summarize') {
      return res.json({ content: mockSummarize(req.body) });
    }
    res.json({ content: JSON.stringify(mockNarrate(req.body)) });
  } catch (e) {
    res.status(500).json({ error: '演示生成失败：' + e.message });
  }
});

/* 演示：剧情续写（JSON 对象：narration/suggestions/mood） */
function mockNarrate({ context, world, userInput, chapterTitle }) {
  const text = (context && context.text) || '';
  const sentences = splitSentences(text);

  // 1. 找出与用户输入最相关的原文句子（简单词重叠打分）
  const keywords = (userInput || '').replace(/[，。！？、,.!?]/g, ' ').split(/\s+/).filter(w => w.length >= 2);
  let best = [];
  if (keywords.length) {
    best = sentences
      .map(s => ({ s, score: keywords.reduce((acc, k) => acc + (s.includes(k) ? 1 : 0), 0) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(x => x.s);
  }
  // 2. 补充随机环境描写句
  const filler = shuffle(sentences).slice(0, 2);

  const worldName = (world && world.name) || '这个世界';
  const protagonist = (world && world.protagonist) || '你';
  const style = (world && world.style) || '奇幻冒险';

  const templates = [
    () => `${pick(best)}。空气仿佛凝固了一瞬，${protagonist}能清楚地听见自己的心跳。${pick(filler)}。事情的发展显然脱离了所有人的预料——包括你。`,
    () => `就在你行动的瞬间，${pick(best)}。${pick(filler)}。这就是${worldName}的法则：每一个选择都会留下痕迹，而你刚刚写下的一笔，恐怕比想象中更深。`,
    () => `${pick(best)}。远处传来若有若无的回响，像是回应，又像是警告。${pick(filler)}。你知道，从这一刻起，「${chapterTitle || '故事'}」的走向已经改变。`,
    () => `你的行动像一颗投入静湖的石子。${pick(best)}。${pick(filler)}。${style}的气息在四周弥漫开来，下一个瞬间，你必须决定——是进，还是退？`,
    () => `${pick(best)}。时间在这一刻被拉得很长。${pick(filler)}。命运似乎在你耳边低语：这条路上，没有后悔药，只有下一个选择。`
  ];

  const narration = templates[Math.floor(Math.random() * templates.length)]();
  const suggestions = [
    `仔细观察周围，寻找可疑之处`,
    `尝试与最近的人物搭话`,
    `检查随身携带的物品`,
    `保持警惕，继续向前`,
    `回忆原著中关于此地的记载`
  ];
  // 演示模式模拟结构化角色状态（与前端引擎协议一致）
  const chars = (world && world.characters && world.characters.length) ? world.characters.slice(0, 2) : ['苏璃', '神秘的黑袍人'];
  const state = {
    location: (world && world.name) || '未知之地',
    present: chars,
    relations: { [(world && world.protagonist) || '你']: '命运共同体' },
    items: ['手背上的淡金印记', '一张烫金名片'],
    foreshadowing: ['海底古城的传闻', '「叛序者」之名']
  };
  return {
    narration,
    suggestions: shuffle(suggestions).slice(0, 3),
    mood: pick(['紧张', '平静', '诡谲', '激昂', '期待']),
    state
  };
}

/* 演示：记忆压缩（把近期行动拼成「故事至今」摘要） */
function mockSummarize({ world, chapterTitle, history }) {
  const acts = (history || [])
    .filter(h => h.role === 'user')
    .slice(-12)
    .map(h => h.content.slice(0, 40));
  const events = (history || [])
    .filter(h => h.role === 'ai')
    .slice(-12)
    .map(h => h.content.slice(0, 50));
  return `【故事至今 · 演示摘要】
你以「${(world && world.protagonist) || '主角'}」的身份踏入${(world && world.name) || '这个故事'}，至今已做出 ${acts.length} 次关键行动。
主要行动：${acts.length ? acts.map((a, i) => `${i + 1}. ${a}`).join('；') : '（尚无记录）'}
世界回应：${events.length ? events.slice(0, 3).join(' / ') : '风云暗涌，一切尚未明朗。'}
当前你身处「${chapterTitle || '未知章节'}」，命运的丝线正悄然收紧。`;
}

function splitSentences(text) {
  return text
    .replace(/\s+/g, '')
    .split(/(?<=[。！？…])/)
    .filter(s => s.length >= 8 && s.length <= 120)
    .slice(0, 400);
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
/* 环境描写句库：pick 轮转取用，避免每轮都出现同一句（与前端 mock-engine 保持一致） */
const AMBIENCE = [
  '风穿过空旷的街巷，卷起几片落叶',
  '远处传来钟声，沉重地敲在心上',
  '灯火在墙上投下摇曳的影子',
  '空气里浮动着说不清的躁动',
  '有什么东西在暗处轻轻移动',
  '窗外的雨下了整夜，未曾停歇',
  '人群的喧嚣忽然低了下去',
  '一盏孤灯在无人的角落亮着',
  '铁轨的震动由远及近',
  '树叶翻起背面，露出灰白的叶脉',
  '长廊尽头的门虚掩着',
  '钟表声在寂静中被无限放大',
  '楼下的脚步声停住了',
  '水面泛起细密的涟漪',
  '告示栏上的纸被风掀起一角',
  '巷口的灯笼晃了晃',
  '远处的山脊没入低垂的云',
  '有什么在暗处睁开了眼'
];
let _ambIdx = Math.floor(Math.random() * AMBIENCE.length);
function ambience() {
  const s = AMBIENCE[_ambIdx % AMBIENCE.length];
  _ambIdx++;
  return s;
}
function pick(arr) {
  const s = (arr && arr.length) ? arr[Math.floor(Math.random() * arr.length)] : ambience();
  // 统一去掉尾部标点，交由调用处拼接，避免出现「。。」
  return String(s).replace(/[。，、；：！？…\s]+$/, '');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ---------------- SSE 流式代理（OpenAI 兼容） ----------------
 * 真实模式：上游 stream:true，增量转发 delta
 * 演示模式：本地生成完整内容后分片推送，模拟打字机
 * 事件协议：{delta} 增量 → {done:true, content, usage} 结束 → {error} 失败
 */
app.post('/api/ai/stream', async (req, res) => {
  const { baseUrl, apiKey, model, messages, temperature = 0.8, maxTokens = 800, mock = false, mockBody = null } = req.body || {};

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders && res.flushHeaders();

  const send = obj => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch {} };
  // 注意：Node 18+ 中 req 的 'close' 在请求体接收完即触发，
  // 客户端是否真正离开必须监听 res 的 'close'
  let clientGone = false;
  res.on('close', () => { clientGone = true; });

  try {
    if (mock || !(baseUrl && apiKey && model)) {
      // ---- 演示模式：完整生成 + 分片假流式 ----
      const action = (mockBody && mockBody.action) || 'narrate';
      const content = action === 'summarize'
        ? mockSummarize(mockBody || {})
        : JSON.stringify(mockNarrate(mockBody || {}));
      const fakeUsage = {
        prompt_tokens: Math.ceil((JSON.stringify(messages || []).length) / 2),
        completion_tokens: Math.ceil(content.length / 2),
        mock: true
      };
      // 按 2-5 字符分片，15-35ms 间隔，模拟真实生成节奏
      let i = 0;
      while (i < content.length && !clientGone) {
        const step = 2 + Math.floor(Math.random() * 4);
        send({ delta: content.slice(i, i + step) });
        i += step;
        await sleep(15 + Math.random() * 20);
      }
      send({ done: true, content, usage: fakeUsage });
      return res.end();
    }

    // ---- 真实模式：透传上游流 ----
    const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    res.on('close', () => controller.abort());

    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true } }),
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!upstream.ok) {
      const errText = await upstream.text();
      send({ error: `上游接口错误 ${upstream.status}: ${errText.slice(0, 300)}` });
      return res.end();
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    let usage = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done || clientGone) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices && json.choices[0] && json.choices[0].delta
            ? (json.choices[0].delta.content || '') : '';
          if (delta) { full += delta; send({ delta }); }
          if (json.usage) usage = json.usage;
        } catch { /* 忽略不完整行 */ }
      }
    }
    send({ done: true, content: full, usage });
    res.end();
  } catch (e) {
    if (!clientGone) {
      send({ error: e.name === 'AbortError' ? '生成已停止或超时' : ('流式请求失败：' + e.message) });
    }
    try { res.end(); } catch {}
  }
});

/* ---------------- 前端路由兜底 ---------------- */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  📖 Playable Novel Engine 已启动`);
  console.log(`  👉 http://localhost:${PORT}\n`);
});
