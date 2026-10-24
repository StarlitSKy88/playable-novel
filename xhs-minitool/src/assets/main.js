/* ============================================================
 * 星海学院的转学生 · 小红书小工具主逻辑
 * 纯本地运行：不联网、不调模型、无外部依赖。
 * 约束：脚本外置、事件全部 addEventListener 绑定。
 * ============================================================ */
(function () {
  "use strict";

  var SAVE_KEY = "pn_xhs_save_v1";

  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- 状态 ---------------- */
  var state = {
    role: null,      // 当前身份 id
    node: null,      // 当前节点 id
    seen: 0,         // 已揭示段落数
    trail: [],       // 回溯栈：[{ node, seen }]
    clues: [],       // 已收集线索
    endings: []      // 已解锁结局
  };

  var endTimer = null;

  /* ---------------- 存档 ---------------- */
  function loadSave() {
    try {
      var raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || typeof s !== "object") return null;
      return s;
    } catch (e) { return null; }
  }
  function persist() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        role: state.role,
        node: state.node,
        seen: state.seen,
        trail: state.trail,
        clues: state.clues,
        endings: state.endings
      }));
    } catch (e) { /* 隐私模式下忽略 */ }
  }
  function applySave(s) {
    state.role = s.role || null;
    state.node = s.node || null;
    state.seen = Number(s.seen) || 0;
    state.trail = Array.isArray(s.trail) ? s.trail : [];
    state.clues = Array.isArray(s.clues) ? s.clues : [];
    state.endings = Array.isArray(s.endings) ? s.endings : [];
  }
  function clearRun() {
    state.role = null;
    state.node = null;
    state.seen = 0;
    state.trail = [];
    persist();
  }

  /* ---------------- 视图 ---------------- */
  var VIEWS = ["cover", "world", "role", "story", "ending", "codex"];
  function show(name) {
    VIEWS.forEach(function (v) {
      var el = $("view-" + v);
      if (el) el.classList.toggle("on", v === name);
    });
    var top = $("btnCodexTop");
    if (top) top.textContent = name === "codex" ? "返回" : "图鉴";
    if (name !== "story") stopEndTimer();
  }

  /* ---------------- 工具 ---------------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function hasClue(id) { return state.clues.indexOf(id) >= 0; }
  function currentRole() {
    for (var i = 0; i < STORY.roles.length; i++) {
      if (STORY.roles[i].id === state.role) return STORY.roles[i];
    }
    return null;
  }

  /* ---------------- 线索提示 ---------------- */
  var toastTimer = null;
  function toastClue(id) {
    var c = STORY.clues[id];
    if (!c) return;
    $("toastName").textContent = "获得线索 · " + c.name;
    $("toastDesc").textContent = c.desc;
    var t = $("clueToast");
    t.classList.add("on");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("on"); }, 2600);
  }

  /* ---------------- 世界卡片 ---------------- */
  function renderWorld() {
    var w = STORY.world;
    $("wName").textContent = w.name;
    $("wType").textContent = w.type;
    $("wPremise").textContent = w.premise;

    var pw = $("wPowers");
    pw.textContent = "";
    w.powers.forEach(function (p) {
      var row = el("div", null);
      row.appendChild(el("b", null, p.k + "：")).style.color = "var(--gold)";
      row.appendChild(document.createTextNode(p.v));
      row.style.marginBottom = "6px";
      pw.appendChild(row);
    });

    var fw = $("wFactions");
    fw.textContent = "";
    w.factions.forEach(function (f) {
      var row = el("div", null);
      row.appendChild(el("b", null, f.k + "：")).style.color = "var(--gold)";
      row.appendChild(document.createTextNode(f.v));
      row.style.marginBottom = "6px";
      fw.appendChild(row);
    });

    $("wCrisis").textContent = w.crisis;
  }

  /* ---------------- 身份选择 ---------------- */
  function renderRoles() {
    var wrap = $("roleList");
    wrap.textContent = "";
    STORY.roles.forEach(function (r) {
      var b = el("button", "role");
      b.type = "button";
      var rn = el("div", "rn");
      rn.appendChild(el("span", "dot"));
      rn.appendChild(el("b", null, r.name));
      rn.appendChild(el("span", null, r.tag));
      b.appendChild(rn);
      b.appendChild(el("div", "rd", r.desc));
      b.addEventListener("click", function () {
        state.role = r.id;
        state.node = r.start;
        state.seen = 0;
        state.trail = [];
        persist();
        renderNode();
        show("story");
      });
      wrap.appendChild(b);
    });
  }

  /* ---------------- 故事节点 ---------------- */
  function renderNode() {
    var node = STORY.nodes[state.node];
    if (!node) { show("cover"); return; }

    // 结局节点
    if (node.ending) { renderEnding(node.ending); return; }

    // 身份选择节点
    if (node.isRole) { show("role"); renderRoles(); return; }

    $("storyCh").textContent = node.ch || "";
    updateUndoBtn();

    // 节点级线索：进入该节点即「发现」（铭文/名片/笔记/档案），与选项无关
    if (node.clue && !hasClue(node.clue)) {
      state.clues.push(node.clue);
      toastClue(node.clue);
    }

    var passage = $("passage");
    passage.textContent = "";
    (node.text || []).forEach(function (p) {
      passage.appendChild(el("p", null, p));
    });

    state.seen = Math.min(state.seen, (node.text || []).length);
    // 进入节点即自动浮现第一段，避免首屏空无一字
    if (state.seen === 0 && (node.text || []).length > 0) state.seen = 1;
    revealUpTo(state.seen);

    var choices = $("choices");
    choices.textContent = "";
    if (state.seen >= (node.text || []).length) renderChoices(node);

    $("tapHint").style.display = (state.seen < (node.text || []).length) ? "block" : "none";
    var sc = $("storyScroll");
    if (sc) sc.scrollTop = 0;
    persist();
  }

  function updateUndoBtn() {
    var b = $("btnUndo");
    if (b) b.disabled = state.trail.length === 0;
  }

  function revealUpTo(n) {
    var ps = $("passage").children;
    for (var i = 0; i < ps.length; i++) {
      if (i < n) ps[i].classList.add("on");
      else ps[i].classList.remove("on");
    }
  }

  function renderChoices(node) {
    var wrap = $("choices");
    wrap.textContent = "";
    (node.choices || []).forEach(function (c, i) {
      // 需要线索的选项：未集齐时不出现（隐藏结局）
      if (c.need && !c.need.every(hasClue)) return;

      var b = el("button", "choice" + (c.need ? " hidden-choice" : ""));
      b.type = "button";
      b.style.animationDelay = (i * 60) + "ms";
      b.appendChild(el("span", "ci", String(i + 1)));
      b.appendChild(el("span", null, c.t));
      b.addEventListener("click", function () { go(c); });
      wrap.appendChild(b);
    });
    $("tapHint").style.display = "none";
  }

  function go(c) {
    if (!c || !c.to) return;
    // 记录回溯点
    state.trail.push({ node: state.node, seen: state.seen });
    if (state.trail.length > 40) state.trail.shift();
    state.node = c.to;
    state.seen = 0;
    renderNode();
    // 获得线索
    if (c.clue && !hasClue(c.clue)) {
      state.clues.push(c.clue);
      toastClue(c.clue);
      persist();
    }
  }

  function undo() {
    var last = state.trail.pop();
    if (!last) return;
    state.node = last.node;
    state.seen = last.seen;
    renderNode();
  }

  /* ---------------- 结局 ---------------- */
  function stopEndTimer() {
    if (endTimer) { clearInterval(endTimer); endTimer = null; }
  }

  function renderEnding(id) {
    var e = STORY.endings[id];
    if (!e) { show("cover"); return; }

    if (state.endings.indexOf(id) < 0) {
      state.endings.push(id);
      persist();
    }
    // 保留身份，供「再走一次」复用；只清本轮进度
    var keepRole = state.role;
    clearRun();
    state.role = keepRole;
    persist();

    $("endNo").textContent = e.no;
    $("endTitle").textContent = e.title;
    $("endSub").textContent = e.tag;
    $("endProgress").textContent = "已解锁 " + state.endings.length + " / " +
      Object.keys(STORY.endings).length + " 种结局";

    var box = $("endText");
    box.textContent = "";
    e.text.forEach(function (p) { box.appendChild(el("p", null, p)); });

    show("ending");

    // 结局段落逐段浮现，节奏比正文慢一点
    stopEndTimer();
    var i = 0;
    endTimer = setInterval(function () {
      var ps = box.children;
      if (i < ps.length) {
        ps[i].classList.add("on");
        i++;
      } else {
        stopEndTimer();
      }
    }, 950);
  }

  /* ---------------- 图鉴 ---------------- */
  function renderCodex() {
    var list = $("codexList");
    list.textContent = "";
    Object.keys(STORY.endings).forEach(function (id) {
      var e = STORY.endings[id];
      var got = state.endings.indexOf(id) >= 0;
      var item = el("div", "codex-item " + (got ? "got" : "locked"));
      item.appendChild(el("div", "seal", got ? "已" : "？"));
      var body = el("div", "ci-b");
      body.appendChild(el("div", "ci-t", got ? e.title : "未解锁结局"));
      body.appendChild(el("div", "ci-d", got ? (e.no + " · " + e.tag) : "走到终章并做出选择即可解锁"));
      item.appendChild(body);
      list.appendChild(item);
    });

    var cl = $("clueList");
    cl.textContent = "";
    Object.keys(STORY.clues).forEach(function (id) {
      var c = STORY.clues[id];
      var got = hasClue(id);
      var row = el("div", "clue-row" + (got ? " got" : ""));
      row.appendChild(el("span", "cd", got ? "✓" : "·"));
      row.appendChild(el("span", "cn", got ? c.name : "？？？"));
      cl.appendChild(row);
    });

    $("codexNote").textContent = hasClue("mark") && hasClue("rune") && hasClue("card") &&
      hasClue("note") && hasClue("file")
      ? "5 条线索已集齐——终章会出现隐藏选项「念出父亲笔记最后那一行字」。"
      : "已收集 " + state.clues.length + " / 5 条线索。集齐后可在终章解锁隐藏结局「守印者」。";
  }

  /* ---------------- 封面 ---------------- */
  function refreshCover() {
    var s = loadSave();
    var canContinue = !!(s && s.node && STORY.nodes[s.node] && !STORY.nodes[s.node].ending && s.role);
    $("btnContinue").style.display = canContinue ? "block" : "none";
  }

  /* ---------------- 绑定 ---------------- */
  function bind() {
    $("btnStart").addEventListener("click", function () {
      renderWorld();
      show("world");
    });

    $("btnContinue").addEventListener("click", function () {
      var s = loadSave();
      if (!s) return;
      applySave(s);
      renderNode();
      show("story");
    });

    $("btnToRole").addEventListener("click", function () { show("role"); renderRoles(); });

    $("btnCodex").addEventListener("click", function () { renderCodex(); show("codex"); });
    $("btnCodexTop").addEventListener("click", function () {
      if ($("view-codex").classList.contains("on")) { refreshCover(); show("cover"); }
      else { renderCodex(); show("codex"); }
    });
    $("btnCodex2").addEventListener("click", function () { renderCodex(); show("codex"); });
    $("btnBack").addEventListener("click", function () { refreshCover(); show("cover"); });

    $("btnUndo").addEventListener("click", undo);
    $("btnClues").addEventListener("click", function () { renderCodex(); show("codex"); });

    // 轻触正文区 → 揭示下一段
    $("storyScroll").addEventListener("click", function (e) {
      if (e.target && e.target.closest && e.target.closest(".choice")) return;
      var node = STORY.nodes[state.node];
      if (!node || !node.text) return;
      if (state.seen < node.text.length) {
        state.seen++;
        revealUpTo(state.seen);
        persist();
        if (state.seen >= node.text.length) renderChoices(node);
        $("tapHint").style.display = state.seen < node.text.length ? "block" : "none";
      }
    });

    $("btnAgain").addEventListener("click", function () {
      var role = state.role;
      clearRun();
      state.role = role;
      var r = currentRole();
      state.node = r ? r.start : "start";
      state.seen = 0;
      state.trail = [];
      renderNode();
      show("story");
    });

    $("btnSwap").addEventListener("click", function () {
      clearRun();
      refreshCover();
      show("role");
      renderRoles();
    });
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    bind();
    renderWorld();
    var s = loadSave();
    if (s) applySave(s);
    refreshCover();
    show("cover");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
