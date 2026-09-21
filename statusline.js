#!/usr/bin/env node
// Claude Code status line. Reads session JSON on stdin, prints 3 animated lines.
// Cost windows (1h / 10m) are computed from a sample log of every session's
// cumulative cost: ~/.claude/statusline/cost-log.jsonl

const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const HOME = os.homedir();
const DATA_DIR = path.join(HOME, ".claude", "statusline");
const LOG = path.join(DATA_DIR, "cost-log.jsonl");
const GIT_CACHE = path.join(DATA_DIR, "git-cache.json");
const LOG_KEEP_MS = 6 * 3600e3;
const now = Date.now();

// ── colors ──────────────────────────────────────────────────────────────────
const E = "\x1b[";
const R = `${E}0m`;
const fg = (r, g, b) => `${E}38;2;${r};${g};${b}m`;
const bold = (s) => `${E}1m${s}${E}22m`;
const dim = (s) => `${E}2m${s}${E}22m`;
const C = {
  txt: [205, 214, 244], sub: [127, 132, 156], sep: [69, 71, 90],
  green: [166, 227, 161], yellow: [249, 226, 175], peach: [250, 179, 135],
  red: [243, 139, 168], blue: [137, 180, 250], mauve: [203, 166, 247],
  teal: [148, 226, 213], sky: [137, 220, 235], pink: [245, 194, 231],
};
const paint = (c, s) => fg(...c) + s + R;
// STATUSLINE_NERD=1 → Nerd Font glyphs; default is plain unicode that renders anywhere.
const NERD = process.env.STATUSLINE_NERD === "1";
const I = NERD ? { dir: "", git: "", time: "󱎫", pr: "" } : { dir: "▸", git: "⎇", time: "◷", pr: "⇅" };
const SEP = paint(C.sep, " │ ");

const lerp = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
// green → yellow → peach → red by fill ratio
function heat(p) {
  const stops = [C.green, C.yellow, C.peach, C.red];
  const x = Math.max(0, Math.min(0.999, p)) * (stops.length - 1);
  const i = Math.floor(x);
  return lerp(stops[i], stops[i + 1], x - i);
}

// ── animation ───────────────────────────────────────────────────────────────
// refreshInterval is >= 1s, so animate one frame per second.
const tick = Math.floor(now / 1000);
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const spinner = SPIN[tick % SPIN.length];

// Progress bar with a heat gradient and a shimmer sweeping across the filled part.
function bar(pct, width = 12) {
  const p = Math.max(0, Math.min(100, pct || 0)) / 100;
  const cells = p * width;
  const full = Math.floor(cells);
  const partial = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"][Math.floor((cells - full) * 8)];
  const shine = full > 0 ? tick % (full + 6) : -1;
  let out = "";
  for (let i = 0; i < full; i++) {
    let c = heat((i + 0.5) / width);
    if (i === shine) c = lerp(c, [255, 255, 255], 0.55);
    else if (Math.abs(i - shine) === 1) c = lerp(c, [255, 255, 255], 0.2);
    out += fg(...c) + "█";
  }
  if (partial) out += fg(...heat(p)) + partial;
  const used = full + (partial ? 1 : 0);
  out += fg(...C.sep) + "░".repeat(Math.max(0, width - used));
  return out + R;
}

// Pulse color for critical values
const pulse = (c) => (tick % 4 < 2 ? c : lerp(c, [255, 255, 255], 0.35));

// ── formatting ──────────────────────────────────────────────────────────────
const money = (v) => (v == null || isNaN(v) ? "—" : v >= 100 ? `$${v.toFixed(0)}` : v >= 10 ? `$${v.toFixed(1)}` : `$${v.toFixed(2)}`);
const ktok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n | 0}`);
function dur(ms) {
  if (!(ms > 0)) return "0m";
  const m = Math.floor(ms / 60e3), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d) return `${d}d${h % 24}h`;
  if (h) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${m}m`;
}
const pctColor = (p) => (p >= 90 ? pulse(C.red) : heat(p / 100));

// ── input ───────────────────────────────────────────────────────────────────
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch {}
const sid = input.session_id || "unknown";
const cwd = input.workspace?.current_dir || input.cwd || process.cwd();
const projectDir = input.workspace?.project_dir || cwd;
const cost = input.cost || {};
const sessionCost = Number(cost.total_cost_usd) || 0;

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// ── cost windows ────────────────────────────────────────────────────────────
function costWindows() {
  let lines = [];
  try { lines = fs.readFileSync(LOG, "utf8").split("\n"); } catch {}
  const samples = [];
  for (const l of lines) {
    if (!l) continue;
    try { const s = JSON.parse(l); if (now - s.t < LOG_KEEP_MS) samples.push(s); } catch {}
  }
  const last = samples.filter((s) => s.s === sid).pop();
  if (!last || last.c !== sessionCost || now - last.t > 60e3) {
    const s = { t: now, s: sid, c: sessionCost, d: cost.total_duration_ms || 0 };
    samples.push(s);
    // Compact the log occasionally instead of rewriting it on every call.
    if (lines.length > samples.length + 500) {
      try { fs.writeFileSync(LOG, samples.map((x) => JSON.stringify(x)).join("\n") + "\n"); } catch {}
    } else {
      try { fs.appendFileSync(LOG, JSON.stringify(s) + "\n"); } catch {}
    }
  }
  // Per session: sum of positive deltas between consecutive samples inside the
  // window (anchored on the last sample before it). Drops = /clear reset.
  const bySession = {};
  for (const s of samples) (bySession[s.s] ||= []).push(s);
  for (const arr of Object.values(bySession)) arr.sort((a, b) => a.t - b.t);
  const window = (ms, only) => {
    const start = now - ms;
    let total = 0;
    for (const [id, arr] of Object.entries(bySession)) {
      if (only && id !== only) continue;
      let prev = null;
      for (const s of arr) {
        if (s.t >= start) {
          // First sample of a session that began before the window: spread its
          // cost evenly over its duration and count only the in-window share.
          let base = prev ? prev.c : 0;
          if (!prev && s.d > s.t - start) base = s.c * (1 - (s.t - start) / s.d);
          if (s.c > base) total += s.c - base;
        }
        prev = s;
      }
    }
    return total;
  };
  return {
    h1: window(3600e3, sid), m10: window(600e3, sid),
    h1All: window(3600e3), m10All: window(600e3),
  };
}

// ── git (cached for 5s so animation refreshes stay cheap) ───────────────────
function git() {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(GIT_CACHE, "utf8")); } catch {}
  const hit = cache[cwd];
  if (hit && now - hit.t < 5000) return hit.v;
  let v = null;
  try {
    const out = cp.execFileSync("git", ["-C", cwd, "--no-optional-locks", "status", "--porcelain=v2", "--branch"], {
      encoding: "utf8", timeout: 800, stdio: ["ignore", "pipe", "ignore"],
    });
    v = { branch: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0 };
    for (const l of out.split("\n")) {
      if (l.startsWith("# branch.head ")) v.branch = l.slice(14);
      else if (l.startsWith("# branch.oid ") && !v.oid) v.oid = l.slice(13, 20);
      else if (l.startsWith("# branch.ab ")) { const [a, b] = l.slice(12).split(" "); v.ahead = +a; v.behind = -b; }
      else if (l.startsWith("u ")) v.conflicts++;
      else if (l.startsWith("1 ") || l.startsWith("2 ")) {
        if (l[2] !== ".") v.staged++;
        if (l[3] !== ".") v.modified++;
      } else if (l.startsWith("? ")) v.untracked++;
    }
    if (v.branch === "(detached)") v.branch = `@${v.oid || "detached"}`;
  } catch {}
  cache[cwd] = { t: now, v };
  try { fs.writeFileSync(GIT_CACHE, JSON.stringify(cache)); } catch {}
  return v;
}

// ── line 1: model · dir · git · time · lines ────────────────────────────────
const model = input.model?.display_name || input.model?.id || "Claude";
const l1 = [];
l1.push(paint(C.mauve, spinner) + " " + bold(paint(C.mauve, model)) +
  (input.effort?.level ? paint(C.sub, ` ${input.effort.level}`) : "") +
  (input.fast_mode ? " " + paint(pulse(C.yellow), "⚡fast") : "") +
  (input.output_style?.name && input.output_style.name !== "default" ? paint(C.sub, ` (${input.output_style.name})`) : ""));

const rel = cwd.startsWith(HOME) ? "~" + cwd.slice(HOME.length) : cwd;
const shortDir = rel.split("/").length > 3 ? "…/" + rel.split("/").slice(-2).join("/") : rel;
l1.push(paint(C.blue, I.dir + " " + shortDir));

const g = git();
if (g) {
  let s = paint(C.pink, I.git + " " + g.branch);
  const bits = [];
  if (g.staged) bits.push(paint(C.green, `+${g.staged}`));
  if (g.modified) bits.push(paint(C.yellow, `~${g.modified}`));
  if (g.untracked) bits.push(paint(C.sub, `?${g.untracked}`));
  if (g.conflicts) bits.push(paint(pulse(C.red), `!${g.conflicts}`));
  if (g.ahead) bits.push(paint(C.teal, `↑${g.ahead}`));
  if (g.behind) bits.push(paint(C.peach, `↓${g.behind}`));
  if (!bits.length) bits.push(paint(C.green, "✓"));
  l1.push(s + " " + bits.join(" "));
}
const osc8 = (url, text) => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
if (input.pr?.number) {
  const st = input.pr.review_state;
  const col = st === "approved" ? C.green : st === "changes_requested" ? C.red : C.teal;
  l1.push(input.pr.url ? osc8(input.pr.url, paint(col, `${I.pr} #${input.pr.number}`)) : paint(col, `${I.pr} #${input.pr.number}`));
}

const added = cost.total_lines_added || 0, removed = cost.total_lines_removed || 0;
l1.push(paint(C.sky, I.time + " " + dur(cost.total_duration_ms)) +
  (added || removed ? "  " + paint(C.green, `+${added}`) + paint(C.sub, "/") + paint(C.red, `-${removed}`) : ""));

// ── line 2: context · 5h · 7d ───────────────────────────────────────────────
const cw = input.context_window || {};
const ctxSize = cw.context_window_size || 200000;
const cu = cw.current_usage;
const ctxUsed = cu ? (cu.input_tokens || 0) + (cu.cache_creation_input_tokens || 0) + (cu.cache_read_input_tokens || 0) : null;
let ctxPct = cw.used_percentage;
if (ctxPct == null && ctxUsed != null) ctxPct = (ctxUsed / ctxSize) * 100;

const l2 = [];
if (ctxPct != null) {
  const tok = ctxUsed != null ? paint(C.sub, ` ${ktok(ctxUsed)}/${ktok(ctxSize)}`) : paint(C.sub, ` /${ktok(ctxSize)}`);
  l2.push(paint(C.txt, "ctx ") + bar(ctxPct) + " " + bold(paint(pctColor(ctxPct), `${Math.round(ctxPct)}%`)) + tok);
} else {
  l2.push(paint(C.txt, "ctx ") + bar(0) + paint(C.sub, " —"));
}

function resetIn(v) {
  if (v == null) return "";
  let t = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
  if (!(t > now)) return "";
  return paint(C.sub, ` ⟳${dur(t - now)}`);
}
const rl = input.rate_limits || {};
for (const [label, key] of [["5h", "five_hour"], ["7d", "seven_day"], ["spend", "spend_limit"]]) {
  const r = rl[key];
  if (!r || r.used_percentage == null) continue;
  const p = r.used_percentage;
  l2.push(paint(C.txt, label + " ") + bar(p, 10) + " " + bold(paint(pctColor(p), `${Math.round(p)}%`)) + resetIn(r.resets_at));
}

// ── money → appended to line 1; cache → line 2 ───────────────────────────────
const w = costWindows();
// Current session, then all sessions together in parentheses.
const spend = (label, mine, all) => paint(C.sub, label + " ") + paint(C.peach, money(mine)) +
  paint(C.sub, ` (${money(Math.max(all, mine))})`);
l1.push(paint(C.yellow, "💰") + bold(paint(C.yellow, money(sessionCost))) + "  " +
  spend("1h", w.h1, w.h1All) + "  " + spend("10m", w.m10, w.m10All) +
  ((cost.total_duration_ms || 0) > 3e5 ? "  " + paint(C.sub, "rate ") + paint(C.teal, money(sessionCost / (cost.total_duration_ms / 3600e3)) + "/h") : ""));

const pc = input.prompt_cache;
if (pc && pc.caching_observed !== false && pc.hit_ratio != null) {
  const left = pc.expires_at ? pc.expires_at * 1000 - now : 0;
  const warm = pc.warm && left > 0;
  const col = warm ? (left < 60e3 ? pulse(C.peach) : C.teal) : C.sub;
  l2.push(paint(C.sub, "cache ") + paint(col, `${warm ? "●" : "○"} ${Math.round(pc.hit_ratio * 100)}%`) +
    (warm ? paint(C.sub, ` ${left < 60e3 ? Math.ceil(left / 1000) + "s" : dur(left)}`) : paint(C.sub, " cold")));
}

if (cost.total_api_duration_ms) l2.push(paint(C.sub, "api ") + paint(C.sky, dur(cost.total_api_duration_ms)));

process.stdout.write([l1.join(SEP), l2.join(SEP)].join("\n"));
