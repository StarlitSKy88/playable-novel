/* 小红书小工具 · 本地全流程 e2e（file:// 离线运行，断言零网络请求） */
const puppeteer = require("puppeteer-core");
const path = require("path");

const URL = "file://" + path.join(__dirname, "src/index.html");

let pass = 0, fail = 0;
function check(id, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${id} — ${detail || ""}`); }
  else { fail++; console.log(`  ❌ ${id} — ${detail || ""}`); }
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu"]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });

  const errors = [];
  const netCalls = [];
  page.on("pageerror", e => errors.push(String(e.message)));
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("request", r => netCalls.push(r.url()));

  // 监听任何 fetch 尝试（file:// 下本就不该有）
  await page.evaluateOnNewDocument(() => {
    window.__fetchCalls = 0;
    const orig = window.fetch;
    window.fetch = function () { window.__fetchCalls++; if (orig) return orig.apply(this, arguments); };
  });

  await page.goto(URL, { waitUntil: "load" });
  await new Promise(r => setTimeout(r, 400));

  /* ---------- 1. 封面 ---------- */
  const cover = await page.evaluate(() => ({
    view: document.getElementById("view-cover").classList.contains("on"),
    title: document.querySelector(".h1") ? document.querySelector(".h1").textContent.trim() : "",
    continueHidden: document.getElementById("btnContinue").style.display === "none",
    stats: [...document.querySelectorAll(".cover .stat b")].map(e => e.textContent)
  }));
  check("BOOT-1", cover.view, "封面为首屏");
  check("BOOT-2", /能走进去的世界/.test(cover.title), cover.title.slice(0, 30));
  check("BOOT-3", cover.continueHidden, "无进度时隐藏「继续」");
  check("BOOT-4", cover.stats.join("/") === "4/5/2", `统计 ${cover.stats.join("/")}`);

  /* ---------- 2. 世界卡片 ---------- */
  await page.click("#btnStart");
  await new Promise(r => setTimeout(r, 350));
  const world = await page.evaluate(() => ({
    on: document.getElementById("view-world").classList.contains("on"),
    name: document.getElementById("wName").textContent,
    premise: document.getElementById("wPremise").textContent.length,
    powers: document.getElementById("wPowers").children.length,
    factions: document.getElementById("wFactions").children.length
  }));
  check("WORLD-1", world.on, "世界卡片视图");
  check("WORLD-2", world.name === "星海学院" && world.premise > 20, `${world.name} · 设定 ${world.premise} 字`);
  check("WORLD-3", world.powers === 3 && world.factions === 3, `力量 ${world.powers} · 势力 ${world.factions}`);

  /* ---------- 3. 身份选择 ---------- */
  await page.click("#btnToRole");
  await new Promise(r => setTimeout(r, 300));
  const roles = await page.evaluate(() =>
    [...document.querySelectorAll("#roleList .role")].map(e => e.querySelector("b").textContent));
  check("ROLE-1", roles.length === 2 && roles.includes("林辰") && roles.includes("苏璃"), roles.join(" / "));

  /* ---------- 工具：揭示段落直到出现选项，再点第 idx 个选项 ---------- */
  async function tapUntilChoices() {
    for (let i = 0; i < 40; i++) {
      const has = await page.evaluate(() =>
        document.getElementById("choices").children.length > 0 &&
        document.getElementById("choices").children[0].getBoundingClientRect().height > 0);
      if (has) return true;
      await page.evaluate(() => document.getElementById("storyScroll").click());
      await new Promise(r => setTimeout(r, 90));
    }
    return false;
  }
  async function pick(idx) {
    await page.evaluate(i => {
      const c = document.getElementById("choices").children[i];
      if (c) c.click();
    }, idx);
    await new Promise(r => setTimeout(r, 200));
  }
  async function clueCount() {
    return page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("pn_xhs_save_v1") || "{}");
      return (s.clues || []).length;
    });
  }

  /* ---------- 4. 林辰线：一路点第一个选项 → 结局一 ---------- */
  await page.evaluate(() => document.querySelectorAll("#roleList .role")[0].click());
  await new Promise(r => setTimeout(r, 300));
  let guard = 0, reachedEnd = false;
  while (guard++ < 60) {
    const isEnd = await page.evaluate(() => document.getElementById("view-ending").classList.contains("on"));
    if (isEnd) { reachedEnd = true; break; }
    if (!await tapUntilChoices()) break;
    await pick(0);
  }
  check("PLAY-1", reachedEnd, "一路点选可走到结局");
  await new Promise(r => setTimeout(r, 2200));
  const end1 = await page.evaluate(() => ({
    no: document.getElementById("endNo").textContent,
    title: document.getElementById("endTitle").textContent,
    progress: document.getElementById("endProgress").textContent,
    paras: document.getElementById("endText").children.length,
    revealed: [...document.getElementById("endText").children].filter(p => p.classList.contains("on")).length
  }));
  check("PLAY-2", /结局一/.test(end1.no) && end1.title.length > 0, `${end1.no} · ${end1.title}`);
  check("PLAY-3", end1.paras >= 4, `结局正文 ${end1.paras} 段`);
  check("PLAY-4", end1.revealed >= 1, `已浮现 ${end1.revealed} 段`);
  check("PLAY-5", /已解锁 1 \/ 4/.test(end1.progress), end1.progress);
  const clueAfterRunA = await clueCount();
  check("PLAY-6", clueAfterRunA >= 2, `本局收集线索 ${clueAfterRunA} 条`);

  /* ---------- 5. 回溯：再走一次，中途回溯一步 ---------- */
  await page.click("#btnAgain");
  await new Promise(r => setTimeout(r, 350));
  const storyBack = await page.evaluate(() => document.getElementById("view-story").classList.contains("on"));
  check("UNDO-1", storyBack, "「再走一次」回到故事");
  await tapUntilChoices();
  const beforeUndo = await page.evaluate(() => ({
    undoDisabled: document.getElementById("btnUndo").disabled,
    node: (JSON.parse(localStorage.getItem("pn_xhs_save_v1") || "{}")).node
  }));
  check("UNDO-2", beforeUndo.undoDisabled === true, "新开一局无历史时回溯禁用（符合预期）");
  await pick(0);
  await new Promise(r => setTimeout(r, 200));
  const afterPick = await page.evaluate(() => ({
    undoDisabled: document.getElementById("btnUndo").disabled,
    node: (JSON.parse(localStorage.getItem("pn_xhs_save_v1") || "{}")).node
  }));
  check("UNDO-2b", afterPick.undoDisabled === false, "走过一步后回溯可用");
  await page.click("#btnUndo");
  await new Promise(r => setTimeout(r, 250));
  const afterUndo = await page.evaluate(() => ({
    node: (JSON.parse(localStorage.getItem("pn_xhs_save_v1") || "{}")).node,
    inStory: document.getElementById("view-story").classList.contains("on")
  }));
  check("UNDO-3", afterUndo.node === beforeUndo.node && afterUndo.inStory, `回溯到 ${afterUndo.node}`);

  /* ---------- 6. 图鉴 ---------- */
  await page.evaluate(() => document.getElementById("btnClues").click());
  await new Promise(r => setTimeout(r, 300));
  const codex = await page.evaluate(() => ({
    on: document.getElementById("view-codex").classList.contains("on"),
    endings: document.querySelectorAll("#codexList .codex-item").length,
    got: document.querySelectorAll("#codexList .codex-item.got").length,
    clues: document.querySelectorAll("#clueList .clue-row").length,
    note: document.getElementById("codexNote").textContent
  }));
  check("CODEX-1", codex.on, "图鉴视图");
  check("CODEX-2", codex.endings === 4, `结局条目 ${codex.endings}`);
  check("CODEX-3", codex.got === 1, `已解锁 ${codex.got}`);
  check("CODEX-4", codex.clues === 5, `线索条目 ${codex.clues}`);
  check("CODEX-5", /集齐|已收集/.test(codex.note), codex.note);

  /* ---------- 7. 苏璃线 + 隐藏结局（集齐 5 条线索的固定路径） ---------- */
  await page.evaluate(() => {
    localStorage.removeItem("pn_xhs_save_v1");
    document.getElementById("btnBack").click();
  });
  await new Promise(r => setTimeout(r, 300));
  await page.click("#btnStart");
  await new Promise(r => setTimeout(r, 250));
  await page.click("#btnToRole");
  await new Promise(r => setTimeout(r, 250));
  // 苏璃线集齐 5 线索：登记印记(mark) → 看测验(rune) → 追黑袍人(card) → 地下三层(note) → 问父亲(file) → 终章隐藏项
  await page.evaluate(() => document.querySelectorAll("#roleList .role")[1].click());
  await new Promise(r => setTimeout(r, 250));
  const script = [0, 2, 0, 0, 0]; // sl_register→sl_watch→sl_chase→lib_go→meet_edrian→edrian_father
  let guard2 = 0, reachedEnd2 = false, hiddenSeen = false;
  while (guard2++ < 80) {
    const isEnd = await page.evaluate(() => document.getElementById("view-ending").classList.contains("on"));
    if (isEnd) { reachedEnd2 = true; break; }
    if (!await tapUntilChoices()) break;
    // 在终章检查隐藏选项是否出现
    const chTexts = await page.evaluate(() =>
      [...document.getElementById("choices").children].map(e => e.textContent));
    if (chTexts.some(t => /念出父亲笔记/.test(t))) hiddenSeen = true;
    const node = await page.evaluate(() =>
      (JSON.parse(localStorage.getItem("pn_xhs_save_v1") || "{}")).node);
    if (node === "final_gate") {
      const idx = chTexts.findIndex(t => /念出父亲笔记/.test(t));
      if (idx >= 0) { await pick(idx); continue; }
    }
    await pick(script.length ? script.shift() : 0);
  }
  const cluesB = await clueCount();
  check("HIDDEN-1", cluesB === 5, `苏璃线收集线索 ${cluesB}/5`);
  check("HIDDEN-2", hiddenSeen, "终章出现隐藏选项");
  check("HIDDEN-3", reachedEnd2, "走到结局");
  await new Promise(r => setTimeout(r, 2500));
  const end2 = await page.evaluate(() => ({
    title: document.getElementById("endTitle").textContent,
    progress: document.getElementById("endProgress").textContent
  }));
  check("HIDDEN-4", end2.title === "守印者", `隐藏结局：${end2.title}`);
  check("HIDDEN-5", /已解锁 2 \/ 4/.test(end2.progress), end2.progress);

  /* ---------- 8. 持久化与继续 ---------- */
  await page.reload({ waitUntil: "load" });
  await new Promise(r => setTimeout(r, 400));
  const afterReload = await page.evaluate(() => ({
    continueVisible: document.getElementById("btnContinue").style.display !== "none",
    codexGot: JSON.parse(localStorage.getItem("pn_xhs_save_v1") || "{}").endings.length
  }));
  check("SAVE-1", afterReload.codexGot === 2, `刷新后已解锁结局 ${afterReload.codexGot} 个`);

  /* ---------- 9. 离线与异常 ---------- */
  const net = await page.evaluate(() => window.__fetchCalls);
  check("NET-1", net === 0, `fetch 调用 ${net} 次`);
  check("NET-2", netCalls.filter(u => u.startsWith("http")).length === 0,
    `外部请求 ${netCalls.filter(u => u.startsWith("http")).length} 个`);
  check("ERR-1", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log(`\n${fail === 0 ? "✅" : "❌"} 小工具 e2e：${pass} 通过 / ${fail} 失败`);
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})();
