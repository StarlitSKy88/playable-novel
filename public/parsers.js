/* ============================================================
 * Playable Novel · 前端解析模块
 * 全部纯浏览器实现，零依赖，file:// 直开可用
 *   1. SillyTavern 角色卡（PNG 内嵌 tEXt/iTXt JSON）
 *   2. EPUB / PDF（动态加载 CDN 解析器，失败优雅降级）
 * ============================================================ */
(function () {
  'use strict';

  /* ==========================================================
   * 一、SillyTavern 角色卡（V2 / V1 规范）
   *
   * 卡片是普通 PNG，但元数据藏在 tEXt / iTXt chunk 里：
   *   keyword = "chara"，value = base64(JSON)
   * V2: { spec:"chara_card_v2", spec_version:"2.0", data:{...} }
   * V1: 顶层直接就是字段（无 data 包装）
   * ========================================================== */

  // PNG 魔数：89 50 4E 47 0D 0A 1A 0A
  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  function isPng(bytes) {
    if (!bytes || bytes.length < 8) return false;
    for (let i = 0; i < 8; i++) {
      if (bytes[i] !== PNG_MAGIC[i]) return false;
    }
    return true;
  }

  // 遍历 PNG chunk，返回 [{type, data}]
  function readChunks(bytes) {
    const chunks = [];
    let off = 8;                       // 跳过签名
    const view = new DataView(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength);

    while (off + 8 <= bytes.length) {
      const len = view.getUint32(off);          // 4B 长度
      const type = String.fromCharCode(
        bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]
      );
      const dataStart = off + 8;
      const dataEnd = dataStart + len;
      if (len < 0 || dataEnd > bytes.length) break;

      if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
        chunks.push({ type, data: bytes.subarray(dataStart, dataEnd) });
      }
      // PNG 以 IEND 结束，遇到即停
      if (type === 'IEND') break;
      off = dataEnd + 4;                        // 跳过 CRC
    }
    return chunks;
  }

  function latin1ToBytes(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }

  function decodeLatin1(bytes) {
    let s = '';
    const CHUNK = 4096;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return s;
  }

  function utf8Decode(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    return decodeURIComponent(escape(decodeLatin1(bytes)));
  }

  function utf8Encode(str) {
    return new TextEncoder().encode(str);
  }

  // 解出 tEXt/iTXt 的 { keyword, text }
  function parseTextChunk(bytes, type) {
    try {
      if (type === 'tEXt') {
        // keyword \0 text
        const zero = bytes.indexOf(0);
        if (zero < 0) return null;
        const keyword = decodeLatin1(bytes.subarray(0, zero));
        const text = decodeLatin1(bytes.subarray(zero + 1));
        return { keyword, text };
      }
      if (type === 'zTXt') {
        // keyword \0 compressionMethod compressedText
        const zero = bytes.indexOf(0);
        if (zero < 0) return null;
        const keyword = decodeLatin1(bytes.subarray(0, zero));
        // 压缩数据需要 inflate；角色卡实际不用 zTXt，跳过
        return { keyword, text: null, compressed: true };
      }
      // iTXt: keyword \0 compressionFlag compressionMethod languageTag \0 translatedKeyword \0 text
      const z1 = bytes.indexOf(0);
      const flag = bytes[z1 + 1];
      const z2 = bytes.indexOf(0, z1 + 3);
      const z3 = bytes.indexOf(0, z2 + 1);
      if (z1 < 0 || z2 < 0 || z3 < 0) return null;
      const keyword = decodeLatin1(bytes.subarray(0, z1));
      if (flag) return { keyword, text: null, compressed: true };
      const text = utf8Decode(bytes.subarray(z3 + 1));
      return { keyword, text };
    } catch (e) {
      return null;
    }
  }

  function safeB64Decode(s) {
    try {
      const clean = String(s).replace(/\s+/g, '');
      const bin = typeof atob === 'function' ? atob(clean) : Buffer.from(clean, 'base64').toString('binary');
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return utf8Decode(bytes);
    } catch (e) {
      return null;
    }
  }

  /**
   * 从 PNG 解析角色卡
   * @returns {{name, description, personality, scenario, firstMes, mesExample, creator, tags, version}|null}
   */
  function parseCharacterCardPNG(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    if (!isPng(bytes)) return null;

    let raw = null;
    for (const c of readChunks(bytes)) {
      const parsed = parseTextChunk(c.data, c.type);
      if (!parsed) continue;
      // SillyTavern 用 "chara"；部分导出用 "ccv3"/"Chara"
      if (/^(chara|ccv3|character)$/i.test(parsed.keyword)) {
        if (parsed.compressed) continue;
        raw = parsed.text;
        break;
      }
    }
    if (!raw) return null;

    // 有的卡直接写 JSON，有的 base64(JSON)
    let obj = null;
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      try { obj = JSON.parse(trimmed); } catch (e) { obj = null; }
    } else {
      const json = safeB64Decode(trimmed);
      if (json) { try { obj = JSON.parse(json); } catch (e) { obj = null; } }
    }
    if (!obj || typeof obj !== 'object') return null;

    // 兼容 V2 的 data 包装
    const d = obj.data && typeof obj.data === 'object' ? obj.data : obj;
    const name = d.name || d.character_name || '未命名角色';
    if (!name) return null;

    return {
      name: String(name),
      description: String(d.description || ''),
      personality: String(d.personality || ''),
      scenario: String(d.scenario || ''),
      firstMes: String(d.first_mes || d.firstMes || ''),
      mesExample: String(d.mes_example || d.mesExample || ''),
      creator: String(d.creator || obj.spec || ''),
      tags: Array.isArray(d.tags) ? d.tags : (typeof d.tags === 'string' ? d.tags.split(',').map(t => t.trim()) : []),
      version: String(obj.spec_version || d.character_version || '')
    };
  }

  // 角色卡 → 世界书条目
  function characterCardToWorldbook(card) {
    const entries = [];
    const push = (type, name, content) => {
      if (content && String(content).trim()) {
        entries.push({ type, name: String(name).slice(0, 40), content: String(content).trim() });
      }
    };
    push('character', card.name, `${card.name}：${card.description || '（无描述）'}`);
    if (card.personality) push('character', `${card.name} · 性格`, card.personality);
    if (card.scenario) push('location', `${card.name} · 所处情境`, card.scenario);
    if (card.firstMes) push('rule', `${card.name} · 开场白`, card.firstMes);
    if (card.mesExample) push('rule', `${card.name} · 对话范例`, card.mesExample);
    return entries;
  }

  /* ==========================================================
   * 二、EPUB / PDF 解析（动态加载 CDN 解析器）
   *   - 文件不出浏览器，隐私最佳
   *   - CDN 不可达时降级：EPUB 自行解 zip（内置轻量 inflate）
   * ========================================================== */

  const _loaded = {};

  /** 动态加载脚本，返回 Promise */
  function loadScript(src, globalCheck) {
    if (globalCheck && window[globalCheck]) return Promise.resolve(true);
    if (_loaded[src]) return _loaded[src];
    _loaded[src] = new Promise(resolve => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
      setTimeout(() => resolve(false), 12000);   // 超时不阻塞
    });
    return _loaded[src];
  }

  /* ---------- 解压：优先用浏览器原生 DecompressionStream ---------- */
  // ZIP 的 deflate 项是 raw deflate；部分老书用 zlib 包裹，故 deflate-raw 失败后回退 deflate
  async function inflateAsync(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前浏览器不支持内置解压，请改用 Chrome 80+/Safari 16.4+/Firefox 113+');
    }
    async function tryFormat(format) {
      try {
        const ds = new DecompressionStream(format);
        const stream = new Blob([bytes]).stream().pipeThrough(ds);
        const buf = await new Response(stream).arrayBuffer();
        return new Uint8Array(buf);
      } catch (e) {
        return null;
      }
    }
    const out = (await tryFormat('deflate-raw')) || (await tryFormat('deflate'));
    if (!out) throw new Error('解压失败，文件可能已损坏或使用了不支持的压缩方式');
    return out;
  }

  /* ---------- 极简 ZIP 读取（stored + deflate，async） ---------- */
  async function readZip(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // 从尾部找 End of Central Directory
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 66000; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 EPUB/ZIP 文件');

    const count = view.getUint16(eocd + 10, true);
    let off = view.getUint32(eocd + 16, true);

    const files = [];
    for (let i = 0; i < count; i++) {
      if (view.getUint32(off, true) !== 0x02014b50) break;
      const method = view.getUint16(off + 10, true);
      const compSize = view.getUint32(off + 20, true);
      const nameLen = view.getUint16(off + 28, true);
      const extraLen = view.getUint16(off + 30, true);
      const commentLen = view.getUint16(off + 32, true);
      const localOff = view.getUint32(off + 42, true);
      const name = utf8Decode(bytes.subarray(off + 46, off + 46 + nameLen));
      files.push({ name, method, compSize, localOff });
      off += 46 + nameLen + extraLen + commentLen;
    }

    async function readOne(f) {
      if (view.getUint32(f.localOff, true) !== 0x04034b50) throw new Error('ZIP 局部头损坏');
      const nameLen = view.getUint16(f.localOff + 26, true);
      const extraLen = view.getUint16(f.localOff + 28, true);
      const start = f.localOff + 30 + nameLen + extraLen;
      const raw = bytes.subarray(start, start + f.compSize);
      if (f.method === 0) return raw;              // stored（无需解压）
      if (f.method === 8) return await inflateAsync(raw);
      throw new Error('不支持的压缩方式：' + f.method);
    }

    return { files, read: readOne };
  }

  function htmlToText(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,nav,svg').forEach(n => n.remove());
    // 块级元素之间补换行，避免段落粘连
    doc.querySelectorAll('p,div,br,h1,h2,h3,h4,h5,h6,li,section,blockquote').forEach(n => {
      n.appendChild(doc.createTextNode('\n'));
    });
    return (doc.body ? doc.body.textContent : doc.documentElement.textContent)
      .replace(/\r/g, '')
      .replace(/[ \t ]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** 解析 EPUB → { title, text } */
  async function parseEpub(arrayBuffer) {
    const zip = await readZip(arrayBuffer);
    const find = re => zip.files.find(f => re.test(f.name));

    // 1. 定位 OPF：优先读 container.xml，其次直接找 .opf
    let title = '';
    let opfName = '';
    const containerFile = zip.files.find(f => f.name === 'META-INF/container.xml');
    if (containerFile) {
      const containerXml = utf8Decode(await zip.read(containerFile));
      const m = containerXml.match(/full-path="([^"]+\.opf)"/i);
      if (m) opfName = m[1];
    }
    if (!opfName) {
      const anyOpf = find(/\.opf$/i);
      opfName = anyOpf ? anyOpf.name : '';
    }
    if (!opfName) throw new Error('EPUB 结构异常：找不到 OPF');

    const opf = utf8Decode(await zip.read(zip.files.find(f => f.name === opfName)));
    const titleMatch = opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i);
    if (titleMatch) title = htmlToText(titleMatch[1]).trim();

    // spine: itemref 的 idref → manifest 的 href
    const manifest = {};
    const mRe = /<item\b[^>]*>/gi;
    let m;
    while ((m = mRe.exec(opf)) !== null) {
      const tag = m[0];
      const id = (tag.match(/id="([^"]+)"/i) || [])[1];
      const href = (tag.match(/href="([^"]+)"/i) || [])[1];
      const mt = (tag.match(/media-type="([^"]+)"/i) || [])[1] || '';
      if (id && href) manifest[id] = { href, mediaType: mt };
    }
    const order = [];
    const sRe = /<itemref\b[^>]*>/gi;
    while ((m = sRe.exec(opf)) !== null) {
      const id = (m[0].match(/idref="([^"]+)"/i) || [])[1];
      if (id && manifest[id]) order.push(manifest[id].href);
    }
    if (!order.length) {
      // 退化：所有 xhtml
      zip.files.filter(f => /\.x?html?$/i.test(f.name)).forEach(f => order.push(f.name));
    }

    const baseDir = opfName.includes('/') ? opfName.slice(0, opfName.lastIndexOf('/') + 1) : '';
    const textParts = [];
    for (const href of order) {
      let path = baseDir + href;
      // 处理 ./ 与 ../ 简化
      path = path.replace(/\.\//g, '').replace(/[^/]+\/\.\.\//g, '');
      let f = zip.files.find(x => x.name === path)
           || zip.files.find(x => x.name.endsWith(path))
           || zip.files.find(x => x.name.toLowerCase().endsWith(href.replace(/^\.\//, '').toLowerCase()));
      if (!f) continue;
      try {
        const t = htmlToText(utf8Decode(await zip.read(f)));
        if (t) textParts.push(t);
      } catch (e) { /* 单章失败不中断 */ }
    }
    if (!textParts.length) throw new Error('EPUB 未提取到正文');
    return { title: title || '未命名电子书', text: textParts.join('\n\n') };
  }

  /** 解析 PDF → { title, text } */
  async function parsePdf(arrayBuffer) {
    const ok = await loadScript(
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
      'pdfjsLib'
    );
    if (!ok || !window.pdfjsLib) throw new Error('PDF 解析库加载失败，请检查网络后重试');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    const doc = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const maxPages = Math.min(doc.numPages, 300);
    const parts = [];
    let metaTitle = '';
    try {
      const m = await doc.getMetadata();
      if (m && m.info && m.info.Title) metaTitle = String(m.info.Title).trim();
    } catch (e) { /* 部分 PDF 无元数据 */ }

    for (let i = 1; i <= maxPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let line = '', lastY = null;
      for (const item of tc.items) {
        if (lastY !== null && Math.abs(item.transform[5] - lastY) > 3) {
          parts.push(line); line = '';
        }
        line += item.str;
        lastY = item.transform[5];
      }
      if (line) parts.push(line);
      page.cleanup();
    }
    const text = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) throw new Error('这份 PDF 没有可提取的文字层（可能是扫描版，需要 OCR）');
    return { title: metaTitle || '未命名 PDF', text };
  }

  /* ==========================================================
   * 三、原著语言检测
   * ========================================================== */

  /**
   * 检测文本主语言
   * @returns {{code:'zh'|'en'|'ja'|'ko'|'ru'|'other', label, ratio}}
   */
  function detectLanguage(text) {
    const s = String(text || '').slice(0, 20000);
    if (!s.trim()) return { code: 'other', label: '未知', ratio: 0 };

    const counts = {
      zh: 0, ja: 0, ko: 0, en: 0, ru: 0
    };
    let cjk = 0;
    for (const ch of s) {
      const c = ch.codePointAt(0);
      // 中日韩统一表意文字
      if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) cjk++;
      else if (c >= 0x3040 && c <= 0x30ff) counts.ja++;          // 平假名/片假名
      else if (c >= 0xac00 && c <= 0xd7af) counts.ko++;          // 谚文
      else if (c >= 0x0400 && c <= 0x04ff) counts.ru++;
      else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) counts.en++;
    }
    if (cjk) counts.zh = cjk;

    // 假名存在 → 日语（汉字多但有假名 = 日文小说）
    const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
    let code = 'other', best = 0;
    for (const k of Object.keys(counts)) {
      if (counts[k] > best) { best = counts[k]; code = k; }
    }
    if (counts.ja > 20 && counts.ja > counts.zh * 0.05) code = 'ja';

    const LABELS = {
      zh: '中文', ja: '日文', ko: '韩文',
      en: '英文', ru: '俄文', other: '其他'
    };
    return { code, label: LABELS[code] || '其他', ratio: +(best / total).toFixed(2) };
  }

  /** 输出语言选项 */
  const OUTPUT_LANGS = [
    { code: 'auto', label: '跟随原著（自动）' },
    { code: 'zh', label: '中文' },
    { code: 'en', label: 'English' },
    { code: 'ja', label: '日本語' },
    { code: 'ko', label: '한국어' }
  ];

  /** 生成语言约束提示（注入 prompt） */
  function languageInstruction(sourceLang, outputLang) {
    if (!outputLang || outputLang === 'auto') {
      if (sourceLang === 'en') return '【输出语言】请用英文输出剧情（原著为英文）。';
      if (sourceLang === 'ja') return '【输出语言】请用日文输出剧情（原著为日文）。';
      if (sourceLang === 'ko') return '【输出语言】请用韩文输出剧情（原著为韩文）。';
      return '【输出语言】请用中文输出剧情。';
    }
    const NAMES = { zh: '简体中文', en: 'English', ja: '日本語', ko: '한국어' };
    return `【输出语言】请用 ${NAMES[outputLang] || '中文'} 输出剧情——即使原著是其他语言，也请翻译后再叙述，专有名词保留原文并附括号说明。`;
  }

  window.PNParser = {
    parseCharacterCardPNG,
    characterCardToWorldbook,
    parseEpub,
    parsePdf,
    detectLanguage,
    languageInstruction,
    OUTPUT_LANGS
  };
})();