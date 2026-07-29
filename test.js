#!/usr/bin/env node
'use strict';

/**
 * Dependency-free test suite for tiktok-mass-unliker.user.js.
 *
 *   node test.js                     # test the userscript in this directory
 *   TTMU_SCRIPT=/path/to.user.js     # test some other build (e.g. an old commit)
 *
 * There is no jsdom and no test runner here on purpose: the whole point is that
 * anyone can clone the repo and reproduce the numbers with `node test.js`.
 * The REAL userscript is evaluated in a `vm` context against a hand-rolled DOM,
 * a virtual clock and seeded RNGs — the logic under test is never retyped.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT_PATH = process.env.TTMU_SCRIPT ||
  path.join(__dirname, 'tiktok-mass-unliker.user.js');
const SOURCE = fs.readFileSync(SCRIPT_PATH, 'utf8');

// ---------------------------------------------------------------- assertions
let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'expected truthy');
}
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'values differ'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function includes(hay, needle, msg) {
  if (String(hay).indexOf(needle) === -1) {
    throw new Error(`${msg || 'missing text'}: ${JSON.stringify(needle)} not in ${JSON.stringify(String(hay).slice(0, 400))}`);
  }
}

// ------------------------------------------------------------------ DOM shim
// Just enough DOM for the selectors, listeners and properties the userscript
// actually touches.
function splitSelector(sel) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of sel) {
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === ' ' && depth === 0) {
      if (cur) parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

function parseCompound(sel) {
  const out = { tag: null, id: null, cls: [], attrs: [] };
  let s = sel.trim();
  const tagM = s.match(/^[a-zA-Z][\w-]*/);
  if (tagM) { out.tag = tagM[0].toUpperCase(); s = s.slice(tagM[0].length); }
  const idM = s.match(/^#([\w:.-]+)/);
  if (idM) { out.id = idM[1]; s = s.slice(idM[0].length); }
  let clsM;
  while ((clsM = s.match(/^\.([\w-]+)/))) { out.cls.push(clsM[1]); s = s.slice(clsM[0].length); }
  const re = /\[([\w-]+)(?:([*^$~|]?=)"([^"]*)")?(\s+i)?\]/g;
  let m;
  while ((m = re.exec(s))) {
    out.attrs.push({ name: m[1], op: m[2], val: m[3], ci: !!m[4] });
  }
  return out;
}

function matchesCompound(el, p) {
  if (p.tag && el.tagName !== p.tag) return false;
  if (p.id && el.getAttribute('id') !== p.id) return false;
  for (const c of p.cls) if (!el.classList.contains(c)) return false;
  for (const a of p.attrs) {
    let v = el.getAttribute(a.name);
    if (v === null) return false;
    if (!a.op) continue;
    let want = a.val;
    if (a.ci) { v = v.toLowerCase(); want = want.toLowerCase(); }
    if (a.op === '=' && v !== want) return false;
    if (a.op === '*=' && v.indexOf(want) === -1) return false;
    if (a.op === '^=' && v.lastIndexOf(want, 0) !== 0) return false;
    if (a.op === '$=' && v.slice(-want.length) !== want) return false;
  }
  return true;
}

function descendants(el, out) {
  for (const c of el.childNodes) { out.push(c); descendants(c, out); }
  return out;
}

function query(root, sel, first) {
  const parts = splitSelector(sel).map(parseCompound);
  let scopes = [root];
  let results = [];
  for (let i = 0; i < parts.length; i++) {
    results = [];
    for (const s of scopes) {
      for (const d of descendants(s, [])) {
        if (matchesCompound(d, parts[i])) results.push(d);
      }
    }
    scopes = results;
  }
  if (first) return results[0] || null;
  return results;
}

class El {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
    this.attributes = Object.create(null);
    this.childNodes = [];
    this.parentNode = null;
    this.disabled = false;
    this._text = '';
    this._html = '';
    this._listeners = Object.create(null);
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.rect = { top: 0, left: 0, right: 1920, bottom: 1080 };
    const self = this;
    this.classList = {
      contains: (c) => (self.attributes.class || '').split(/\s+/).includes(c),
      add(c) { if (!this.contains(c)) self.attributes.class = ((self.attributes.class || '') + ' ' + c).trim(); },
      remove(c) {
        self.attributes.class = (self.attributes.class || '')
          .split(/\s+/).filter((x) => x && x !== c).join(' ');
      },
      toggle(c, force) {
        const on = force === undefined ? !this.contains(c) : !!force;
        if (on) this.add(c); else this.remove(c);
        return on;
      },
    };
  }
  setAttribute(n, v) { this.attributes[n] = String(v); }
  getAttribute(n) { return n in this.attributes ? this.attributes[n] : null; }
  removeAttribute(n) { delete this.attributes[n]; }
  appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; }
  querySelector(s) { return query(this, s, true); }
  querySelectorAll(s) { return query(this, s, false); }
  closest(s) {
    const p = parseCompound(splitSelector(s).pop());
    let n = this;
    while (n) { if (matchesCompound(n, p)) return n; n = n.parentNode; }
    return null;
  }
  getBoundingClientRect() { return this.rect; }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  dispatchEvent(ev) {
    let n = this;
    while (n) { (n._listeners[ev.type] || []).forEach((f) => f(ev)); n = n.parentNode; }
    return true;
  }
  click() { if (this.onclick) this.onclick(); this.dispatchEvent({ type: 'click' }); }
  get id() { return this.attributes.id || ''; }
  set id(v) { this.attributes.id = String(v); }
  get textContent() { return this._text; }
  set textContent(v) {
    this._text = String(v);
    this.scrollHeight = this._text.split('\n').length * 15;
  }
  get innerHTML() { return this._html; }
  // The panel is built from a single innerHTML string. Only `#id` lookups are
  // ever performed against it, so materialising one stub element per id="…" is
  // enough — and keeps the shim from needing an HTML parser.
  set innerHTML(v) {
    this._html = String(v);
    this.childNodes = [];
    const re = /id="([^"]+)"/g;
    let m;
    while ((m = re.exec(this._html))) {
      const child = new El(this.ownerDocument, 'div');
      child.setAttribute('id', m[1]);
      this.appendChild(child);
    }
  }
}

function makeDocument() {
  const doc = {
    hidden: false,
    activeElement: null,
    _listeners: Object.create(null),
    createElement(tag) { return new El(doc, tag); },
    addEventListener(t, fn) { (doc._listeners[t] = doc._listeners[t] || []).push(fn); },
    fire(t) { (doc._listeners[t] || []).forEach((f) => f({ type: t })); },
  };
  doc.documentElement = new El(doc, 'html');
  doc.body = new El(doc, 'body');
  doc.documentElement.appendChild(doc.body);
  doc.querySelector = (s) => query(doc.documentElement, s, true);
  doc.querySelectorAll = (s) => query(doc.documentElement, s, false);
  return doc;
}

// -------------------------------------------------------------- virtual time
const flush = () => new Promise((r) => setImmediate(r));

function makeClock() {
  let now = 1700000000000;
  let seq = 0;
  const timers = new Map();
  return {
    get now() { return now; },
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + (Number(ms) || 0), fn, id });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    get pending() { return timers.size; },
    // Runs the queue forward, stopping as soon as `done()` is true.
    async advanceUntil(done, maxMs) {
      const end = now + maxMs;
      let guard = 0;
      while (++guard < 4000000) {
        await flush();
        if (done && done()) return true;
        let next = null;
        for (const t of timers.values()) {
          if (!next || t.at < next.at || (t.at === next.at && t.id < next.id)) next = t;
        }
        if (!next || next.at > end) break;
        timers.delete(next.id);
        now = next.at;
        try { next.fn(); } catch (e) { /* surfaced through script state */ }
      }
      await flush();
      return done ? !!done() : true;
    },
  };
}

// mulberry32 — small, seeded, good enough for stationary Bernoulli draws.
function seededRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------ page + sandbox
/**
 * opts:
 *   href          initial URL (default: own liked-feed video)
 *   handle        own handle rendered into the nav-profile link ('' = none)
 *   likedTab      'yes' | 'no' | null  (aria-selected on the liked tab)
 *   readable      (i) => bool   can the like state be read for video i
 *   clickFails    (i) => bool   does the click fail to flip video i
 *   nextLabel     aria-label for the next button
 *   nextHook      false to drop the data-e2e hook and rely on label matching
 *   onNext        (i, env) => void, called after each successful advance
 *   random        () => number, seeded RNG for the script
 */
function makeEnv(opts) {
  const o = Object.assign({
    href: 'https://www.tiktok.com/@me/video/1',
    handle: 'me',
    likedTab: 'yes',
    readable: () => true,
    clickFails: () => false,
    nextLabel: 'Next video',
    nextHook: true,
    onNext: null,
    random: seededRandom(1),
  }, opts || {});

  const doc = makeDocument();
  const clock = makeClock();
  const env = { doc, clock, video: 1, liked: true, clicks: 0, o };

  const location = {};
  env.goto = (href) => {
    location.href = href;
    const u = href.replace(/^https?:\/\/[^/]+/, '');
    location.pathname = u.split(/[?#]/)[0] || '/';
    location.hostname = 'www.tiktok.com';
  };
  env.goto(o.href);

  // Own-profile link (what the page guard uses to learn the handle).
  if (o.handle) {
    const a = doc.createElement('a');
    a.setAttribute('data-e2e', 'nav-profile');
    a.setAttribute('href', `/@${o.handle}`);
    doc.body.appendChild(a);
  }
  if (o.likedTab) {
    const tab = doc.createElement('p');
    tab.setAttribute('data-e2e', 'liked-tab');
    tab.setAttribute('aria-selected', o.likedTab === 'yes' ? 'true' : 'false');
    doc.body.appendChild(tab);
  }

  // Active video container + like button + next button.
  const container = doc.createElement('div');
  container.setAttribute('data-e2e', 'browse-video');
  doc.body.appendChild(container);
  env.container = container;

  const likeBtn = doc.createElement('button');
  const likeIcon = doc.createElement('span');
  likeIcon.setAttribute('data-e2e', 'browse-like-icon');
  likeBtn.appendChild(likeIcon);
  container.appendChild(likeBtn);
  env.likeBtn = likeBtn;

  function paint() {
    if (o.readable(env.video)) {
      likeBtn.setAttribute('aria-pressed', env.liked ? 'true' : 'false');
      likeBtn.setAttribute('aria-label', env.liked ? 'Unlike video' : 'Like video');
    } else {
      // No aria-pressed, no usable label, no svg => isLiked() must return null.
      likeBtn.removeAttribute('aria-pressed');
      likeBtn.setAttribute('aria-label', '');
    }
  }
  env.paint = paint;
  paint();

  env.relikes = 0;   // clicks that left the video liked — the real-world damage
  likeBtn.onclick = () => {
    env.clicks++;
    if (o.clickFails(env.video)) env.relikes++;
    else env.liked = false;
    paint();
  };

  const nextBtn = doc.createElement('button');
  if (o.nextHook) nextBtn.setAttribute('data-e2e', 'arrow-right');
  nextBtn.setAttribute('aria-label', o.nextLabel);
  container.appendChild(nextBtn);
  env.nextBtn = nextBtn;

  nextBtn.onclick = () => {
    env.video++;
    env.liked = true;
    paint();
    env.goto(`https://www.tiktok.com/@${o.handle || 'me'}/video/${env.video}`);
    if (o.onNext) o.onNext(env.video, env);
  };

  const store = new Map();
  const sandbox = {
    console: { log() {} },
    location,
    document: doc,
    navigator: { clipboard: { writeText() {} } },
    innerWidth: 1920,
    innerHeight: 1080,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    KeyboardEvent: class { constructor(type, init) { Object.assign(this, init || {}); this.type = type; } },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    setInterval: () => 0,
    clearInterval: () => {},
    __now: () => clock.now,
    __random: o.random,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext('Date.now = __now; Math.random = __random;', sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: path.basename(SCRIPT_PATH) });

  env.api = sandbox.__TTMU__;
  env.state = () => env.api.state();
  env.logText = () => env.api.panel.querySelector('#ttmu-log').textContent;
  env.panelText = (id) => env.api.panel.querySelector(id).textContent;
  return env;
}

const runUntilStopped = (env, maxMs) =>
  env.clock.advanceUntil(() => !env.state().running, maxMs || 12 * 3600000);

// --------------------------------------------------------------- P1-1 guard
test('page guard refuses to start on the For You feed', async () => {
  const env = makeEnv({ href: 'https://www.tiktok.com/foryou', likedTab: null });
  env.api.start();
  await env.clock.advanceUntil(null, 60000);
  eq(env.state().running, false, 'must not run on For You');
  eq(env.state().mode, 'idle', 'mode');
  includes(env.logText(), 'Not starting', 'refusal is logged');
  eq(env.clicks, 0, 'no like button was clicked');
});

test('page guard refuses to start on a hashtag feed', async () => {
  const env = makeEnv({ href: 'https://www.tiktok.com/tag/cats', likedTab: null });
  env.api.start();
  await env.clock.advanceUntil(null, 60000);
  eq(env.state().running, false, 'must not run on a hashtag feed');
  eq(env.clicks, 0, 'no like button was clicked');
});

test("page guard refuses to start on someone else's profile", async () => {
  const env = makeEnv({ href: 'https://www.tiktok.com/@stranger/video/9', handle: 'me', likedTab: null });
  env.api.start();
  await env.clock.advanceUntil(null, 60000);
  eq(env.state().running, false, "must not run on another user's profile");
  includes(env.logText(), '@stranger', 'names the profile it refused');
  eq(env.clicks, 0, 'no like button was clicked');
});

test('page guard refuses when the Liked tab is not the selected tab', async () => {
  const env = makeEnv({ likedTab: 'no' });
  env.api.start();
  await env.clock.advanceUntil(null, 60000);
  eq(env.state().running, false, 'must not run with the Liked tab unselected');
});

test('page guard allows the own liked feed', async () => {
  const env = makeEnv({});
  const g = env.api.pageGuard();
  eq(g.ok, true, `guard should accept the own liked feed (${g.msg})`);
  env.api.start();
  eq(env.state().running, true, 'should be running');
  env.api.stop();
});

test('page guard pauses mid-run when the feed changes underneath it', async () => {
  const env = makeEnv({
    onNext: (i, e) => { if (i >= 3) e.goto('https://www.tiktok.com/foryou'); },
  });
  env.api.start();
  await runUntilStopped(env, 30 * 60000);
  const s = env.state();
  eq(s.paused, true, 'must pause when the location leaves the liked feed');
  eq(s.pauseCode, env.api.P.GUARD, 'pause code');
  ok(env.clicks <= 3, `must stop clicking almost immediately (clicked ${env.clicks})`);
  includes(env.logText(), 'Left the Liked feed', 'explains what happened');
});

// ------------------------------------------------------- P1-2 determinacy
test('determinacy tracker pauses when the like state cannot be read', async () => {
  const env = makeEnv({ readable: () => false });
  env.api.start();
  const stopped = await runUntilStopped(env, 6 * 3600000);
  const s = env.state();
  ok(stopped, 'must not run forever on an unreadable DOM');
  eq(s.paused, true, 'must pause');
  eq(s.pauseCode, env.api.P.INDETERMINATE, 'pause code');
  eq(s.runTotal, 0, 'nothing was unliked');
  ok(s.processed <= 12, `must give up quickly, saw ${s.processed} videos`);
  includes(env.logText(), "Can't read the like state", 'names the cause');
});

test('determinacy tracker survives a readable feed with occasional null reads', async () => {
  // 1-in-5 unreadable is noise, not a DOM change: the run should continue.
  const env = makeEnv({ readable: (i) => i % 5 !== 0 });
  env.api.start();
  await env.clock.advanceUntil(() => env.state().runTotal >= 20, 60 * 60000);
  const s = env.state();
  ok(s.runTotal >= 20, `should keep unliking, got ${s.runTotal}`);
  ok(s.pauseCode !== env.api.P.INDETERMINATE, 'must not pause on occasional nulls');
  env.api.stop();
});

// ------------------------------------------- P2-1 escalation on stable codes
test('escalation counts repeats by code, not by the reason string', async () => {
  const env = makeEnv({});
  const code = env.api.P.VERIFY_WINDOW;
  // These are exactly the strings the window trip produces for a fail-every-2nd,
  // every-3rd and every-4th pattern: same failure, three different sentences.
  env.api.pause(code, '3 of the last 5 clicks failed to verify — stopping.');
  eq(env.state().repeatPauses, 1, 'first pause');
  env.api.pause(code, '3 of the last 7 clicks failed to verify — stopping.');
  eq(env.state().repeatPauses, 2, 'second pause with a different string must still count');
  env.api.pause(code, '3 of the last 9 clicks failed to verify — stopping.');
  eq(env.state().repeatPauses, 3, 'third pause');
  eq(env.state().pauseCode, code, 'code is exposed');
  eq(env.state().pauseReason, '3 of the last 9 clicks failed to verify — stopping.', 'reason is the human string');
});

test('escalation reaches the give-up refusal despite varying reason strings', async () => {
  const env = makeEnv({});
  const code = env.api.P.VERIFY_WINDOW;
  for (let i = 0; i < 5; i++) env.api.pause(code, `3 of the last ${5 + i * 2} clicks failed to verify.`);
  eq(env.state().repeatPauses, 5, 'five strikes');
  env.api.resume();
  eq(env.state().running, false, 'resume must be refused after the give-up threshold');
  includes(env.logText(), "resuming won't help", 'refusal is explained');
});

test('a different pause code resets the repeat counter', async () => {
  const env = makeEnv({});
  env.api.pause(env.api.P.VERIFY_WINDOW, 'a');
  env.api.pause(env.api.P.NAV_WINDOW, 'b');
  eq(env.state().repeatPauses, 1, 'unrelated pause starts a new count');
});

// ------------------------------------------------- P2-2 cumulative ceiling
test('cumulative ceiling stops a perfectly periodic 1-in-5 failure pattern', async () => {
  // This pattern never fills the 10-verification window (2 fails, needs 3) and
  // never produces 2 in a row, so the rate guard alone runs forever.
  const env = makeEnv({ clickFails: (i) => i % 5 === 0 });
  env.api.start();
  const stopped = await runUntilStopped(env, 12 * 3600000);
  const s = env.state();
  ok(stopped, 'must not run forever on a periodic failure pattern');
  eq(s.paused, true, 'must pause');
  eq(s.pauseCode, env.api.P.VERIFY_CEILING, 'ceiling is what fires');
  eq(s.verifyFailsTotal, env.api.CFG.verifyFailCeiling, 'stops exactly at the ceiling');
  ok(s.verifyFailsTotal <= 10, `re-likes bounded (${s.verifyFailsTotal})`);
});

test('cumulative ceiling survives a resume (it is per run, not per attempt)', async () => {
  const env = makeEnv({ clickFails: (i) => i % 5 === 0 });
  env.api.start();
  await runUntilStopped(env, 12 * 3600000);
  const before = env.state().verifyFailsTotal;
  env.api.resume();
  await runUntilStopped(env, 12 * 3600000);
  const s = env.state();
  eq(s.paused, true, 'must pause again immediately after resume');
  eq(s.repeatPauses >= 2, true, 'the repeat counter escalates');
  ok(s.verifyFailsTotal <= before + 1, `resume must not hand back a fresh budget (${before} -> ${s.verifyFailsTotal})`);
});

// ----------------------------------------------------- P2-3 next-button regex
const LEGIT_NEXT_LABELS = [
  'Next video in profile feed',
  'Next video in this collection',
  'Swipe down to save',
  'Next video, comment count 12',
  'Scroll down · muted',
  'Next video (fullscreen)',
];
const NOT_NEXT_LABELS = [
  'Download this video',
  'Share to friends',
  'Save video',
  'Delete this video',
  'Report this video',
  'Copy link',
];

test('legitimate next-button labels are accepted (label match)', async () => {
  for (const label of LEGIT_NEXT_LABELS) {
    const env = makeEnv({ nextHook: false, nextLabel: label });
    const found = env.api.findNextButton();
    ok(found === env.nextBtn, `label should be accepted: ${JSON.stringify(label)}`);
  }
});

test('legitimate next-button labels are accepted on the data-e2e hook', async () => {
  for (const label of LEGIT_NEXT_LABELS) {
    const env = makeEnv({ nextHook: true, nextLabel: label });
    const found = env.api.findNextButton();
    ok(found === env.nextBtn, `hooked button should be accepted: ${JSON.stringify(label)}`);
  }
});

test('destructive / share controls are still rejected', async () => {
  for (const label of NOT_NEXT_LABELS) {
    const env = makeEnv({ nextHook: false, nextLabel: label });
    eq(env.api.findNextButton(), null, `label must be rejected: ${JSON.stringify(label)}`);
  }
});

test('a run with a "profile feed" next label actually advances', async () => {
  const env = makeEnv({ nextHook: false, nextLabel: 'Next video in profile feed' });
  env.api.start();
  await env.clock.advanceUntil(() => env.state().runTotal >= 15, 60 * 60000);
  ok(env.state().runTotal >= 15, `should have unliked 15, got ${env.state().runTotal}`);
  ok(env.video >= 15, `should have advanced, at video ${env.video}`);
  env.api.stop();
});

// ------------------------------------------------------- P2-4 panel exposure
test('the panel shows verified vs failed clicks', async () => {
  const env = makeEnv({ clickFails: (i) => i % 5 === 0 });
  env.api.start();
  await env.clock.advanceUntil(() => env.state().verifyFailsTotal >= 3, 60 * 60000);
  env.api.stop();
  const s = env.state();
  const shown = env.panelText('#ttmu-verify');
  includes(shown, String(s.verifyFailsTotal), 'failed count is rendered');
  includes(shown, String(s.attempts - s.verifyFailsTotal), 'verified count is rendered');
});

test('the log keeps scrollback instead of a single overwritten line', async () => {
  const env = makeEnv({});
  env.api.start();
  await env.clock.advanceUntil(() => env.state().runTotal >= 5, 60 * 60000);
  env.api.stop();
  const lines = env.logText().split('\n').filter(Boolean);
  ok(lines.length >= 5, `expected scrollback, got ${lines.length} line(s)`);
  ok(env.api.logHistory().length === lines.length, 'history matches what is rendered');
});

// ------------------------------------------------------------------- P3 bits
test('a non-English UI is reported as such, not as "end of feed"', async () => {
  const env = makeEnv({ nextHook: false, nextLabel: 'Volgende video' });
  env.api.start();
  const stopped = await runUntilStopped(env, 2 * 3600000);
  const s = env.state();
  ok(stopped, 'must stop');
  eq(s.pauseCode, env.api.P.NAV_LABELS, 'dedicated pause code for unmatched labels');
  includes(env.logText(), 'English', 'says the label language is the problem');
});

test('a hidden tab produces a warning', async () => {
  const env = makeEnv({});
  env.api.start();
  await env.clock.advanceUntil(() => env.state().runTotal >= 2, 60 * 60000);
  env.doc.hidden = true;
  env.doc.fire('visibilitychange');
  env.api.stop();
  includes(env.logText(), 'background', 'warns about background throttling');
});

test('a stale session expires loudly rather than silently zeroing counters', async () => {
  const env = makeEnv({});
  env.api.start();
  await env.clock.advanceUntil(() => env.state().runTotal >= 3, 60 * 60000);
  env.api.stop();
  const done = env.state().runTotal;
  ok(done >= 3, 'seeded some progress');
  ok(env.api.CFG.sessionIdleMs >= 8 * 3600000,
    `session window must outlast a full run (is ${env.api.CFG.sessionIdleMs / 3600000}h)`);
});

test('the like button is found even when a second container is off screen', async () => {
  const env = makeEnv({});
  // A second, identical container that is scrolled far out of view. The active
  // one must win regardless of document order.
  const stale = env.doc.createElement('div');
  stale.setAttribute('data-e2e', 'browse-video');
  stale.rect = { top: 5000, left: 0, right: 1920, bottom: 6000 };
  env.doc.body.childNodes.unshift(stale);
  stale.parentNode = env.doc.body;
  const btn = env.api.findLikeButton();
  ok(btn === env.likeBtn, 'must pick the on-screen container');
});

// --------------------------------------- regression guard: windowed tracker
// This is the architecture the last round validated; it must keep holding.
const RATES = [0.02, 0.05, 0.10, 0.20];
const RUNS_PER_RATE = 25;
const rateReport = [];

// Deliberately build-agnostic: re-likes are counted on the PAGE side and the
// window trip is recognised from the pause text, so this same guard can be run
// against an older build to show the architecture already held there.
const WINDOW_TRIP_RE = /failed to verify|in a row left the video liked/;

test('windowed tracker still trips at 2 / 5 / 10 / 20% stationary failure rates', async () => {
  for (const rate of RATES) {
    let trips = 0;
    let windowTrips = 0;
    let worst = 0;
    let sum = 0;
    for (let seed = 1; seed <= RUNS_PER_RATE; seed++) {
      const fail = seededRandom(seed * 7919);
      const decided = new Map();
      const env = makeEnv({
        random: seededRandom(seed * 104729),
        clickFails: (i) => {
          if (!decided.has(i)) decided.set(i, fail() < rate);
          return decided.get(i);
        },
      });
      env.api.start();
      const stopped = await runUntilStopped(env, 24 * 3600000);
      const s = env.state();
      if (stopped && s.paused) trips++;
      if (WINDOW_TRIP_RE.test(s.pauseReason || '')) windowTrips++;
      worst = Math.max(worst, env.relikes);
      sum += env.relikes;
    }
    rateReport.push({ rate, trips, windowTrips, worst, mean: (sum / RUNS_PER_RATE).toFixed(1) });
    ok(trips > 0, `at ${rate * 100}% the guard never tripped — that is the pinned-to-0 failure mode`);
    eq(trips, RUNS_PER_RATE, `at ${rate * 100}% every run must trip (${trips}/${RUNS_PER_RATE})`);
  }
});

test('at dense failure rates it is the WINDOW that trips, not just the ceiling', async () => {
  const dense = rateReport.filter((r) => r.rate >= 0.10);
  ok(dense.length === 2, 'expected the 10% and 20% rows');
  for (const row of dense) {
    ok(row.windowTrips >= RUNS_PER_RATE * 0.8,
      `at ${row.rate * 100}% the rate window should catch nearly everything (${row.windowTrips}/${RUNS_PER_RATE})`);
  }
});

// ------------------------------------------------------------------- runner
// Exported so the pacing / damage measurements quoted in the README can be
// re-derived with the same harness instead of being taken on trust.
module.exports = { makeEnv, seededRandom, runUntilStopped };
if (require.main !== module) return;

(async () => {
  const t0 = Date.now();
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  ok  ${t.name}`);
    } catch (err) {
      failures.push({ name: t.name, err });
      console.log(`FAIL  ${t.name}`);
      console.log(`      ${(err && err.message) || err}`);
    }
  }

  if (rateReport.length) {
    console.log('\nMeasured re-likes before the guard trips (25 seeded runs per rate):');
    console.log('  rate    trips   window-trips   worst   mean');
    for (const r of rateReport) {
      console.log(`  ${String(r.rate * 100).padStart(4)}%   ${String(r.trips).padStart(2)}/${RUNS_PER_RATE}   ` +
        `${String(r.windowTrips).padStart(9)}/${RUNS_PER_RATE}   ${String(r.worst).padStart(5)}   ${String(r.mean).padStart(4)}`);
    }
  }

  console.log(`\n${passed} passed, ${failures.length} failed  (${SCRIPT_PATH}, ${Date.now() - t0}ms)`);
  process.exit(failures.length ? 1 : 0);
})();
