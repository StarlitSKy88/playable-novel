/* 剧情图静态校验：跳转目标 / 线索 / 结局 / 可达性 / 隐藏结局可达成性 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "src/assets/story.js"), "utf8");
const window = {};
eval(src.replace(/window\.STORY/, "window.STORY"));
const S = window.STORY;

const clueIds = Object.keys(S.clues);
const roleIds = S.roles.map(r => r.id);
const endIds = Object.keys(S.endings);
const nodeIds = Object.keys(S.nodes);

let errors = [];
let warnings = [];

// 1) 每个节点的 choices.to 必须存在
for (const [id, n] of Object.entries(S.nodes)) {
  if (n.isRole) {
    if (!S.roles.length) errors.push(`${id}: 身份选择节点但没有 roles`);
    continue;
  }
  if (n.ending) {
    if (!endIds.includes(n.ending)) errors.push(`${id}: 结局引用不存在 → ${n.ending}`);
    continue;
  }
  if (!Array.isArray(n.choices) || !n.choices.length) {
    errors.push(`${id}: 没有 choices`);
    continue;
  }
  for (const c of n.choices) {
    if (!S.nodes[c.to]) errors.push(`${id}: 跳转目标不存在 → ${c.to}`);
    if (c.clue && !clueIds.includes(c.clue)) errors.push(`${id}: 线索不存在 → ${c.clue}`);
    if (c.need) {
      for (const k of c.need) {
        if (!clueIds.includes(k)) errors.push(`${id}: need 的线索不存在 → ${k}`);
      }
    }
  }
}

// 2) role.start 必须存在
for (const r of S.roles) {
  if (!S.nodes[r.start]) errors.push(`角色 ${r.id}: start 不存在 → ${r.start}`);
}

// 3) 可达性（从 start + 各 role.start 出发）
const reach = new Set();
const stack = ["start", ...S.roles.map(r => r.start)];
while (stack.length) {
  const id = stack.pop();
  if (reach.has(id)) continue;
  reach.add(id);
  const n = S.nodes[id];
  if (!n) continue;
  (n.choices || []).forEach(c => { if (S.nodes[c.to]) stack.push(c.to); });
}
for (const id of nodeIds) if (!reach.has(id)) errors.push(`节点不可达 → ${id}`);

// 4) 每个结局必须可达
for (const id of endIds) {
  const hit = nodeIds.some(nid => S.nodes[nid].ending === id);
  if (!hit) errors.push(`结局未被任何节点引用 → ${id}`);
}

// 5) 隐藏结局所需线索必须可在一次通关中全部拿到（按角色做状态搜索）
//    状态 = (当前节点, 已获线索集合)；沿 choices 推进，节点级线索进入即得
const needAll = ["mark", "rune", "card", "note", "file"];
for (const r of S.roles) {
  const seenStates = new Set();
  const stack = [[r.start, []]];
  let ok = false;
  while (stack.length) {
    const [id, clues] = stack.pop();
    const key = id + "|" + clues.slice().sort().join(",");
    if (seenStates.has(key)) continue;
    seenStates.add(key);

    const n = S.nodes[id];
    if (!n) continue;
    let cur = clues.slice();
    if (n.clue && cur.indexOf(n.clue) < 0) cur.push(n.clue);

    for (const c of n.choices || []) {
      if (c.need && c.need.every(k => cur.indexOf(k) >= 0)) { ok = true; break; }
      if (S.nodes[c.to]) {
        const next = cur.slice();
        if (c.clue && next.indexOf(c.clue) < 0) next.push(c.clue);
        stack.push([c.to, next]);
      }
    }
    if (ok) break;
  }
  if (!ok) errors.push(`角色 ${r.id}: 无法在一次通关中集齐 5 条线索解锁隐藏结局`);
}

// 6) 每个节点至少要有正文（结局节点除外）
for (const [id, n] of Object.entries(S.nodes)) {
  if (n.isRole || n.ending) continue;
  if (!n.text || !n.text.length) warnings.push(`${id}: 没有正文段落`);
}

const totalChoices = nodeIds.reduce((s, id) => s + (S.nodes[id].choices || []).length, 0);

console.log(`节点 ${nodeIds.length} · 角色 ${roleIds.length} · 线索 ${clueIds.length} · 结局 ${endIds.length} · 选项 ${totalChoices}`);
console.log(`可达节点 ${reach.size}`);
if (warnings.length) console.log("\n警告:\n" + warnings.map(w => "  ⚠ " + w).join("\n"));
if (errors.length) {
  console.log("\n错误:\n" + errors.map(e => "  ✗ " + e).join("\n"));
  process.exit(1);
}
console.log("\n✅ 剧情图校验通过");
