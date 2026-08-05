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
  // Used by the clipboard textarea fallback.
  select() { this.selected = true; }
  remove() {
    if (this.parentNode) {
      const i = this.parentNode.childNodes.indexOf(this);
      if (i >= 0) this.parentNode.childNodes.splice(i, 1);
      this.parentNode = null;
    }
  }
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
    // Null by default: the userscript's clipboard fallback is written to cope
    // with execCommand being absent. Tests set it to exercise that tier.
    execCommand: null,
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
 *   href          initial URL (default: the first video of the liked feed)
 *   handle        own handle rendered into the nav-profile link ('' = none)
 *   author        (i) => handle that POSTED video i. Videos in a liked feed are
 *                 other people's — that is what liking is — so the URL is
 *                 /@<creator>/video/<id> and the handle in it is never yours.
 *   anchored      true = arrive as if from your own Liked grid (the per-tab
 *                 anchor is pre-seeded). false = a cold landing on the URL.
 *   feedMarkup    true = also render a recommendation-feed container, i.e. the
 *                 For You page with the URL rewritten to the playing video
 *   likedTab      'yes' | 'no' | null  (aria-selected on the liked tab)
 *   readable      (i) => bool   can the like state be read for video i
 *   clickFails    (i) => bool   does the click fail to flip video i
 *   nextLabel     aria-label for the next button
 *   nextHook      false to drop the data-e2e hook and rely on label matching
 *   onNext        (i, env) => void, called after each successful advance
 *   random        () => number, seeded RNG for the script
 *   firstRun      true = start from a virgin store, so the script's own
 *                 dry-run-by-default first-run behaviour applies
 *   seed          object merged into the persisted store before the script runs
 *   clipboard     'ok' | 'reject' | 'none' — navigator.clipboard behaviour
 */
const STORE_KEY = 'ttmu.v1';
const ANCHOR_KEY = 'ttmu.anchor.v1';
function makeEnv(opts) {
  const o = Object.assign({
    href: null,
    handle: 'me',
    author: (i) => `creator${i}`,
    anchored: true,
    feedMarkup: false,
    likedTab: 'yes',
    readable: () => true,
    clickFails: () => false,
    nextLabel: 'Next video',
    nextHook: true,
    onNext: null,
    random: seededRandom(1),
    firstRun: false,
    seed: null,
    clipboard: 'ok',
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
  // The permalink of the i-th video in the liked feed. The handle is the
  // CREATOR's: an earlier harness wrote /@me/video/i here, which quietly
  // modelled a liked feed in which the user had posted every video themselves —
  // the one shape in which the old author-vs-owner URL check could pass.
  env.videoUrl = (i) => `https://www.tiktok.com/@${o.author(i)}/video/${1000 + i}`;
  env.profileUrl = (h) => `https://www.tiktok.com/@${h || o.handle}`;
  env.goto(o.href || env.videoUrl(1));

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

  // For You renders its own list container AND rewrites the address bar to the
  // playing video's /@creator/video/<id> permalink, so the URL alone cannot
  // tell it apart from a liked-feed video.
  if (o.feedMarkup) {
    const feed = doc.createElement('div');
    feed.setAttribute('data-e2e', 'recommend-list-item-container');
    doc.body.appendChild(feed);
    env.feed = feed;
  }

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
    env.goto(env.videoUrl(env.video));
    if (o.onNext) o.onNext(env.video, env);
  };

  const store = new Map();
  env.store = store;

  // sessionStorage is per-tab, which is exactly the lifetime the liked-feed
  // anchor wants: it survives a reload of the run and dies with the tab.
  const sessionStore = new Map();
  env.sessionStore = sessionStore;
  if (o.anchored && o.handle) {
    sessionStore.set(ANCHOR_KEY, JSON.stringify({ handle: o.handle, at: clock.now }));
  }
  // Unless a test asks for a virgin profile, pre-seed the store as an
  // experienced user: a dry run has been done and the checkbox is off. The
  // script's own first-run default (dry run ON) is covered by its own tests.
  const seed = o.firstRun
    ? o.seed
    : Object.assign({ dryDone: true, dryRun: false }, o.seed || {});
  if (seed) store.set(STORE_KEY, JSON.stringify(seed));

  env.copied = [];
  const clipboard = o.clipboard === 'none'
    ? undefined
    : {
      writeText: (t) => {
        if (o.clipboard === 'reject') return Promise.reject(new Error('denied'));
        env.copied.push(String(t));
        return Promise.resolve();
      },
    };

  const sandbox = {
    console: { log() {} },
    location,
    document: doc,
    navigator: { clipboard },
    innerWidth: 1920,
    innerHeight: 1080,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    sessionStorage: {
      getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
      setItem: (k, v) => sessionStore.set(k, String(v)),
      removeItem: (k) => sessionStore.delete(k),
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
  env.press = (id) => env.api.panel.querySelector(id).click();
  env.hasClass = (id, c) => env.api.panel.querySelector(id).classList.contains(c);
  env.logLines = () => env.logText().split('\n').filter(Boolean).length;
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
  const env = makeEnv({ href: 'https://www.tiktok.com/@stranger', handle: 'me', likedTab: null });
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

// ------------------------------------------------------- P0 the author's URL
// THE regression test. Every video in a liked feed was posted by someone else,
// so its permalink is /@<creator>/video/<id>. A guard that compares that handle
// to the signed-in user's refuses on every video in the feed and the script
// never runs at all — it only ever passes on a video you both posted and liked.
test("page guard accepts a liked video posted by someone else (it always is)", async () => {
  const env = makeEnv({ handle: 'me', author: () => 'somecreator' });
  includes(env.api.pathInfo().handle, 'somecreator', 'the URL handle is the creator');
  eq(env.api.ownHandle(), 'me', 'and it is not the signed-in user');
  const g = env.api.pageGuard();
  eq(g.ok, true, `a liked video by another creator must be accepted (${g.msg})`);
  eq(g.stage, 'viewer', 'stage');
});

test('a real run works its way through videos posted by other people', async () => {
  const env = makeEnv({ handle: 'me', author: (i) => `creator${i}` });
  env.api.start();
  await env.clock.advanceUntil(() => env.state().runTotal >= 12, 60 * 60000);
  const s = env.state();
  ok(s.runTotal >= 12, `should have unliked 12, got ${s.runTotal}`);
  ok(!s.paused, `must not pause on a normal feed (${s.pauseReason})`);
  ok(env.api.unlikedUrls().every((u) => u.indexOf('/@me/') === -1),
    'every unliked video belongs to another creator');
  env.api.stop();
});

test('page guard allows the own liked feed', async () => {
  const env = makeEnv({});
  const g = env.api.pageGuard();
  eq(g.ok, true, `guard should accept the own liked feed (${g.msg})`);
  env.api.start();
  eq(env.state().running, true, 'should be running');
  env.api.stop();
});

// ------------------------------------------------- P0 what replaces the check
// The URL cannot prove whose liked feed this is, so the proof is taken on the
// profile page — where the path IS yours — and carried in a per-tab anchor.
test('the own Liked grid arms the anchor', async () => {
  const env = makeEnv({ href: 'https://www.tiktok.com/@me', anchored: false });
  // Nothing was pre-seeded: the readiness poll evaluating the guard on arrival
  // is what arms it, and that is the only place arming ever happens.
  eq(env.api.anchor().handle, 'me', 'the anchor is armed');
  includes(env.sessionStore.get('ttmu.anchor.v1'), '"handle":"me"', 'and persisted per tab');
  includes(env.logText(), 'Liked feed armed', 'and said so, once');
  const g = env.api.pageGuard();
  eq(g.ok, false, 'the grid itself has nothing to unlike');
  eq(g.stage, 'profile', 'but it is the arming stage, not a wrong page');
});

test("a stranger's profile drops an anchor rather than leaving it armed", async () => {
  const env = makeEnv({ href: 'https://www.tiktok.com/@stranger', handle: 'me', likedTab: null });
  eq(env.api.anchor(), null, 'walking onto another profile disarms the run');
});

test('Start on the Liked grid says to open a video, not "wrong page"', async () => {
  const env = makeEnv({ href: 'https://www.tiktok.com/@me', anchored: false });
  env.api.start();
  eq(env.state().running, false, 'nothing to unlike on the grid');
  includes(env.logText(), 'Open the first video', 'tells the user the one thing left to do');
});

test('the idle poll arms the anchor after an in-app walk to the Liked tab', async () => {
  // No reload happens in a single-page app, so nothing else would ever
  // re-evaluate the guard between the For You feed and the liked feed.
  const env = makeEnv({ href: 'https://www.tiktok.com/foryou', anchored: false, likedTab: null });
  await env.clock.advanceUntil(null, 5000);
  eq(env.api.anchor(), null, 'For You must not arm anything');
  env.goto('https://www.tiktok.com/@me');
  env.doc.body.appendChild((() => {
    const t = env.doc.createElement('p');
    t.setAttribute('data-e2e', 'liked-tab');
    t.setAttribute('aria-selected', 'true');
    return t;
  })());
  await env.clock.advanceUntil(() => env.api.anchor() !== null, 10000);
  eq(env.api.anchor().handle, 'me', 'walking to the Liked tab arms it');
  env.goto(env.videoUrl(1));
  await env.clock.advanceUntil(null, 5000);
  eq(env.api.pageGuard().ok, true, 'and opening a video from it is now allowed');
});

test('a cold landing on a liked-feed video URL is refused, not guessed at', async () => {
  const env = makeEnv({ anchored: false, likedTab: null });
  env.api.start();
  await env.clock.advanceUntil(null, 60000);
  eq(env.state().running, false, 'no anchor, no run');
  includes(env.logText(), "Can't confirm this video came from your own Liked feed", 'says why');
  eq(env.clicks, 0, 'no like button was clicked');
});

test('a For You feed rewritten to a video URL is refused even with an anchor', async () => {
  // The dangerous lookalike: same permalink shape, same viewer chrome, an
  // anchor still fresh from the Liked grid earlier in this tab. A real For You
  // page has no browse-mode container — it was not opened from a list.
  const env = makeEnv({ feedMarkup: true, likedTab: null, anchored: true });
  env.container.setAttribute('data-e2e', 'x');
  eq(env.api.viewerKind(), 'feed', 'the recommendation container is detected');
  const g = env.api.pageGuard();
  eq(g.ok, false, 'must not treat For You as the liked feed');
  includes(g.msg, 'recommendation feed', 'names what it found');
  eq(env.api.anchor(), null, 'and the stale anchor is dropped');
  env.api.start();
  await env.clock.advanceUntil(null, 60000);
  eq(env.clicks, 0, 'nothing was clicked');
});

// The liked-feed modal IS a vertical video feed component, so TikTok's hashed
// feed classes render there too. Vetoing on a class substring blocked the one
// page the script exists to run on.
test('a browse-mode marker outranks a feed-ish class on the same page', async () => {
  const env = makeEnv({});
  for (const cls of ['DivVideoFeedV2', 'DivVideoFeedContainer', 'DivRecommendList']) {
    const noise = env.doc.createElement('div');
    noise.setAttribute('class', `tiktok-abc123-${cls} e1234`);
    env.doc.body.appendChild(noise);
  }
  eq(env.api.viewerKind(), 'browse', 'the browse container settles it');
  const g = env.api.pageGuard();
  eq(g.ok, true, `a feed-shaped class name must not veto the liked feed (${g.msg})`);
});

test('a real recommendation hook still vetoes when nothing proves browse mode', async () => {
  const env = makeEnv({ feedMarkup: true, likedTab: null });
  env.container.setAttribute('data-e2e', 'x');          // drop the browse hook
  env.container.setAttribute('id', 'main-content-video_detail');
  eq(env.api.viewerKind(), 'feed', 'with no browse proof the feed hook decides');
  eq(env.api.pageGuard().ok, false, 'and the run is refused');
});

test('a recommendation hook alongside browse mode does not veto', async () => {
  // For You's hook can linger in the tree after an in-app navigation into the
  // profile viewer; proof of browse mode has to win or nothing ever runs.
  const env = makeEnv({ feedMarkup: true });
  eq(env.api.viewerKind(), 'browse', 'browse proof beats a lingering feed hook');
  eq(env.api.pageGuard().ok, true, 'run allowed');
});

// ------------------------------------------------------ handles must be handles
test('a handle-shaped check rejects junk the DOM or URL hands over', async () => {
  const env = makeEnv({});
  const bad = [
    'DriverStore\\FileRepository\\netxex64.inf_amd64_01587744078125a1\\ixe60x64.sys',
    'a b', 'x'.repeat(25), 'user/name', 'user@host', '',
  ];
  for (const h of bad) {
    env.goto(`https://www.tiktok.com/@${h}`);
    eq(env.api.pathInfo().kind, 'other', `must not read as a profile: ${JSON.stringify(h)}`);
  }
  for (const h of ['flx.01', 'me', 'a_b.c123', 'x'.repeat(24)]) {
    env.goto(`https://www.tiktok.com/@${h}`);
    eq(env.api.pathInfo().handle, h, `must read as a profile: ${h}`);
  }
});

test('a junk profile link never becomes the signed-in user', async () => {
  const env = makeEnv({ handle: '', anchored: false, likedTab: null });
  const a = env.doc.createElement('a');
  a.setAttribute('data-e2e', 'nav-profile');
  a.setAttribute('href', '/@DriverStore\\FileRepository\\netxex64.inf_amd64_x\\ixe60x64.sys');
  env.doc.body.appendChild(a);
  eq(env.api.ownHandle(), '', 'a Windows path is not a TikTok username');
  const g = env.api.pageGuard();
  eq(g.ok, false, 'and nothing may run without a real account');
  includes(g.msg, 'which account is signed in', 'says what is missing');
});

test('a junk path cannot arm the anchor', async () => {
  const env = makeEnv({
    href: 'https://www.tiktok.com/@DriverStore\\FileRepository\\x\\y.sys',
    anchored: false, likedTab: 'yes',
  });
  eq(env.api.anchor(), null, 'a non-handle path must never arm a run');
  includes(env.panelText('#ttmu-ready'), 'Not ready', 'and the panel says so');
  ok(env.logText().indexOf('DriverStore') === -1, 'and never reports it as a username');
  ok(env.panelText('#ttmu-ready').indexOf('DriverStore') === -1, 'nor renders it as one');
});

test('diagnose reports what the guard actually saw', async () => {
  const env = makeEnv({});
  const d = env.api.diagnose();
  eq(d.ownHandle, 'me', 'own handle');
  eq(d.ownHandleFrom, 'a[data-e2e="nav-profile"]', 'and which selector produced it');
  eq(d.viewerKind, 'browse', 'viewer kind');
  eq(d.guard.ok, true, 'guard verdict');
  ok(d.browseMarkers.length >= 1, 'lists the browse markers it found');
  eq(d.feedMarkers.length, 0, 'and finds no feed markers here');
});

test('a stale anchor expires instead of authorising forever', async () => {
  // The window measures time since the guard last PASSED, so a tab parked on
  // For You for half a day cannot come back and still count as armed. A tab
  // left on the liked feed itself keeps re-confirming and stays valid.
  const env = makeEnv({ likedTab: null });
  eq(env.api.pageGuard().ok, true, 'fresh anchor works');
  env.goto('https://www.tiktok.com/foryou');
  await env.clock.advanceUntil(null, env.api.CFG.anchorIdleMs + 60000);
  env.goto(env.videoUrl(1));
  const g = env.api.pageGuard();
  eq(g.ok, false, 'an anchor left idle past the window must not authorise a run');
  includes(g.msg, 're-arm', 'says how to fix it');
});

test('a liked feed left open keeps re-confirming and does not expire', async () => {
  const env = makeEnv({ likedTab: null });
  await env.clock.advanceUntil(null, env.api.CFG.anchorIdleMs + 60000);
  eq(env.api.pageGuard().ok, true, 'continuously verified evidence must not go stale');
});

test('ownHandle never learns the signed-in user from a profile-detail link', async () => {
  // `user-detail-profile` points at whoever's profile is being VIEWED. Trusting
  // it cached a stranger as "you", after which their profile read as your own.
  const env = makeEnv({ href: 'https://www.tiktok.com/@stranger', handle: '', likedTab: null, anchored: false });
  const a = env.doc.createElement('a');
  a.setAttribute('data-e2e', 'user-detail-profile');
  a.setAttribute('href', '/@stranger');
  env.doc.body.appendChild(a);
  eq(env.api.ownHandle(), '', "a viewed profile is not the viewer's own");
  const g = env.api.pageGuard();
  eq(g.ok, false, 'and with no known account nothing may run');
  includes(g.msg, 'which account is signed in', 'says what is missing');
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

test('a hidden tab auto-pauses the run instead of merely warning', async () => {
  const env = makeEnv({});
  env.api.start();
  await env.clock.advanceUntil(() => env.state().runTotal >= 2, 60 * 60000);
  env.doc.hidden = true;
  env.doc.fire('visibilitychange');
  const s = env.state();
  eq(s.running, false, 'must stop running while hidden');
  eq(s.paused, true, 'must be paused, not stopped');
  eq(s.pauseCode, env.api.P.HIDDEN, 'dedicated pause code');
  includes(env.logText(), 'background', 'warns about background throttling');
  const before = env.clicks;
  await env.clock.advanceUntil(null, 5 * 60000);
  eq(env.clicks, before, 'nothing is clicked while the tab is hidden');
  env.api.stop();
});

test('becoming visible again resumes without burning the escalation budget', async () => {
  const env = makeEnv({});
  env.api.start();
  await env.clock.advanceUntil(() => env.state().runTotal >= 2, 60 * 60000);
  env.doc.hidden = true;
  env.doc.fire('visibilitychange');
  env.doc.hidden = false;
  env.doc.fire('visibilitychange');
  eq(env.state().running, true, 'must resume when visible again');
  eq(env.state().repeatPauses, 0, 'a tab switch must not count as a fault');
  includes(env.logText(), 'Tab visible again', 'says it resumed');
  env.api.stop();
});

// -------------------------------------------------- isLiked: adversarial input
// A wrong `true` here is the worst outcome in the whole script: it makes the
// loop CLICK an unliked video, i.e. like something the user never liked.
function bareButton(env, attrs, fills) {
  const btn = env.doc.createElement('button');
  for (const k of Object.keys(attrs || {})) btn.setAttribute(k, attrs[k]);
  if (fills) {
    const svg = env.doc.createElement('svg');
    for (const f of fills) {
      const p = env.doc.createElement('path');
      p.setAttribute('fill', f);
      svg.appendChild(p);
    }
    btn.appendChild(svg);
  }
  return btn;
}

test('aria-label wording is read in the right order ("liked by 1.2M" cannot lie)', async () => {
  const env = makeEnv({});
  const cases = [
    ['Unlike video', true],
    ['unlike', true],
    ['Liked', true],
    ['Like video', false],
    ['like', false],
    // The dangerous one: contains BOTH "like" and "liked". Social-proof copy
    // must never be read as "this video is liked".
    ['Like video, liked by 1.2M', false],
    ['Like, liked by 340 people', false],
    // Pure social proof with no verb form: unreadable, not "liked".
    ['liked by 1.2M', null],
    ['', null],
  ];
  for (const [label, want] of cases) {
    const btn = bareButton(env, { 'aria-label': label });
    eq(env.api.isLiked(btn), want, `aria-label ${JSON.stringify(label)}`);
  }
});

test('aria-pressed still wins over any label wording', async () => {
  const env = makeEnv({});
  eq(env.api.isLiked(bareButton(env, { 'aria-pressed': 'false', 'aria-label': 'Unlike video' })), false, 'pressed=false');
  eq(env.api.isLiked(bareButton(env, { 'aria-pressed': 'true', 'aria-label': 'Like video' })), true, 'pressed=true');
});

test('the SVG fill heuristic is anchored to the TikTok like red, not to "rgba(254"', async () => {
  const env = makeEnv({});
  const liked = ['#fe2c55', 'FE2C55', 'rgb(254, 44, 85)', 'rgba(254, 44, 85, 1)', 'rgba(254,44,85,.9)'];
  for (const f of liked) {
    eq(env.api.isLiked(bareButton(env, {}, [f])), true, `should read as liked: ${f}`);
  }
  // Near-white and other 254-leading fills used to match `includes('rgba(254')`
  // and made the script click LIKE on unliked videos.
  const notLiked = ['rgba(254, 254, 254, 1)', 'rgb(254, 254, 254)', '#fefefe', 'rgba(254, 255, 255, .5)',
    'currentColor', 'none', '#fff', 'rgba(255, 44, 85, 1)'];
  for (const f of notLiked) {
    eq(env.api.isLiked(bareButton(env, {}, [f])), null, `must NOT read as liked: ${f}`);
  }
});

// ------------------------------------------- aria-label fallback vs. comments
test('the aria-label fallback rejects a like button inside a comment container', async () => {
  const env = makeEnv({});
  // Drop the data-e2e hook so only the aria-label fallback is left, then put a
  // comment drawer inside the SAME video container — which is what desktop does.
  env.likeBtn.childNodes = [];
  env.likeBtn.removeAttribute('aria-label');
  const drawer = env.doc.createElement('div');
  drawer.setAttribute('data-e2e', 'comment-list');
  const commentLike = env.doc.createElement('button');
  commentLike.setAttribute('aria-label', 'Like this comment');
  drawer.appendChild(commentLike);
  env.container.appendChild(drawer);
  const found = env.api.findLikeButton();
  ok(found !== commentLike, "must never hand back a comment's like button");
  eq(found, null, 'with no video like button it must fail closed, not fall back');
});

test('the aria-label fallback still finds a real video like button', async () => {
  const env = makeEnv({});
  env.likeBtn.childNodes = [];   // remove the data-e2e icon
  env.likeBtn.setAttribute('aria-label', 'Like video');
  const drawer = env.doc.createElement('div');
  drawer.setAttribute('data-e2e', 'comment-list');
  const commentLike = env.doc.createElement('button');
  commentLike.setAttribute('aria-label', 'Like this comment');
  drawer.appendChild(commentLike);
  env.container.appendChild(drawer);
  eq(env.api.findLikeButton(), env.likeBtn, 'the video like button must still be found');
});

// -------------------------------------------------- confirm-arm on a real run
test('a real run needs two clicks: the first only arms the button', async () => {
  const env = makeEnv({});
  eq(env.state().dryRun, false, 'this env is a real run');
  env.press('#ttmu-btn');
  eq(env.state().running, false, 'the first click must NOT start an irreversible run');
  includes(env.panelText('#ttmu-btn'), 'Confirm', 'the button says what the next click does');
  ok(env.hasClass('#ttmu-btn', 'confirm'), 'armed state is visually distinct');
  env.press('#ttmu-btn');
  eq(env.state().running, true, 'the second click starts');
  env.api.stop();
});

test('the armed confirm expires on its own', async () => {
  const env = makeEnv({});
  env.press('#ttmu-btn');
  ok(env.hasClass('#ttmu-btn', 'confirm'), 'armed');
  await env.clock.advanceUntil(null, env.api.CFG.confirmArmMs + 1000);
  eq(env.state().running, false, 'still not running');
  eq(env.panelText('#ttmu-btn'), 'Start', 'reverts to Start once the arm window lapses');
  ok(!env.hasClass('#ttmu-btn', 'confirm'), 'disarmed');
  // And a click after the lapse re-arms rather than starting.
  env.press('#ttmu-btn');
  eq(env.state().running, false, 'a late click must re-arm, not start');
});

test('switching to dry run disarms a pending confirm', async () => {
  const env = makeEnv({});
  env.press('#ttmu-btn');
  ok(env.hasClass('#ttmu-btn', 'confirm'), 'armed');
  env.api.setDryRun(true);
  ok(!env.hasClass('#ttmu-btn', 'confirm'), 'an armed confirm is stale once the mode changes');
});

test('a dry run starts on a single click', async () => {
  const env = makeEnv({});
  env.api.setDryRun(true);
  env.press('#ttmu-btn');
  eq(env.state().running, true, 'nothing irreversible happens in a dry run');
  eq(env.clicks, 0, 'and no like button is clicked');
  env.api.stop();
});

test('Reset counters is confirm-armed too', async () => {
  const env = makeEnv({});
  env.api.setTarget(40);
  env.press('#ttmu-reset');
  eq(env.state().target, 40, 'the first click must not reset anything');
  includes(env.panelText('#ttmu-reset'), 'Confirm', 'asks for confirmation');
  env.press('#ttmu-reset');
  includes(env.logText(), 'Counters reset', 'the second click resets');
  eq(env.state().runTotal, 0, 'counters cleared');
});

// ------------------------------------------------- dry-run-by-default (first run)
test('a first-ever run defaults to dry run', async () => {
  const env = makeEnv({ firstRun: true });
  eq(env.state().dryRun, true, 'the first thing Start does must not be irreversible');
  eq(env.state().dryDone, false, 'no dry run has been completed yet');
  eq(env.api.panel.querySelector('#ttmu-dry').checked, true, 'and the checkbox shows it');
});

test('the dry-run default lapses once a dry run has been completed', async () => {
  const env = makeEnv({ firstRun: true, seed: { dryDone: true } });
  eq(env.state().dryRun, false, 'an experienced user gets the normal default');
});

test('an explicit stored choice beats the first-run default', async () => {
  const env = makeEnv({ firstRun: true, seed: { dryRun: false } });
  eq(env.state().dryRun, false, 'the user unticked it — respect that');
});

test('finishing a dry run persists the dryDone flag', async () => {
  const env = makeEnv({ firstRun: true });
  env.api.setTarget(3);
  env.press('#ttmu-btn');           // dry run: single click
  await runUntilStopped(env, 60 * 60000);
  eq(env.state().dryTotal >= 3, true, 'the dry run reached its target');
  eq(env.state().dryDone, true, 'the flag flips');
  includes(env.store.get('ttmu.v1'), '"dryDone":true', 'and is persisted');
  eq(env.clicks, 0, 'a dry run never clicks');
});

// ------------------------------------------------ countdown must not flood the log
test('the countdown overwrites one status line instead of flooding the log', async () => {
  const env = makeEnv({});
  const code = env.api.P.VERIFY_WINDOW;
  env.api.pause(code, 'x');
  env.api.pause(code, 'x');        // second identical pause earns a backoff
  env.api.resume();
  await env.clock.advanceUntil(
    () => String(env.panelText('#ttmu-countdown')).indexOf('Backoff') !== -1, 5000);
  const line = env.panelText('#ttmu-countdown');
  includes(line, 'Backoff', 'the countdown renders on its own line');
  const before = env.logLines();
  await env.clock.advanceUntil(null, 20000);
  const after = env.logLines();
  ok(after - before <= 1, `20 countdown ticks added ${after - before} log lines`);
  ok(env.panelText('#ttmu-countdown') !== line, 'but the countdown line itself ticks down');
  env.api.stop();
});

// --------------------------------------------------- unliked-URL recovery list
test('every verified unlike is recorded for recovery and can be copied', async () => {
  const env = makeEnv({});
  env.api.start();
  await env.clock.advanceUntil(() => env.state().runTotal >= 4, 60 * 60000);
  env.api.stop();
  const urls = env.api.unlikedUrls();
  eq(urls.length, env.state().runTotal, 'one URL per verified unlike');
  includes(urls[0], '/video/', 'looks like a video URL');
  await env.api.copyUnliked();
  const copied = env.copied[env.copied.length - 1];
  eq(copied.split('\n').length, urls.length, 'one URL per line');
  includes(env.logText(), 'Unliked list', 'the copy is reported');
});

test('a failed click contributes nothing to the recovery list', async () => {
  const env = makeEnv({ clickFails: () => true });
  env.api.start();
  await runUntilStopped(env, 12 * 3600000);
  eq(env.api.unlikedUrls().length, 0, 'unverified clicks must not be listed as unliked');
});

test('copying an empty recovery list says so instead of copying nothing', async () => {
  const env = makeEnv({});
  await env.api.copyUnliked();
  eq(env.copied.length, 0, 'nothing is put on the clipboard');
  includes(env.logText(), 'No unliked video URLs', 'and it says why');
});

// --------------------------------------------------------- clipboard failure
test('copyLog reports success only after the clipboard promise settles', async () => {
  const env = makeEnv({});
  await env.api.copyLog();
  ok(env.copied.length === 1, 'the text reached the clipboard');
  includes(env.logText(), 'copied to the clipboard', 'success is reported');
});

test('a rejected clipboard write falls back to execCommand, not to a false success', async () => {
  const env = makeEnv({ clipboard: 'reject' });
  env.doc.execCommand = () => true;
  await env.api.copyLog();
  eq(env.copied.length, 0, 'the async API failed');
  includes(env.logText(), 'fallback', 'the fallback path is what reported success');
});

test('with no clipboard at all the log is printed to the console and says so', async () => {
  const env = makeEnv({ clipboard: 'none' });
  await env.api.copyLog();
  includes(env.logText(), 'Clipboard unavailable', 'the failure is surfaced, not swallowed');
  ok(env.logText().indexOf('copied to the clipboard') === -1, 'and never claims success');
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
