/* ============================================================
 * Playable Novel Engine · 前端演示引擎
 * server.js 演示模式逻辑的完整移植。
 * 用途：下载 index.html 后无 Node 后端也能零配置体验全流程；
 *      也可作为静态托管（GitHub Pages 等）的兜底生成器。
 * 暴露全局 MockEngine.narrate / MockEngine.summarize
 * ============================================================ */
(function () {
  'use strict';

  function splitSentences(text) {
    return String(text || '')
      .replace(/\s+/g, '')
      .split(/(?<=[。！？…])/)
      .filter(s => s.length >= 8 && s.length <= 120)
      .slice(0, 400);
  }
  function shuffle(arr) {
    const a = (arr || []).slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  /* 环境描写句库：pick 轮转取用，避免每轮都出现同一句 */
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
    // 候选为空或与原文无关时，用轮转的环境描写句兜底，保证每轮不重复
    const s = (arr && arr.length) ? arr[Math.floor(Math.random() * arr.length)] : ambience();
    // 统一去掉尾部标点，交由调用处拼接，避免出现「。。」
    return String(s).replace(/[。，、；：！？…\s]+$/, '');
  }

  /* ---- 剧情续写（返回 JSON 字符串，与后端协议一致） ---- */
  function narrate(body) {
    const { context, world, userInput, chapterTitle } = body || {};
    const sentences = splitSentences(context && context.text);

    const keywords = String(userInput || '').replace(/[，。！？、,.!?]/g, ' ').split(/\s+/).filter(w => w.length >= 2);
    let best = [];
    if (keywords.length) {
      best = sentences
        .map(s => ({ s, score: keywords.reduce((acc, k) => acc + (s.includes(k) ? 1 : 0), 0) }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(x => x.s);
    }
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
    const suggestions = shuffle([
      '仔细观察周围，寻找可疑之处',
      '尝试与最近的人物搭话',
      '检查随身携带的物品',
      '保持警惕，继续向前',
      '回忆原著中关于此地的记载'
    ]).slice(0, 3);

    // 演示模式模拟结构化角色状态
    const present = (world && world.characters && world.characters.length)
      ? world.characters.slice(0, 2)
      : ['苏璃', '神秘的黑袍人'];
    const state = {
      location: (world && world.name) || '未知之地',
      present,
      relations: { [(world && world.protagonist) || '你']: '命运共同体' },
      items: ['手背上的淡金印记', '一张烫金名片'],
      foreshadowing: ['海底古城的传闻', '「叛序者」之名']
    };

    return JSON.stringify({
      narration,
      suggestions,
      mood: pick(['紧张', '平静', '诡谲', '激昂', '期待']),
      state
    });
  }

  /* ---- 记忆压缩摘要（返回纯文本） ---- */
  function summarize(body) {
    const { world, chapterTitle, history } = body || {};
    const acts = (history || []).filter(h => h.role === 'user').slice(-12).map(h => h.content.slice(0, 40));
    const events = (history || []).filter(h => h.role === 'ai').slice(-12).map(h => h.content.slice(0, 50));
    return `【故事至今 · 演示摘要】
你以「${(world && world.protagonist) || '主角'}」的身份踏入${(world && world.name) || '这个故事'}，至今已做出 ${acts.length} 次关键行动。
主要行动：${acts.length ? acts.map((a, i) => `${i + 1}. ${a}`).join('；') : '（尚无记录）'}
世界回应：${events.length ? events.slice(0, 3).join(' / ') : '风云暗涌，一切尚未明朗。'}
当前你身处「${chapterTitle || '未知章节'}」，命运的丝线正悄然收紧。`;
  }

  /* ---- 章节切分（本地模式，逻辑与后端 /api/novel/split 一致） ---- */
  function splitNovel(text) {
    const raw = String(text || '').replace(/\r\n/g, '\n');
    if (raw.trim().length < 50) throw new Error('文本太短或为空，至少需要 50 个字符');
    // 匹配常见章节标题：第1章 / 第一章 / Chapter 1 / 第001章 / 序章 / 终章
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
        chapters.push({ id: chapters.length, title: `片段 ${chapters.length + 1}`, text: raw.slice(i, i + size).trim() });
      }
    }
    // 跳过章节标题行，避免把章节名当书名
    const CH_TITLE = /^(第[0-9零一二三四五六七八九十百千]{1,9}[章回节卷部]|Chapter\s+\d+|序章|序子|终章|尾声|后记)/i;
    const firstLine = raw.split('\n')
      .map(s => s.trim())
      .find(s => s.length > 1 && s.length < 40 && !CH_TITLE.test(s));
    return {
      title: firstLine || '未命名小说',
      totalChapters: chapters.length,
      totalChars: raw.length,
      chapters: chapters.slice(0, 60).map(c => ({
        id: c.id,
        title: c.title,
        preview: c.text.replace(/\s+/g, ' ').slice(0, 120),
        length: c.text.length
      })),
      chapterTexts: chapters.map(c => c.text)
    };
  }

  window.MockEngine = { narrate, summarize, splitNovel, splitSentences };
})();
