/**
 * parsers.js 单元测试（Node 环境，模拟浏览器 API）
 * 验证：角色卡 PNG 解析 / EPUB(zip+inflate) 解析 / 语言检测
 */
const fs = require('fs');
const zlib = require('zlib');
const { execSync } = require('child_process');

// ---------- 最小浏览器 API shim ----------
global.window = {};
global.atob = s => Buffer.from(s, 'base64').toString('binary');
global.TextEncoder = require('util').TextEncoder;
global.TextDecoder = require('util').TextDecoder;

// DOMParser shim：足够用于 EPUB 的 HTML→Text
global.DOMParser = class {
  parseFromString(html) {
    let s = html
      .replace(/<(script|style|nav|svg)[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');
    s = s.replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|li|section|blockquote)>/gi, '\n')
         .replace(/<br\s*\/?>/gi, '\n')
         .replace(/<[^>]+>/g, '');
    s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
         .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
         .replace(/&#39;/g, "'");
    const noop = () => {};
    return {
      body: { textContent: s },
      documentElement: { textContent: s },
      // htmlToText 会调用这两个，纯 shim
      querySelectorAll: () => ({ forEach: noop })
    };
  }
};
global.Blob = require('buffer').Blob;
global.Response = class {
  constructor(stream) { this.stream = stream; }
  async arrayBuffer() {
    const chunks = [];
    const reader = this.stream.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out.buffer;
  }
};

eval(fs.readFileSync(__dirname + '/../public/parsers.js', 'utf8'));
const P = global.window.PNParser;

(async () => {
let pass = 0, fail = 0;
const pending = [];
function t(name, fn) {
  const r = fn();
  if (r && typeof r.then === 'function') {
    pending.push(r.then(
      v => { if (v === true || v === undefined) { pass++; console.log('  ✅ ' + name); } else { fail++; console.log('  ❌ ' + name + ' — ' + v); } },
      e => { fail++; console.log('  ❌ ' + name + ' — ' + e.message); }
    ));
    return;
  }
  if (r === true || r === undefined) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + ' — ' + r); }
}

/* ========== 1. 构造真实角色卡 PNG（含 tEXt chunk） ========== */
function makeCharCardPNG() {
  const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '苏璃',
      description: '星海学院监察会成员，银色短发灰眸，寡言冷淡',
      personality: '外冷内热，责任心极强',
      scenario: '悬浮在云海之上的魔法学院，新生入学当天',
      first_mes: '"终于醒了？"她抱剑立在窗前，灰眸冷冷扫过来。',
      mes_example: '<START>\n{{user}}: 你在等人？\n{{char}}: 我在等一个不会回来的人。',
      tags: ['奇幻', '冷面', '学院'],
      character_version: '1.2'
    }
  };
  const b64 = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');
  const keyword = Buffer.from('chara', 'latin1');

  const tEXtData = Buffer.concat([keyword, Buffer.from([0]), Buffer.from(b64, 'latin1')]);

  // 构造 CRC32
  const table = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

  // PNG chunk 结构：[length(4B)][type(4B)][data][crc(4B)]
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  function makeChunk(type, data) {
    const t = Buffer.from(type, 'latin1');
    const l = Buffer.alloc(4); l.writeUInt32BE(data.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([l, t, data, c]);
  }

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0); ihdrData.writeUInt32BE(1, 4);
  ihdrData[8] = 8; ihdrData[9] = 6;   // 8bit RGBA

  const ihdr = makeChunk('IHDR', ihdrData);
  const tEXt = makeChunk('tEXt', tEXtData);
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, tEXt, iend]);
}

console.log('\n▸ 角色卡解析（SillyTavern V2 PNG）');
const pngBuf = makeCharCardPNG();
fs.writeFileSync('/tmp/test-card.png', pngBuf);
const pngBuf2 = Buffer.from(pngBuf);   // 复制成独立 ArrayBuffer
const card = P.parseCharacterCardPNG(pngBuf2.buffer.slice(pngBuf2.byteOffset, pngBuf2.byteOffset + pngBuf2.byteLength));

t('识别 PNG 并解析角色卡', () => card ? true : '返回 null');
t('角色名 = 苏璃', () => (card && card.name === '苏璃') || ('got: ' + (card && card.name)));
t('描述含关键信息', () => (card && card.description.includes('监察会')) || ('got: ' + (card && card.description)));
t('性格字段', () => (card && card.personality.includes('外冷内热')) || 'mismatch');
t('开场白', () => (card && card.firstMes.includes('终于醒了')) || 'mismatch');
t('标签数组', () => (card && Array.isArray(card.tags) && card.tags.includes('奇幻')) || JSON.stringify(card && card.tags));
t('spec 识别为 V2', () => (card && card.creator.includes('chara_card_v2')) || ('got: ' + (card && card.creator)));

t('转为世界书条目(≥4)', () => {
  const wb = P.characterCardToWorldbook(card);
  return wb.length >= 4 || ('got ' + wb.length);
});
t('非 PNG 返回 null', () => P.parseCharacterCardPNG(new Uint8Array([1,2,3,4,5,6,7,8,9,10]).buffer) === null || 'should be null');

console.log('\n▸ EPUB 解析（zip + 原生 DecompressionStream）');
const epubBuf = fs.readFileSync('/tmp/test-book.epub');
const epubBuf2 = Buffer.from(epubBuf);
const epub = await P.parseEpub(epubBuf2.buffer.slice(epubBuf2.byteOffset, epubBuf2.byteOffset + epubBuf2.byteLength));

t('提取标题', () => (epub.title === '星海测试集') || ('got: ' + epub.title));
t('提取两章正文', () => (epub.text.includes('第一章 测试') && epub.text.includes('第二章 继续')) || ('got: ' + epub.text.slice(0, 80)));
t('正文无 HTML 标签残留', () => !/<[a-z\/]/i.test(epub.text) || ('残留: ' + epub.text.slice(0, 60)));
t('正文长度合理', () => (epub.text.length >= 60) || ('got ' + epub.text.length));

console.log('\n▸ 语言检测');
t('中文 → zh', () => P.detectLanguage('这是一段中文小说内容，人物在学院中走动').code === 'zh' || P.detectLanguage('这是一段中文小说内容，人物在学院中走动').code);
t('英文 → en', () => P.detectLanguage('This is an English novel passage with many latin words').code === 'en' || P.detectLanguage('This is an English novel passage').code);
t('日文（含假名）→ ja', () => P.detectLanguage('これは日本語の小説です。主人公は学校に行きました。') .code === 'ja' || P.detectLanguage('これは日本語です').code);
t('语言指令 auto 中文', () => P.languageInstruction('zh', 'auto').includes('中文') || 'mismatch');
t('语言指令强制英文', () => P.languageInstruction('zh', 'en').includes('English') || 'mismatch');
t('语言选项含 5 项', () => P.OUTPUT_LANGS.length === 5 || ('got ' + P.OUTPUT_LANGS.length));

console.log('\n' + '='.repeat(40));
await Promise.all(pending);
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
})();