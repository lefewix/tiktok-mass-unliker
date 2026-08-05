// ==UserScript==
// @name         TikTok Mass Unliker
// @namespace    flxtcg.tools
// @version      2.1.0
// @description  Gradually unlikes videos while browsing your own Liked feed. Anchored liked-feed page guard, confirm-armed start, dry-run-by-default first run, paced clicking, windowed + cumulative click verification, container-scoped selectors, session caps, target count, unliked-URL export, and a movable start/stop panel.
// @author       Felix Wang
// @license      MIT
// @match        https://www.tiktok.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------------- Config ----------------
  const CFG = {
    sessionCapMin: 50,        // session cap is rolled randomly in this range
    sessionCapMax: 150,       //   at the start of each session
    processedCapFactor: 2,    // also break after cap * this many videos seen
    sessionBreakMinMs: 3 * 60000,   // break between sessions: min (3 min)
    sessionBreakMaxMs: 7 * 60000,   // break between sessions: max (7 min)
    delayMinMs: 1500,         // min wait between videos
    delayMaxMs: 5000,         // max wait between videos
    clickJitterMs: 400,       // random pause between "seeing" and clicking
    verifyMinMs: 300,         // wait before re-reading the like state after a click
    verifyMaxMs: 500,
    strikes: 6,               // consecutive "no like button" failures before pausing
    missWaitMs: 4000,         //   wait after the first miss, growing per strike
    missWaitMaxMs: 9000,      //   ~39s of total patience for a lazy load

    // Failure tracking is WINDOWED, not consecutive-only: an alternating
    // good/bad pattern resets a consecutive counter forever, so a rolling
    // failure rate is what actually bounds the damage. The consecutive trip
    // is kept as a fast path for the obvious case.
    verifyWindow: 10,         // remember the last N click verifications
    verifyWindowFails: 3,     //   pause at this many failures inside the window
    verifyConsecutive: 2,     //   fast path: this many in a row still-liked
    navWindow: 10,            // remember the last N navigation attempts
    navWindowFails: 3,        //   pause at this many failures inside the window
    navConsecutive: 3,        //   fast path: this many failed advances in a row

    // A window bounds the failure RATE, not the total: a perfectly periodic
    // 1-in-5 failure pattern never fills a window and would otherwise re-like
    // videos forever. This is the absolute per-run ceiling on top of it.
    verifyFailCeiling: 10,

    // Determinacy: isLiked() returning null records nothing about clicks, so a
    // DOM change used to run silently for hours with runTotal stuck at 0.
    detWindow: 10,            // remember the last N like-state reads
    detWindowFails: 6,        //   pause at this many unreadable reads in the window
    detConsecutive: 4,        //   fast path: this many unreadable in a row

    sessionIdleMs: 12 * 3600000, // persisted session window expires after 12h idle
    // The liked-feed anchor (see the page guard) goes stale after this much
    // IDLE time. A running loop re-confirms it every iteration, so only real
    // idling counts against it.
    anchorIdleMs: 4 * 3600000,
    readyPollMs: 2000,        // how often the idle readiness/arming poll runs
    resumeBackoffMs: 30000,   // first backoff after a repeated same-reason pause
    resumeBackoffMaxMs: 5 * 60000,
    resumeGiveUpAfter: 5,     // refuse to resume after this many identical pauses
    logHistory: 40,           // lines of scrollback kept in the panel log
    confirmArmMs: 5000,       // how long an armed confirm button stays armed
    urlHistoryMax: 2000,      // unliked-URL recovery list cap (persisted)
  };

  // Stable pause CODES. Escalation (backoff, then refusal) keys on these, never
  // on the human-readable reason: window trips embed live counters, so three
  // different failure patterns produced three different strings and silently
  // disarmed the 5-strike give-up counter.
  const P = {
    GUARD: 'guard',
    NO_LIKE_BTN: 'no-like-button',
    INDETERMINATE: 'indeterminate',
    VERIFY_STREAK: 'verify-streak',
    VERIFY_WINDOW: 'verify-window',
    VERIFY_CEILING: 'verify-ceiling',
    NAV_STREAK: 'nav-streak',
    NAV_WINDOW: 'nav-window',
    NAV_LABELS: 'nav-labels',
    HIDDEN: 'hidden-tab',
    ERROR: 'error',
  };

  // ---------------- Storage ----------------
  const KEY = 'ttmu.v1';
  const hasGM =
    typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

  function readStore() {
    try {
      const raw = hasGM
        ? GM_getValue(KEY, null)
        : localStorage.getItem(KEY);
      if (!raw) return {};
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      return {};
    }
  }

  // Caveat: without GM_* grants this falls back to page-shared localStorage,
  // which the page's own scripts can read/clear and which is wiped by a
  // "clear site data". Counters and the unliked-URL list are best-effort there.
  function writeStore(obj) {
    try {
      const raw = JSON.stringify(obj);
      if (hasGM) GM_setValue(KEY, raw);
      else localStorage.setItem(KEY, raw);
    } catch (e) {
      /* storage unavailable — run in memory only */
    }
  }

  // ---------------- State ----------------
  let running = false;
  let paused = false;
  let pauseReason = '';
  let pauseCode = '';
  let dryRun = false;
  let target = 0;      // 0 = no target

  let unliked = 0;     // successful unlikes in the current cap window
  let processed = 0;   // videos seen in the current cap window
  let runTotal = 0;    // real unlikes this session (persisted)
  let dryTotal = 0;    // dry-run "would unlike" count this session (persisted)
  let total = 0;       // lifetime real unlikes (persisted)
  let session = 1;     // current session number
  let sessionCap = 0;  // rolled per cap window

  let attempts = 0;         // real unlike clicks attempted this session (persisted)
  let verifyFailsTotal = 0; // clicks that did NOT verify, cumulative (persisted)

  let missing = 0;     // consecutive "no like button" failures
  let loopPromise = null;
  let mode = 'idle';   // idle | running | break | paused | done

  let lastActivity = Date.now(); // only real work refreshes the session clock
  let lastPauseCode = '';
  let repeatPauses = 0;
  let resumeBackoffMs = 0;
  let ownHandleCache = '';
  let hiddenAutoPaused = false; // auto-paused because the tab went to the background
  let dryDone = false;   // a dry run has been completed at least once (persisted)
  let unlikedUrls = [];  // URLs of successfully unliked videos (recovery list)
  let uiPos = null;      // {x, y} panel position when the user has dragged it
  let uiCollapsed = false;

  // The log used to be a single overwritten line, so a warning was readable for
  // a couple of seconds and then gone. Keep a capped, selectable scrollback.
  const logHist = [];

  const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

  // ---------------- Windowed failure tracker ----------------
  // Keeps the last `size` outcomes plus a consecutive-failure count. Tripping
  // on EITHER a consecutive run or a failure rate inside the window means an
  // alternating success/failure pattern can no longer run forever.
  function tracker(size, windowFails, consecutiveFails) {
    return { size, windowFails, consecutiveFails, hist: [], streak: 0 };
  }

  function record(t, ok) {
    t.hist.push(!!ok);
    if (t.hist.length > t.size) t.hist.shift();
    t.streak = ok ? 0 : t.streak + 1;
    return t;
  }

  const failCount = (t) => t.hist.reduce((n, ok) => n + (ok ? 0 : 1), 0);
  const streakTripped = (t) => t.streak >= t.consecutiveFails;
  const windowTripped = (t) => failCount(t) >= t.windowFails;
  const clearTracker = (t) => { t.hist.length = 0; t.streak = 0; };

  // verify: did the click actually flip the video to unliked?
  const verifyTrk = tracker(CFG.verifyWindow, CFG.verifyWindowFails, CFG.verifyConsecutive);
  // nav: did the URL actually change after clicking next?
  const navTrk = tracker(CFG.navWindow, CFG.navWindowFails, CFG.navConsecutive);
  // det: could the like state be read at all? A total detection failure records
  // nothing in the other two trackers, so without this the loop runs for hours.
  const detTrk = tracker(CFG.detWindow, CFG.detWindowFails, CFG.detConsecutive);

  function clearStrikes() {
    missing = 0;
    clearTracker(verifyTrk);
    clearTracker(navTrk);
    clearTracker(detTrk);
  }

  // ---------------- Abortable sleep ----------------
  // stop()/pause() resolve the pending sleep instead of abandoning it, so the
  // loop promise always settles.
  let abortPending = null;

  function sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        abortPending = null;
        resolve();
      }, ms);
      abortPending = () => {
        clearTimeout(t);
        abortPending = null;
        resolve();
      };
    });
  }

  function abortSleep() {
    if (abortPending) abortPending();
  }

  // Sleep with a live per-second countdown. The ticks OVERWRITE a dedicated
  // status line instead of appending to the log: a 3–7 minute break used to
  // push 180–420 lines through the 40-line history and wipe the diagnostics
  // right when Copy Log mattered. Aborts early if stopped.
  async function countdownSleep(ms, labelFn) {
    let remaining = Math.round(ms / 1000);
    while (remaining > 0 && running && !paused) {
      setCountdown(labelFn(remaining));
      await sleep(1000);
      remaining--;
    }
    setCountdown('');
  }

  // ---------------- Persistence ----------------
  // `activity` = this save follows real work (a video processed, a window
  // rolled, a run started). Idle saves — toggling dry run, editing the target —
  // must NOT push `at` forward, or the 12h session window never expires.
  function save(activity) {
    if (activity) lastActivity = Date.now();
    writeStore({
      total,
      target,
      dryRun,
      dryDone,
      handle: ownHandleCache,
      ui: { x: uiPos ? uiPos.x : null, y: uiPos ? uiPos.y : null, collapsed: uiCollapsed },
      session: {
        unliked,
        processed,
        cap: sessionCap,
        runTotal,
        dryTotal,
        attempts,
        verifyFailsTotal,
        urls: unlikedUrls.slice(-CFG.urlHistoryMax),
        num: session,
        at: lastActivity,
      },
    });
  }

  function load() {
    const s = readStore();
    total = Number(s.total) || 0;
    target = Number(s.target) || 0;
    dryDone = !!s.dryDone;
    // Dry run defaults to ON until a dry run has actually been completed once:
    // the first thing a first-time user's Start does must not be irreversible.
    // An explicit stored choice (the user toggled the checkbox) always wins.
    dryRun = s.dryRun === undefined ? !dryDone : !!s.dryRun;
    ownHandleCache = typeof s.handle === 'string' ? s.handle : '';
    const ui = s.ui || {};
    uiCollapsed = !!ui.collapsed;
    if (typeof ui.x === 'number' && typeof ui.y === 'number') uiPos = { x: ui.x, y: ui.y };
    const sess = s.session;
    const at = sess ? Number(sess.at) || 0 : 0;
    if (sess && Date.now() - at < CFG.sessionIdleMs) {
      unliked = Number(sess.unliked) || 0;
      processed = Number(sess.processed) || 0;
      sessionCap = Number(sess.cap) || 0;
      runTotal = Number(sess.runTotal) || 0;
      attempts = Number(sess.attempts) || 0;
      verifyFailsTotal = Number(sess.verifyFailsTotal) || 0;
      session = Number(sess.num) || 1;
      unlikedUrls = Array.isArray(sess.urls)
        ? sess.urls.filter((u) => typeof u === 'string').slice(-CFG.urlHistoryMax)
        : [];
      // dryTotal lives behind the SAME expiry as runTotal — otherwise a dry run
      // that hit its target insta-"finishes" days later with nothing processed.
      dryTotal = Number(sess.dryTotal ?? s.dryTotal) || 0;
      lastActivity = at;
    } else {
      // Expiry silently zeroed runTotal/sessionCap mid-job in earlier versions.
      // It is loud now, because "0 unlikes" after a long run needs a reason.
      if (sess && (Number(sess.runTotal) || Number(sess.dryTotal))) {
        log(`Previous session expired (idle over ${Math.round(CFG.sessionIdleMs / 3600000)}h) — ` +
            `session counters reset to 0. Lifetime total kept: ${total}.`);
      }
      lastActivity = Date.now();
    }
  }

  // Visible escape hatch: clears the session/run/dry counters (lifetime total
  // is kept) and any paused state, so a stale target can never wedge the script.
  function resetCounters() {
    stop();
    unliked = 0;
    processed = 0;
    runTotal = 0;
    dryTotal = 0;
    attempts = 0;
    verifyFailsTotal = 0;
    sessionCap = 0;
    session = 1;
    lastPauseCode = '';
    repeatPauses = 0;
    resumeBackoffMs = 0;
    clearStrikes();
    mode = 'idle';
    lastActivity = Date.now();
    save(true);
    log('Counters reset. Lifetime total kept.');
    updateUI();
  }

  // ---------------- Viewer detection ----------------
  // Everything is scoped to the active video container so an open comment
  // drawer can never hand us a comment's like button.
  const CONTAINER_SELECTORS = [
    'div[data-e2e="browse-video"]',
    'div[data-e2e="browse-container"]',
    '#main-content-video_detail',
    'div[class*="DivBrowserModeContainer"]',
    'div[class*="DivVideoDetailContainer"]',
  ];

  // Browse mode: TikTok opened this video FROM A LIST (a profile grid, search
  // results). These are unambiguous — the recommendation feed never renders
  // them — so a match here is proof of browse mode and outranks everything.
  const BROWSE_SELECTORS = [
    'div[data-e2e="browse-video"]',
    'div[data-e2e="browse-container"]',
    'div[class*="DivBrowserModeContainer"]',
  ];

  // Recommendation feeds render the same viewer chrome as the liked feed AND
  // rewrite the address bar to the playing video's canonical /@author/video/id
  // path, so on a URL basis a For You video is indistinguishable from a liked
  // one. These markers are the tie-breaker when no browse marker is present.
  //
  // ONLY high-confidence data-e2e hooks belong here. `div[class*="DivVideoFeed"]`
  // and `div[class*="DivRecommend"]` were in this list and were guesses: the
  // liked-feed modal IS a vertical video feed component, so a hashed class like
  // DivVideoFeedV2 renders there too and the veto fired on the one page the
  // whole script exists to run on. A veto built on a substring guess fails
  // closed in the wrong place.
  const FEED_SELECTORS = [
    '[data-e2e="recommend-list-item-container"]',
    '[data-e2e="feed-video"]',
  ];

  // In a multi-item feed the first document-wide match is not necessarily the
  // video on screen, so matches are scored by how much of the viewport they
  // cover and the most-visible one wins. Selector order breaks ties.
  function visibleArea(el) {
    if (typeof el.getBoundingClientRect !== 'function') return 0;
    const r = el.getBoundingClientRect();
    if (!r) return 0;
    const vh = (typeof innerHeight === 'number' && innerHeight) || 1080;
    const vw = (typeof innerWidth === 'number' && innerWidth) || 1920;
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    return h * w;
  }

  // Every plausible root for the video on screen, most specific first — one per
  // selector, the most visible match for each.
  //
  // This used to commit to a SINGLE container: the first selector with a
  // visible match won and that was the only place anything was looked for. On
  // the desktop detail layout `data-e2e="browse-video"` wraps just the player,
  // while the action rail (like / comment / bookmark) sits in the right-hand
  // column beside the comments — outside it. So the search was scoped to a
  // subtree the like button is not in, found nothing on every video, and struck
  // out at 6/6 forever. Callers now walk the list and take the first root that
  // actually yields what they are looking for.
  function activeContainers() {
    const out = [];
    for (const sel of CONTAINER_SELECTORS) {
      let best = null;
      let bestArea = 0;
      for (const el of document.querySelectorAll(sel)) {
        const a = visibleArea(el);
        if (a > bestArea) { best = el; bestArea = a; }
      }
      if (best) out.push(best);
    }
    return out;
  }

  function activeContainer() {
    return activeContainers()[0] || null;
  }

  function visibleMatch(selectors) {
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (visibleArea(el) > 0) return el;
      }
    }
    return null;
  }

  // 'browse' | 'feed' | 'viewer' | 'none'.
  //
  // Proof beats inference: a browse-mode marker means the video was opened from
  // a list, which the recommendation feed never is, so it settles the question
  // outright. The feed markers only arbitrate the ambiguous case — a bare
  // detail container with nothing saying where it came from.
  function viewerKind() {
    if (visibleMatch(BROWSE_SELECTORS)) return 'browse';
    if (visibleMatch(FEED_SELECTORS)) return 'feed';
    if (visibleMatch(CONTAINER_SELECTORS)) return 'viewer';
    return 'none';
  }

  // ---------------- Page guard ----------------
  // The container selectors above match TikTok's video viewer EVERYWHERE — For
  // You, hashtag pages, someone else's profile. Without this guard, reloading
  // onto For You and pressing Start from habit strips likes off the wrong feed
  // at ~500/hour. Nothing starts, and nothing keeps running, unless the page
  // still looks like the user's own liked view.
  //
  // WHAT THE URL CAN AND CANNOT TELL US
  // A video opened from your Liked tab lives at /@<creator>/video/<id>: the
  // handle in the path is the video's AUTHOR, never yours — your liked feed is
  // full of other people's videos, that is what liking is. An earlier guard
  // compared that handle to your own and refused with "this is @x's profile,
  // not yours" on every single video, so the script could never run at all. It
  // only ever passed on a video you had both posted and liked.
  //
  // The URL therefore cannot answer "is this my liked feed?". So it is answered
  // where it IS answerable — on your own profile, where the path is yours and
  // the Liked tab is visibly selected — and that fact is carried into the
  // viewer as an ANCHOR. The anchor is per-tab (sessionStorage): it survives a
  // reload of the run, and it dies with the tab rather than following the user
  // into a fresh window that landed on For You.
  const HANDLE_RE = /^\/@([^/?#]+)/;
  const ANCHOR_KEY = 'ttmu.anchor.v1';

  // A TikTok handle is letters, digits, underscores and periods, up to 24
  // characters. `[^/?#]+` alone accepts backslashes, spaces and punctuation,
  // which is how a Windows driver path — @DriverStore\FileRepository\…\x.sys —
  // was once accepted as a username and armed the run. Anything that is not
  // shaped like a handle is not a handle, whatever produced it.
  const HANDLE_SHAPE = /^[a-z0-9_.]{1,24}$/;

  // '' when the string is absent or not handle-shaped. Everything that reads a
  // handle goes through here, so a malformed one can never reach the guard.
  function cleanHandle(raw) {
    if (!raw) return '';
    let h = String(raw);
    try { h = decodeURIComponent(h); } catch (e) { /* keep the raw form */ }
    h = h.toLowerCase();
    return HANDLE_SHAPE.test(h) ? h : '';
  }

  // Which selector last produced the own handle, for diagnose().
  let ownHandleSource = '';

  function ownHandle() {
    // Signed-in-user chrome ONLY. `a[data-e2e="user-detail-profile"]` used to
    // be in this list and is a PROFILE-DETAIL link: on a stranger's profile it
    // points at THEM, so it cached a stranger as "you" — after which the guard
    // would have happily agreed that their profile was your own.
    for (const sel of [
      'a[data-e2e="nav-profile"]',
      '[data-e2e="nav-profile"] a[href^="/@"]',
      '[data-e2e="profile-icon"] a[href^="/@"]',
      'a[data-e2e="profile-icon"]',
    ]) {
      const el = document.querySelector(sel);
      const href = el && (el.getAttribute('href') || '');
      const m = href && href.match(HANDLE_RE);
      const h = m && cleanHandle(m[1]);
      if (h) {
        ownHandleSource = sel;
        if (h !== ownHandleCache) { ownHandleCache = h; save(false); }
        return h;
      }
    }
    // A cached handle survives the video modal — but only if it is still
    // handle-shaped, so a bad value can't be persisted once and trusted forever.
    const cached = cleanHandle(ownHandleCache);
    ownHandleSource = cached ? 'cache' : '';
    return cached;
  }

  // What kind of page the URL describes. 'item' is a video/photo permalink —
  // the handle in it belongs to the AUTHOR and is deliberately never compared
  // to the user's own.
  function pathInfo() {
    const m = (location.pathname || '').match(/^\/@([^/?#]+)(?:\/([^/?#]+))?/);
    if (!m) return { kind: 'other', handle: '' };
    const handle = cleanHandle(m[1]);
    if (!handle) return { kind: 'other', handle: '' };   // not a profile path
    const seg = m[2] || '';
    if (!seg) return { kind: 'profile', handle };
    if (seg === 'video' || seg === 'photo') return { kind: 'item', handle };
    return { kind: 'other', handle };   // /@x/live and friends
  }

  // 'yes' | 'no' | 'unknown'. Unknown is never a veto on its own — the tab strip
  // is not always rendered behind the video modal.
  function likedTabState() {
    const tab = document.querySelector('[data-e2e="liked-tab"]');
    if (!tab) return 'unknown';
    const sel = tab.getAttribute('aria-selected')
      ?? tab.closest('[aria-selected]')?.getAttribute('aria-selected');
    if (sel === 'true') return 'yes';
    if (sel === 'false') return 'no';
    return 'unknown';
  }

  // ---- Liked-feed anchor (per tab) ----
  let anchor = null;        // { handle, at }
  let anchorSavedAt = 0;

  function anchorStore() {
    try {
      return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
    } catch (e) {
      return null;   // storage partitioning / disabled cookies
    }
  }

  function writeAnchor() {
    const s = anchorStore();
    if (!s) return;
    try {
      if (anchor) s.setItem(ANCHOR_KEY, JSON.stringify(anchor));
      else s.removeItem(ANCHOR_KEY);
      anchorSavedAt = Date.now();
    } catch (e) { /* in-memory only */ }
  }

  function loadAnchor() {
    const s = anchorStore();
    if (!s) return;
    try {
      const a = JSON.parse(s.getItem(ANCHOR_KEY) || 'null');
      const at = a && Number(a.at) || 0;
      const handle = a && cleanHandle(a.handle);
      if (handle && Date.now() - at < CFG.anchorIdleMs) {
        anchor = { handle, at };
        anchorSavedAt = at;
      }
    } catch (e) { /* no anchor */ }
  }

  function armAnchor(handle) {
    const isNew = !anchor || anchor.handle !== handle;
    anchor = { handle, at: Date.now() };
    writeAnchor();
    if (isNew) log(`Liked feed armed for @${handle}.`);
  }

  // Called on every passing guard check, so the staleness window measures IDLE
  // time rather than run length. The persisted copy is throttled — the loop
  // calls this once per video and sessionStorage does not need the churn.
  function touchAnchor() {
    if (!anchor) return;
    anchor.at = Date.now();
    if (anchor.at - anchorSavedAt > 60000) writeAnchor();
  }

  function clearAnchor() {
    if (!anchor) return;
    anchor = null;
    writeAnchor();
  }

  // { ok, stage, msg }. Called before start(), on every loop iteration, and on
  // the idle readiness poll — the poll is what arms the anchor when the user
  // walks to their Liked tab without ever reloading the page.
  //
  // stage: 'viewer' (ok to run) | 'profile' (own Liked grid, nothing to unlike
  // yet, anchor armed) | 'none'.
  function pageGuard() {
    const own = ownHandle();
    const info = pathInfo();

    if (!own) {
      return { ok: false, stage: 'none', msg:
        "Can't tell which account is signed in — your own profile link isn't on the page. " +
        'Make sure you are logged in, open your profile, then pick the Liked tab.' };
    }

    // --- your own profile: the one place the URL proves whose feed this is ---
    if (info.kind === 'profile') {
      if (info.handle !== own) {
        clearAnchor();
        return { ok: false, stage: 'none', msg:
          `This is @${info.handle}'s profile, not yours (@${own}) — open your own profile.` };
      }
      const tab = likedTabState();
      if (tab !== 'yes') {
        return { ok: false, stage: 'none', msg: tab === 'no'
          ? 'The Liked tab is not the selected tab on your profile — open Liked first.'
          : "Can't see a selected Liked tab on this profile — open the Liked tab." };
      }
      armAnchor(own);
      return { ok: false, stage: 'profile', msg:
        'the video viewer is not open — open a video from your Liked grid.' };
    }

    if (info.kind !== 'item') {
      return { ok: false, stage: 'none', msg:
        'Not on a profile or on a video opened from one — this looks like For You, a hashtag or a ' +
        'search feed. Open your own profile, pick the Liked tab, then open a video from it.' };
    }

    // --- a video permalink. info.handle is the CREATOR's and is NOT checked ---
    const kind = viewerKind();
    if (kind === 'feed') {
      clearAnchor();
      return { ok: false, stage: 'none', msg:
        'This is a recommendation feed showing a video URL, not your Liked feed — For You and ' +
        'hashtag feeds put /@creator/video/… in the address bar too. Open your Liked tab instead.' };
    }
    if (likedTabState() === 'no') {
      clearAnchor();
      return { ok: false, stage: 'none', msg:
        'The Liked tab is no longer selected on the profile behind this video — open Liked first.' };
    }
    if (!anchor) {
      return { ok: false, stage: 'none', msg:
        `Can't confirm this video came from your own Liked feed. Open your profile (@${own}), ` +
        'pick the Liked tab, then open a video from the grid — that is what arms the run.' };
    }
    if (anchor.handle !== own) {
      clearAnchor();
      return { ok: false, stage: 'none', msg:
        `The signed-in account changed to @${own} since the Liked feed was armed — reopen your Liked tab.` };
    }
    if (Date.now() - anchor.at > CFG.anchorIdleMs) {
      clearAnchor();
      return { ok: false, stage: 'none', msg:
        `Your Liked grid was last open over ${Math.round(CFG.anchorIdleMs / 3600000)}h ago — ` +
        'reopen your profile\'s Liked tab to re-arm.' };
    }
    if (kind === 'none') {
      return { ok: false, stage: 'none', msg:
        "No video viewer is on screen — go back to your Liked grid and open a video from it." };
    }
    touchAnchor();
    return { ok: true, stage: 'viewer', msg: '' };
  }

  // ---------------- Like button detection ----------------

  // Widening the search root to the whole detail view brings the comments
  // column with it, and every comment has its own like button. Anything
  // comment-flavoured is rejected outright — better to miss and strike out than
  // to unlike a comment. Separate closest() calls rather than one comma
  // selector, because :closest with a list is not universally supported.
  function inComments(el) {
    return !!(el.closest('[data-e2e*="comment"]') ||
              el.closest('[data-e2e*="Comment"]') ||
              el.closest('[class*="Comment"]'));
  }

  // data-e2e names shift between layouts — browse-like-icon, like-icon,
  // video-like-icon — so this matches the SHAPE of the name instead of a list
  // of literals that would just be more guesses. It requires the name to END in
  // "like"/"like-icon", which keeps out the count label ("browse-like-count")
  // sitting right next to it.
  const LIKE_E2E_RE = /(^|-)(un)?like(-icon)?$/i;

  // Scoped to one root. Most specific strategy first.
  function likeButtonIn(root) {
    for (const sel of [
      'span[data-e2e="browse-like-icon"]',   // desktop video viewer
      'span[data-e2e="like-icon"]',          // feed layout
    ]) {
      const el = root.querySelector(sel);
      if (el && !inComments(el)) return el.closest('button') || el;
    }
    // Shape-matched data-e2e, for a layout that renamed the hook.
    for (const el of root.querySelectorAll('[data-e2e]')) {
      const name = el.getAttribute('data-e2e') || '';
      if (!LIKE_E2E_RE.test(name) || /comment/i.test(name)) continue;
      if (inComments(el)) continue;
      return el.closest('button') || el;
    }
    // aria-label fallback, last and most permissive.
    for (const el of root.querySelectorAll('button[aria-label*="Like" i]')) {
      if (!inComments(el)) return el;
    }
    return null;
  }

  // TikTok's DOM shifts often; try several strategies, most specific first.
  // No container => no button. There is deliberately NO document-wide fallback:
  // searching the whole page would let the script act on some other video (or
  // another page entirely) instead of failing safe into the 6-strike pause.
  //
  // Every candidate root is tried, innermost first, because the like button is
  // not always inside the smallest one — see activeContainers().
  function findLikeButton() {
    for (const root of activeContainers()) {
      const btn = likeButtonIn(root);
      if (btn) return btn;
    }
    return null;
  }

  // Returns true / false, or null if state can't be determined.
  function isLiked(btn) {
    // 1) aria-pressed (most reliable when present)
    const pressed =
      btn.getAttribute('aria-pressed') ??
      btn.closest('[aria-pressed]')?.getAttribute('aria-pressed');
    if (pressed === 'true') return true;
    if (pressed === 'false') return false;

    // 2) aria-label wording ("Like video" vs "Unlike video" / "Liked").
    // Order matters: the unliked forms ("Like…") are checked BEFORE any
    // 'liked' substring test, because labels such as "Like video, liked by
    // 1.2M" contain both, and 'liked' alone must never match social-proof
    // copy like "liked by 1.2M".
    const label = (btn.getAttribute('aria-label') || '').toLowerCase().trim();
    if (/(^|[^a-z])unlike([^a-z]|$)/.test(label)) return true;
    if (/^like\b/.test(label)) return false;
    if (/(^|[^a-z])liked([^a-z]|$)/.test(label) && !/liked\s+by\b/.test(label)) return true;

    // 3) SVG fill heuristic — anchored to TikTok's actual like red
    // (#fe2c55 / rgb(254, 44, 85)). A loose 'rgba(254' match used to treat
    // near-white fills like rgba(254,254,254) as "liked" and click LIKE on
    // unliked videos.
    const svg = btn.querySelector('svg');
    if (svg) {
      const RED = /(#?fe2c55\b|rgba?\(\s*254\s*,\s*44\s*,\s*85\s*[,)])/;
      const fills = [svg, ...svg.querySelectorAll('[fill]')]
        .map((n) => (n.getAttribute('fill') || '').toLowerCase());
      if (fills.some((f) => RED.test(f))) return true;
    }
    return null; // unknown — skip rather than guess
  }

  // Re-read the like state after a click. The node is often replaced on
  // re-render, so look it up again rather than trusting the old reference.
  function readLikeStateAgain(oldBtn) {
    const btn = findLikeButton() || oldBtn;
    if (!btn) return null;
    return isLiked(btn);
  }

  // Find TikTok's "next video" chevron and click it.
  // Anything destructive or share-y that must never be mistaken for "next".
  // WORD-BOUNDED, and only a veto when the allow pattern didn't match: as an
  // unbounded substring list it blocked legitimate next-buttons whose labels
  // merely contained "profile" ("Next video in profile feed" — and the liked
  // feed IS on the profile page), "collect" ("in this collection"), "comment"
  // ("comment count 12"), "mute" ("· muted") or "screen" ("fullscreen").
  const NEXT_DENY_RE =
    /(^|[^a-z])(download|share|report|copy|embed|bookmark|favou?rite[sd]?|repost|duet|stitch|delete|remove|block|upload|save)([^a-z]|$)/i;
  // Precise next / arrow-down semantics. Word-bounded, so "Download" cannot
  // match "down" and "nextdoor"-style labels cannot match "next".
  const NEXT_ALLOW_RE =
    /(^|[^a-z])(next(\s+(video|item|post|clip))?|go\s+to\s+next[a-z\s]*|scroll\s+down|swipe\s+down|arrow[\s-]?down|down\s+arrow|chevron\s+down)([^a-z]|$)/i;

  const labelOf = (el) =>
    (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();

  // The deny list only vetoes when the allow pattern did NOT clearly match, so
  // "swipe down to save" is still a next control while "Save video" is not.
  const vetoed = (label) =>
    NEXT_DENY_RE.test(label) && !NEXT_ALLOW_RE.test(label);

  // Why the last lookup found nothing: '' | 'no-container' | 'no-labels' | 'no-match'.
  // 'no-match' means buttons were labelled but none read as "next" — the usual
  // cause is a non-English TikTok UI, which deserves its own message.
  let lastNextMiss = '';

  // Same widening as findLikeButton: the next/previous chevrons sit between the
  // player and the comments column, outside the container that wraps just the
  // video, so a single-root search never saw them either.
  function nextButtonIn(scope) {
    // Most specific: TikTok's own hooks. Still deny-checked in case the hook
    // is reused on a control that does something else.
    for (const sel of [
      'button[data-e2e="arrow-right"]',
      'button[data-e2e="browse-video-next"]',
    ]) {
      const el = scope.querySelector(sel);
      if (el && !el.disabled && !vetoed(labelOf(el))) return { btn: el, labelled: 1 };
    }
    let labelled = 0;
    for (const b of scope.querySelectorAll('button')) {
      if (b.disabled) continue;
      const label = labelOf(b);
      if (!label) continue;
      labelled++;
      if (vetoed(label)) continue;
      if (NEXT_ALLOW_RE.test(label)) return { btn: b, labelled };
    }
    return { btn: null, labelled };
  }

  function findNextButton() {
    const roots = activeContainers();
    if (!roots.length) { lastNextMiss = 'no-container'; return null; }
    let labelled = 0;
    for (const scope of roots) {
      const r = nextButtonIn(scope);
      if (r.btn) { lastNextMiss = ''; return r.btn; }
      labelled = Math.max(labelled, r.labelled);
    }
    lastNextMiss = labelled ? 'no-match' : 'no-labels';
    return null;
  }

  // Clicks next and confirms the URL actually changed. Returns true/false.
  async function nextVideo() {
    const before = location.href;
    const btn = findNextButton();
    // No candidate button: record the failure immediately. The old synthetic
    // ArrowDown fallback was dead code — TikTok ignores untrusted keydowns —
    // and its 5s navigation poll just slowed every miss down.
    if (!btn) return false;
    btn.click();
    // wait up to ~5s for navigation
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      if (!running || paused) return false;
      if (location.href !== before) return true;
    }
    return false;
  }

  // ---------------- Main loop ----------------
  const targetReached = () =>
    target > 0 && (dryRun ? dryTotal : runTotal) >= target;

  async function loop() {
    // Escalating cooldown after repeated identical pauses (set by resume()).
    if (resumeBackoffMs) {
      const b = resumeBackoffMs;
      resumeBackoffMs = 0;
      mode = 'break';
      log(`Backoff — repeated pause, retrying in ${Math.round(b / 1000)}s.`);
      updateUI();
      await countdownSleep(b, (s) => `Backoff ${s}s — retrying slowly.`);
      if (!running || paused) return;
      mode = 'running';
      updateUI();
    }

    while (running && !paused) {
      try {
        // --- still on our own liked view? re-checked every iteration, because
        //     TikTok can navigate under us (autoplay into For You, a tapped
        //     hashtag, a back button) and the selectors match those pages too.
        const guard = pageGuard();
        if (!guard.ok) {
          pause(P.GUARD, `Left the Liked feed — ${guard.msg}`);
          return;
        }

        // --- target reached? ---
        const done = dryRun ? dryTotal : runTotal;
        if (targetReached()) {
          finish(`Target reached — ${done} ${dryRun ? 'would-be ' : ''}unlikes. Stopped.`);
          return;
        }

        // --- new cap window? ---
        if (!sessionCap) rollWindow(false);

        // --- session break: unlikes hit the cap OR too many videos seen ---
        const processedCap = sessionCap * CFG.processedCapFactor;
        if (unliked >= sessionCap || processed >= processedCap) {
          const why = unliked >= sessionCap
            ? `cap ${sessionCap} reached`
            : `${processed} videos seen without hitting the cap`;
          session++;
          mode = 'break';
          log(`Break — ${why}.`);
          updateUI();
          save(true);
          const b = rand(CFG.sessionBreakMinMs, CFG.sessionBreakMaxMs);
          await countdownSleep(b, (s) =>
            `Break — ${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`);
          if (!running || paused) return;
          rollWindow(true);
        }

        // --- find the like button ---
        const btn = findLikeButton();
        if (!btn) {
          missing++;
          log(`No like button found (${missing}/${CFG.strikes})…`);
          updateUI();
          if (missing >= CFG.strikes) {
            pause(P.NO_LIKE_BTN, "Can't find the like button in the video container — TikTok's layout may have changed, or the video hasn't loaded.");
            return;
          }
          // Patience grows with each strike: a lazy load gets ~39s, not 12s.
          await sleep(Math.min(CFG.missWaitMs + (missing - 1) * 1000, CFG.missWaitMaxMs));
          continue;
        }
        missing = 0;

        processed++;
        const liked = isLiked(btn);
        // Determinacy tracker: a null read records nothing in the verify or nav
        // trackers, so without this a DOM change ran silently for hours with the
        // panel reading "running" and runTotal stuck at 0.
        record(detTrk, liked !== null);
        if (streakTripped(detTrk) || windowTripped(detTrk)) {
          const bad = failCount(detTrk);
          pause(P.INDETERMINATE,
            `Can't read the like state — ${bad} of the last ${detTrk.hist.length} videos were unreadable. ` +
            "TikTok's DOM has probably changed; the script would otherwise keep looping and unlike nothing.");
          return;
        }
        await sleep(rand(200, CFG.clickJitterMs)); // human "reaction time"
        if (!running || paused) return;

        if (liked === true) {
          if (dryRun) {
            dryTotal++;
            unliked++;
            log(`Would unlike #${dryTotal} (dry run)`);
          } else {
            attempts++;
            btn.click();
            // verify the click actually flipped the state
            await sleep(rand(CFG.verifyMinMs, CFG.verifyMaxMs));
            if (!running || paused) return;
            const after = readLikeStateAgain(btn);
            record(verifyTrk, after === false);
            if (after === false) {
              unliked++;
              runTotal++;
              total++;
              // Recovery list: an unlike is irreversible from here, so keep the
              // URL so a mistaken run can be manually re-liked.
              unlikedUrls.push(location.href);
              if (unlikedUrls.length > CFG.urlHistoryMax) unlikedUrls.shift();
              log(`Unliked #${total}`);
            } else {
              verifyFailsTotal++;
              const fails = failCount(verifyTrk);
              log(after === true
                ? `Warning: click did not unlike (${verifyTrk.streak} in a row, ${fails}/${CFG.verifyWindow} recent, ${verifyFailsTotal} this run) — not counted.`
                : `Warning: could not verify the click (${fails}/${CFG.verifyWindow} recent, ${verifyFailsTotal} this run) — not counted.`);
              // Consecutive run is the fast path; the windowed rate is what
              // catches an alternating misdetect pattern, which would otherwise
              // re-LIKE videos forever while resetting a consecutive counter.
              if (streakTripped(verifyTrk)) {
                pause(P.VERIFY_STREAK, `${CFG.verifyConsecutive} clicks in a row left the video liked — stopping before we like something by mistake.`);
                return;
              }
              if (windowTripped(verifyTrk)) {
                pause(P.VERIFY_WINDOW, `${fails} of the last ${verifyTrk.hist.length} clicks failed to verify — stopping before we like something by mistake.`);
                return;
              }
              // The window bounds the failure RATE only: a perfectly periodic
              // 1-in-5 pattern never fills it and ran forever. This is the
              // absolute cumulative ceiling for the run.
              if (verifyFailsTotal >= CFG.verifyFailCeiling) {
                pause(P.VERIFY_CEILING, `${verifyFailsTotal} clicks have failed to verify this run — that is the ceiling, regardless of how spread out they were. Reset counters to clear it.`);
                return;
              }
            }
          }
        } else if (liked === false) {
          log('Already unliked, skipping.');
        } else {
          log('Could not determine like state — skipping to be safe.');
        }
        save(true);
        updateUI();

        // --- target reached? check BEFORE navigating, so hitting the target
        //     doesn't cost one extra page load. ---
        if (targetReached()) {
          const n = dryRun ? dryTotal : runTotal;
          finish(`Target reached — ${n} ${dryRun ? 'would-be ' : ''}unlikes. Stopped.`);
          return;
        }

        // --- advance ---
        const advanced = await nextVideo();
        if (!running || paused) return;
        record(navTrk, advanced);
        if (!advanced) {
          const fails = failCount(navTrk);
          log(`Couldn't advance to next video (${navTrk.streak} in a row, ${fails}/${CFG.navWindow} recent)…`);
          // A non-English UI matches no next-label at all. Saying "end of feed"
          // there sends the user looking for the wrong problem.
          const langHint = lastNextMiss === 'no-match';
          if (streakTripped(navTrk)) {
            if (langHint) {
              pause(P.NAV_LABELS, "No button in the viewer is labelled like a next-video control. The next-button is matched on English labels — if TikTok's UI is in another language, switch it to English or navigate manually.");
            } else {
              pause(P.NAV_STREAK, 'Stuck on the same video — end of feed, or the next button moved.');
            }
            return;
          }
          if (windowTripped(navTrk)) {
            if (langHint) {
              pause(P.NAV_LABELS, `Navigation failed ${fails} of the last ${navTrk.hist.length} times and no button matched a next-video label — TikTok's UI may not be in English.`);
            } else {
              pause(P.NAV_WINDOW, `Navigation failed ${fails} of the last ${navTrk.hist.length} times — end of feed, or the next button moved.`);
            }
            return;
          }
        }
        await sleep(rand(CFG.delayMinMs, CFG.delayMaxMs));
      } catch (err) {
        pause(P.ERROR, `Error: ${(err && err.message) || err}`);
        return;
      }
    }
  }

  function rollWindow(announce) {
    unliked = 0;
    processed = 0;
    sessionCap = rand(CFG.sessionCapMin, CFG.sessionCapMax + 1);
    mode = 'running';
    if (announce) log(`Session ${session} started — cap: ${sessionCap}`);
    save(true);
    updateUI();
  }

  // ---------------- Start / stop / pause ----------------
  function start() {
    if (running) return;
    // Refuse rather than pause: nothing has run yet, so there is nothing to
    // resume, and this is the case where pressing Start from habit on For You
    // would have stripped likes off the wrong feed.
    const guard = pageGuard();
    if (!guard.ok) {
      mode = 'idle';
      // The Liked grid is a near miss, not a wrong page: the run is armed and
      // one click away. Saying "not on a profile page" there would send the
      // user looking for a problem that does not exist.
      log(guard.stage === 'profile'
        ? 'Not starting — you are on your Liked grid. Open the first video from it, then press Start.'
        : `Not starting — ${guard.msg}`);
      updateUI();
      return;
    }
    clearStrikes();
    paused = false;
    pauseReason = '';
    pauseCode = '';
    running = true;
    mode = 'running';
    if (!sessionCap) {
      sessionCap = rand(CFG.sessionCapMin, CFG.sessionCapMax + 1);
    }
    log(`Session ${session} — cap: ${sessionCap}, ${unliked} done. Keep this tab focused.`);
    save(true);
    updateUI();
    // Serialize on the previous loop promise: a stop() immediately followed by
    // start() could otherwise briefly have two loops interleaving on the same
    // trackers. The old loop settles fast (its sleep is aborted), so this only
    // ever waits a tick.
    const prev = loopPromise;
    loopPromise = (async () => {
      if (prev) { try { await prev; } catch (e) { /* already surfaced */ } }
      await loop();
    })();
    return loopPromise;
  }

  function stop(msg) {
    running = false;
    paused = false;
    pauseReason = '';
    pauseCode = '';
    resumeBackoffMs = 0;
    mode = 'idle';
    abortSleep();
    if (msg) log(msg);
    save(false);
    updateUI();
  }

  function finish(msg) {
    running = false;
    paused = false;
    pauseReason = '';
    pauseCode = '';
    mode = 'done';
    // Completing a dry run flips the first-run default: from now on the
    // dry-run checkbox follows the user's explicit choice instead of
    // defaulting to on.
    if (dryRun) dryDone = true;
    abortSleep();
    log(msg);
    save(false);
    updateUI();
  }

  // Anomaly stop: distinct from a user-initiated stop, and resumable.
  // Escalation keys on `code`, not on `reason`: the window trips embed live
  // counters ("3 of the last 5…", "3 of the last 7…"), so comparing strings
  // reset repeatPauses to 1 every time and the give-up never fired.
  function pause(code, reason) {
    running = false;
    paused = true;
    pauseCode = code;
    pauseReason = reason;
    mode = 'paused';
    if (code === lastPauseCode) repeatPauses++;
    else { lastPauseCode = code; repeatPauses = 1; }
    abortSleep();
    log(repeatPauses > 1
      ? `Paused (${repeatPauses}× for this reason): ${reason}`
      : `Paused: ${reason}`);
    save(false);
    updateUI();
  }

  // Resume no longer wipes the slate for free: repeating the same pause earns
  // an escalating cooldown, then a refusal, so it can't be clicked in a loop
  // past a real problem.
  function resume() {
    if (!paused) return;
    if (repeatPauses >= CFG.resumeGiveUpAfter) {
      log(`Paused ${repeatPauses}× for the same reason — resuming won't help. Fix the page, or reset counters.`);
      return;
    }
    resumeBackoffMs = repeatPauses >= 2
      ? Math.min(CFG.resumeBackoffMs * 2 ** (repeatPauses - 2), CFG.resumeBackoffMaxMs)
      : 0;
    if (resumeBackoffMs) {
      log(`Paused ${repeatPauses}× for the same reason — waiting ${Math.round(resumeBackoffMs / 1000)}s before retrying.`);
    }
    clearStrikes();
    return start();
  }

  function setDryRun(on) {
    dryRun = !!on;
    if (typeof disarmStartHook === 'function') disarmStartHook(); // an armed confirm is stale once the mode changes
    save(false);   // idle toggle: must not extend the session window
    updateUI();
  }
  let disarmStartHook = null;

  function setTarget(n) {
    target = Math.max(0, Number(n) || 0);
    save(false);   // idle edit: must not extend the session window
    updateUI();
  }

  // ---------------- UI ----------------
  const panel = document.createElement('div');
  panel.id = 'ttmu-panel';
  panel.innerHTML = `
    <style>
      #ttmu-panel {
        --ttmu-ac: #a288a6;
        --ttmu-ac2: #b299b6;
        --ttmu-ac-pale: #c9b3cc;
        --ttmu-ac-soft: #bb9bb0;
        --ttmu-warn: #d9aa5e;
        --ttmu-surface: #232428;
        --ttmu-surface3: #27282d;
        --ttmu-inp: #141518;
        --ttmu-txt: #f1e3e4;
        --ttmu-txtstrong: #ffffff;
        --ttmu-m1: #ccbcbc;
        --ttmu-m7: #a69aa0;
        --ttmu-b1: #35363c;
        --ttmu-hair: rgba(241, 227, 228, .09);
        --ttmu-hairh: rgba(241, 227, 228, .16);
        --ttmu-mono: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;

        position: fixed; bottom: 20px; right: 20px; z-index: 999999;
        width: 236px; padding: 14px;
        box-sizing: border-box;
        background: var(--ttmu-surface);
        border: 1px solid var(--ttmu-hair); border-radius: 14px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, .5);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        font-size: 12px; line-height: 1.5; color: var(--ttmu-txt);
        font-variant-numeric: tabular-nums;
        -webkit-font-smoothing: antialiased;
        text-align: left;
        animation: ttmu-rise .18s cubic-bezier(0.23, 1, 0.32, 1);
      }
      @keyframes ttmu-rise { from { opacity: 0; transform: translateY(4px); } }
      @keyframes ttmu-fade { from { opacity: 0; } }
      #ttmu-panel *, #ttmu-panel *::before, #ttmu-panel *::after { box-sizing: border-box; }
      #ttmu-panel h4 {
        margin: 0 0 10px; padding: 0 0 10px;
        border-bottom: 1px solid var(--ttmu-hair);
        font-size: 13px; font-weight: 700; letter-spacing: -.02em;
        color: var(--ttmu-txtstrong); font-family: inherit;
        display: flex; align-items: center; justify-content: space-between;
        cursor: move; user-select: none; -webkit-user-select: none;
      }
      #ttmu-panel.collapsed h4 { margin: 0; padding: 0; border-bottom: none; }
      #ttmu-panel.collapsed #ttmu-body { display: none; }
      #ttmu-panel #ttmu-collapse {
        width: auto; margin: 0; padding: 0 4px;
        background: none; border: none; border-radius: 4px;
        color: var(--ttmu-m7); font-size: 13px; font-weight: 600; line-height: 1;
        cursor: pointer;
      }
      #ttmu-panel #ttmu-collapse:hover { color: var(--ttmu-txt); background: var(--ttmu-surface3); }
      #ttmu-panel .row {
        display: flex; align-items: baseline; justify-content: space-between;
        gap: 12px; padding: 3px 0;
      }
      #ttmu-panel .row span {
        color: var(--ttmu-m7); font-size: 11px; font-weight: 500; letter-spacing: .02em;
      }
      #ttmu-panel .row b {
        font-family: var(--ttmu-mono); font-size: 11.5px; font-weight: 600;
        color: var(--ttmu-txt); font-variant-numeric: tabular-nums;
      }
      #ttmu-panel .opt {
        display: flex; align-items: center; justify-content: space-between;
        gap: 10px; padding: 3px 0;
      }
      #ttmu-panel .opt label {
        color: var(--ttmu-m7); font-size: 11px; font-weight: 500; letter-spacing: .02em;
        cursor: pointer;
      }
      #ttmu-panel .sep {
        margin-top: 10px; padding-top: 8px;
        border-top: 1px solid var(--ttmu-hair);
      }
      #ttmu-panel input[type="number"] {
        width: 64px; padding: 3px 6px;
        background: var(--ttmu-inp); color: var(--ttmu-txt);
        border: 1px solid var(--ttmu-b1); border-radius: 8px;
        font-family: var(--ttmu-mono); font-size: 11.5px;
        text-align: right;
      }
      #ttmu-panel input[type="checkbox"] {
        width: 13px; height: 13px; margin: 0; accent-color: var(--ttmu-ac); cursor: pointer;
      }
      #ttmu-panel input:focus-visible { outline: 2px solid var(--ttmu-ac); outline-offset: 2px; }
      #ttmu-panel #ttmu-status {
        font-family: inherit; font-size: 11px; font-weight: 600; letter-spacing: .03em;
        padding: 2px 7px; border-radius: 6px;
        color: var(--ttmu-m1);
        background: var(--ttmu-surface3);
        border: 1px solid var(--ttmu-b1);
        transition: color .15s ease-out, background-color .15s ease-out, border-color .15s ease-out;
      }
      #ttmu-panel #ttmu-status.active {
        color: var(--ttmu-ac-pale);
        background: color-mix(in srgb, var(--ttmu-ac) 18%, transparent);
        border-color: color-mix(in srgb, var(--ttmu-ac-soft) 35%, transparent);
      }
      #ttmu-panel #ttmu-status.warn {
        color: var(--ttmu-warn);
        background: color-mix(in srgb, var(--ttmu-warn) 14%, transparent);
        border-color: color-mix(in srgb, var(--ttmu-warn) 30%, transparent);
      }
      #ttmu-panel #ttmu-dry-chip {
        font-family: inherit; font-size: 11px; font-weight: 600; letter-spacing: .03em;
        padding: 2px 7px; border-radius: 6px;
        color: var(--ttmu-ac-pale);
        background: color-mix(in srgb, var(--ttmu-ac) 18%, transparent);
        border: 1px dashed color-mix(in srgb, var(--ttmu-ac-soft) 45%, transparent);
      }
      #ttmu-panel .hidden { display: none; }
      /* Elements that swap via .hidden fade in when they (re)appear instead of
         snapping — the animation restarts each time display flips from none. */
      #ttmu-panel #ttmu-dry-chip:not(.hidden),
      #ttmu-panel #ttmu-countdown:not(.hidden),
      #ttmu-panel #ttmu-resume:not(.hidden),
      #ttmu-panel #ttmu-btn:not(.hidden) {
        animation: ttmu-fade .15s cubic-bezier(0.23, 1, 0.32, 1);
      }
      #ttmu-panel button {
        width: 100%; margin-top: 12px; padding: 8px 0;
        border: 1px solid var(--ttmu-ac); border-radius: 8px;
        font-family: inherit; font-size: 12px; font-weight: 600; letter-spacing: -.01em;
        cursor: pointer;
        background: var(--ttmu-ac); color: #1c1d21;
        transition: color .15s ease-out, background-color .15s ease-out, border-color .15s ease-out;
      }
      #ttmu-panel button:hover {
        background: var(--ttmu-ac2);
        border-color: var(--ttmu-ac2);
      }
      #ttmu-panel button:active { transform: scale(0.97); }
      /* Armed confirm state: visibly different, warns before the point of no return. */
      #ttmu-panel button.confirm {
        background: var(--ttmu-warn); border-color: var(--ttmu-warn); color: #1c1d21;
      }
      #ttmu-panel button.confirm.secondary {
        background: color-mix(in srgb, var(--ttmu-warn) 16%, transparent);
        border-color: color-mix(in srgb, var(--ttmu-warn) 40%, transparent);
        color: var(--ttmu-warn);
      }
      #ttmu-panel button:focus-visible { outline: 2px solid var(--ttmu-ac); outline-offset: 2px; }
      /* Secondary: only one solid-accent primary is ever visible at a time. */
      #ttmu-panel button.secondary {
        background: var(--ttmu-surface3); border-color: var(--ttmu-b1); color: var(--ttmu-m1);
      }
      #ttmu-panel button.secondary:hover {
        border-color: var(--ttmu-hairh); color: var(--ttmu-txt);
        background: #2c2d33;
      }
      #ttmu-panel .btnrow { display: flex; gap: 6px; }
      #ttmu-panel .btnrow button {
        flex: 1; white-space: nowrap;
        margin-top: 6px; padding: 6px 0; font-size: 11.5px;
      }
      #ttmu-panel .warnval { color: var(--ttmu-warn); }
      #ttmu-log {
        margin-top: 10px; padding-top: 10px;
        border-top: 1px solid var(--ttmu-hair);
        color: var(--ttmu-m7); font-size: 11px;
        min-height: 15px; max-height: 96px; overflow-y: auto; overscroll-behavior: contain;
        white-space: pre-wrap; word-break: break-word; line-height: 1.45;
        font-variant-numeric: tabular-nums;
        user-select: text; -webkit-user-select: text;
      }
      #ttmu-log.warn { color: var(--ttmu-warn); }
      #ttmu-countdown {
        margin-top: 8px;
        color: var(--ttmu-ac-pale); font-size: 11px;
        font-variant-numeric: tabular-nums;
      }
      #ttmu-ready {
        margin-top: 8px;
        color: var(--ttmu-m7); font-size: 11px; line-height: 1.45;
      }
      #ttmu-ready.go { color: var(--ttmu-ac-pale); }
      @media (prefers-reduced-motion: reduce) {
        #ttmu-panel, #ttmu-panel * {
          animation: none !important;
          transition-duration: 0s !important;
        }
      }
    </style>
    <h4 id="ttmu-head">TikTok mass unliker<button id="ttmu-collapse" title="Collapse panel" aria-label="Collapse panel">–</button></h4>
    <div id="ttmu-body">
    <div class="row"><span>This session</span><b id="ttmu-run">0</b></div>
    <div class="row"><span>All time</span><b id="ttmu-total">0</b></div>
    <div class="row"><span>Window</span><b id="ttmu-count">–</b></div>
    <div class="row"><span>Verified / failed</span><b id="ttmu-verify">0 / 0</b></div>
    <div class="row"><span>Status</span><b id="ttmu-status">idle</b></div>
    <div class="row"><span>Mode</span><b id="ttmu-dry-chip" class="hidden">dry run</b></div>
    <div class="sep opt">
      <label for="ttmu-dry">Dry run</label>
      <input type="checkbox" id="ttmu-dry">
    </div>
    <div class="opt">
      <label for="ttmu-target">Stop after</label>
      <input type="number" id="ttmu-target" min="0" step="10" placeholder="0">
    </div>
    <div id="ttmu-countdown" class="hidden"></div>
    <div id="ttmu-ready" class="hidden"></div>
    <button id="ttmu-resume" class="hidden">Resume</button>
    <button id="ttmu-btn">Start</button>
    <div class="btnrow">
      <button id="ttmu-reset" class="secondary">Reset counters</button>
      <button id="ttmu-copy" class="secondary">Copy log</button>
    </div>
    <div class="btnrow">
      <button id="ttmu-copyurls" class="secondary">Copy unliked list</button>
    </div>
    <div id="ttmu-log"></div>
    </div>
  `;
  document.body.appendChild(panel);

  const $ = (id) => panel.querySelector(id);

  load();

  // ---- Panel position / collapse (persisted) ----
  function applyUiPos() {
    if (uiPos && panel.style) {
      panel.style.left = uiPos.x + 'px';
      panel.style.top = uiPos.y + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }
    panel.classList.toggle('collapsed', uiCollapsed);
  }
  applyUiPos();

  let dragOff = null;
  $('#ttmu-head').addEventListener('mousedown', (e) => {
    if (e.target && e.target.id === 'ttmu-collapse') return;
    const r = panel.getBoundingClientRect();
    dragOff = { x: (e.clientX || 0) - r.left, y: (e.clientY || 0) - r.top };
    if (e.preventDefault) e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragOff) return;
    uiPos = {
      x: Math.max(0, (e.clientX || 0) - dragOff.x),
      y: Math.max(0, (e.clientY || 0) - dragOff.y),
    };
    applyUiPos();
  });
  document.addEventListener('mouseup', () => {
    if (dragOff) { dragOff = null; save(false); }
  });
  $('#ttmu-collapse').addEventListener('click', () => {
    uiCollapsed = !uiCollapsed;
    applyUiPos();
    save(false);
  });

  // ---- Two-step confirmation ----
  // A real run permanently unlikes videos, so a single stray click must not
  // start one: the first click ARMS the button for a few seconds, the second
  // click starts. Dry runs start on a single click. Reset gets the same
  // pattern — it wipes the session counters.
  let startArmed = false;
  let startArmTimer = 0;
  let resetArmed = false;
  let resetArmTimer = 0;

  function disarmStart() {
    startArmed = false;
    if (startArmTimer) { clearTimeout(startArmTimer); startArmTimer = 0; }
  }
  disarmStartHook = disarmStart;

  $('#ttmu-btn').addEventListener('click', () => {
    if (running) { disarmStart(); stop('Stopped.'); return; }
    if (!dryRun && !startArmed) {
      startArmed = true;
      if (startArmTimer) clearTimeout(startArmTimer);
      startArmTimer = setTimeout(() => { disarmStart(); updateUI(); }, CFG.confirmArmMs);
      updateUI();
      return;
    }
    disarmStart();
    start();
  });
  $('#ttmu-resume').addEventListener('click', () => resume());
  $('#ttmu-reset').addEventListener('click', () => {
    if (!resetArmed) {
      resetArmed = true;
      if (resetArmTimer) clearTimeout(resetArmTimer);
      resetArmTimer = setTimeout(() => { resetArmed = false; updateUI(); }, CFG.confirmArmMs);
      updateUI();
      return;
    }
    resetArmed = false;
    if (resetArmTimer) { clearTimeout(resetArmTimer); resetArmTimer = 0; }
    resetCounters();
  });
  $('#ttmu-copy').addEventListener('click', () => copyLog());
  $('#ttmu-copyurls').addEventListener('click', () => copyUnliked());

  // A background tab gets its timers throttled, which distorts all pacing and
  // can trip the nav-failure tracking on phantom timeouts. Instead of merely
  // warning, auto-pause and resume when the tab is visible again.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && running) {
      hiddenAutoPaused = true;
      pause(P.HIDDEN, 'Tab went to the background — browsers throttle background timers, so the run is auto-paused. It resumes when the tab is visible again.');
    } else if (!document.hidden && hiddenAutoPaused && paused && pauseCode === P.HIDDEN) {
      hiddenAutoPaused = false;
      // Tab switches are not a fault: don't let them burn the escalation budget.
      lastPauseCode = '';
      repeatPauses = 0;
      log('Tab visible again — resuming.');
      start();
    }
  });
  $('#ttmu-dry').addEventListener('change', (e) => setDryRun(e.target.checked));
  $('#ttmu-target').addEventListener('change', (e) => setTarget(e.target.value));

  function updateUI() {
    $('#ttmu-run').textContent = dryRun ? `${dryTotal} dry` : String(runTotal);
    $('#ttmu-total').textContent = String(total);
    $('#ttmu-count').textContent = sessionCap
      ? `${unliked} / ${sessionCap} · ${processed}v`
      : '–';

    // Attempted-vs-verified is the number that tells you whether the script is
    // doing what it claims, so it belongs on screen and not just in a hook.
    const verified = $('#ttmu-verify');
    verified.textContent = `${attempts - verifyFailsTotal} / ${verifyFailsTotal}`;
    verified.classList.toggle('warnval', verifyFailsTotal > 0);

    const status = $('#ttmu-status');
    status.textContent = paused ? 'paused' : mode;
    status.classList.toggle('active', running);
    status.classList.toggle('warn', paused);

    $('#ttmu-dry-chip').classList.toggle('hidden', !dryRun);
    $('#ttmu-dry').checked = dryRun;

    // Never overwrite the field the user is typing into — updateUI() runs every
    // few seconds and would otherwise eat a half-typed number.
    const tgt = $('#ttmu-target');
    const focused = tgt.ownerDocument.activeElement === tgt;
    if (!focused) tgt.value = target ? String(target) : '';

    const btn = $('#ttmu-btn');
    const armed = startArmed && !running && !dryRun;
    btn.textContent = running
      ? 'Stop'
      : (armed ? 'Confirm — permanently unlikes' : 'Start');
    btn.classList.toggle('confirm', armed);
    btn.classList.toggle('secondary', running);

    const rst = $('#ttmu-reset');
    rst.textContent = resetArmed ? 'Confirm reset' : 'Reset counters';
    rst.classList.toggle('confirm', resetArmed);
    // While paused, Resume is the single primary action — a second identical
    // "Start" button beside it does the same thing and just adds doubt.
    btn.classList.toggle('hidden', paused);
    $('#ttmu-resume').classList.toggle('hidden', !paused);
    $('#ttmu-log').classList.toggle('warn', paused);
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  // The countdown OVERWRITES this one line; it never touches the log history.
  function setCountdown(text) {
    const el = $('#ttmu-countdown');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
  }

  // Same treatment for the readiness line: it is re-evaluated every couple of
  // seconds, so it must never append to the log.
  function setReady(text, go) {
    const el = $('#ttmu-ready');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
    el.classList.toggle('go', !!go);
  }

  function log(msg) {
    logHist.push(`${stamp()}  ${msg}`);
    while (logHist.length > CFG.logHistory) logHist.shift();
    const el = $('#ttmu-log');
    if (el) {
      el.textContent = logHist.join('\n');
      el.scrollTop = el.scrollHeight;
    }
    console.log('[TTMU]', msg);
  }

  // AWAITS the clipboard promise before claiming success — writeText can
  // reject (permissions, unfocused document) after the old version had already
  // logged "copied". Falls back to a hidden textarea + execCommand, then to
  // printing to the console.
  async function copyText(text, what) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        log(`${what} copied to the clipboard.`);
        return;
      }
    } catch (e) { /* fall through to the legacy path */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      if (ta.style) { ta.style.position = 'fixed'; ta.style.opacity = '0'; }
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand && document.execCommand('copy');
      ta.remove();
      if (ok) { log(`${what} copied to the clipboard (fallback).`); return; }
    } catch (e) { /* fall through to the console */ }
    console.log(`[TTMU] ${what}:\n` + text);
    log(`Clipboard unavailable — ${what.toLowerCase()} was printed to the console instead (F12 to open it).`);
  }

  function copyLog() {
    return copyText(logHist.join('\n'), 'Log');
  }

  // Recovery export: every verified unlike's URL, one per line, so a mistaken
  // run can be manually re-liked.
  function copyUnliked() {
    if (!unlikedUrls.length) {
      log('No unliked video URLs recorded this session.');
      return;
    }
    return copyText(unlikedUrls.join('\n'), `Unliked list (${unlikedUrls.length} URLs)`);
  }

  loadAnchor();
  updateUI();

  // TikTok is a single-page app: walking from For You to your profile to the
  // Liked tab to a video never reloads the script, so nothing would re-run the
  // guard between page loads. The panel used to evaluate it exactly once, at
  // injection, and then show that verdict forever. This slow poll keeps the
  // readiness line honest AND is what arms the liked-feed anchor the moment the
  // user's own Liked grid comes into view.
  let readyTimer = 0;

  function refreshReadiness() {
    if (running) { setReady(''); return; }
    const g = pageGuard();
    if (g.ok) setReady('Ready — this is your own Liked feed. Press Start.', true);
    else if (g.stage === 'profile') setReady(`Armed for @${ownHandleCache} — open a video from your Liked grid.`, true);
    else setReady(`Not ready — ${g.msg}`);
  }

  function readinessTick() {
    readyTimer = 0;
    try { refreshReadiness(); } catch (e) { /* never let the poll die */ }
    readyTimer = setTimeout(readinessTick, CFG.readyPollMs);
  }
  readinessTick();

  // What the guard is actually looking at. When the panel refuses and the
  // reason doesn't match what you see on screen, this says which selector
  // produced which value — the difference between diagnosing and guessing.
  function diagnose() {
    const seen = (list) => list.filter((sel) => {
      try { return !!visibleMatch([sel]); } catch (e) { return false; }
    });
    const rawHref = (() => {
      for (const sel of ['a[data-e2e="nav-profile"]', '[data-e2e="profile-icon"] a[href^="/@"]']) {
        const el = document.querySelector(sel);
        if (el) return `${sel} -> ${el.getAttribute('href')}`;
      }
      return '(no signed-in profile link found)';
    })();
    const g = pageGuard();
    const out = {
      pathname: location.pathname,
      pathKind: pathInfo().kind,
      pathHandle: pathInfo().handle || '(not handle-shaped)',
      ownHandle: ownHandle() || '(unknown)',
      ownHandleFrom: ownHandleSource || '(nothing matched)',
      ownHandleRawLink: rawHref,
      likedTab: likedTabState(),
      viewerKind: viewerKind(),
      browseMarkers: seen(BROWSE_SELECTORS),
      feedMarkers: seen(FEED_SELECTORS),
      containerMarkers: seen(CONTAINER_SELECTORS),
      anchor: anchor ? { handle: anchor.handle, ageMs: Date.now() - anchor.at } : null,
      likeButton: !!findLikeButton(),
      nextButton: !!findNextButton(),
      guard: { ok: g.ok, stage: g.stage, msg: g.msg },
      // Which roots are on screen and whether each actually contains the
      // controls. A root that is present but yields nothing is the signature of
      // a scoping bug rather than a missing button.
      roots: activeContainers().map((el) => ({
        e2e: el.getAttribute('data-e2e') || null,
        id: el.getAttribute('id') || null,
        cls: (el.getAttribute('class') || '').slice(0, 80) || null,
        area: Math.round(visibleArea(el)),
        hasLike: !!likeButtonIn(el),
        hasNext: !!nextButtonIn(el).btn,
      })),
      // Every like-ish element on the page, in or out of scope. If findLikeButton
      // is null but this list isn't, the selector is right and the SCOPE is wrong.
      likeish: (() => {
        const roots = activeContainers();
        const seen = [];
        const add = (el) => {
          if (seen.some((s) => s.el === el)) return;
          seen.push({
            el,
            tag: el.tagName,
            e2e: el.getAttribute('data-e2e') || null,
            aria: (el.getAttribute('aria-label') || '').slice(0, 60) || null,
            pressed: el.getAttribute('aria-pressed'),
            inComments: inComments(el),
            inRoot: roots.findIndex((r) => r.contains(el)),
          });
        };
        try {
          for (const el of document.querySelectorAll('[data-e2e]')) {
            if (/like/i.test(el.getAttribute('data-e2e') || '')) add(el);
          }
          for (const el of document.querySelectorAll('button[aria-label*="ike"]')) add(el);
        } catch (e) { /* best effort */ }
        return seen.slice(0, 20).map(({ el, ...rest }) => rest);
      })(),
    };
    console.log('[TTMU] diagnostics\n' + JSON.stringify(out, null, 2));
    return out;
  }

  // Debug / test hook.
  window.__TTMU__ = {
    diagnose,
    CFG, P,
    start, stop, resume, pause, setDryRun, setTarget, resetCounters,
    findNextButton, findLikeButton, isLiked, pageGuard, ownHandle,
    pathInfo, viewerKind, likedTabState, refreshReadiness,
    anchor: () => (anchor ? { handle: anchor.handle, at: anchor.at } : null),
    copyLog, copyUnliked,
    unlikedUrls: () => unlikedUrls.slice(),
    get panel() { return panel; },
    get loopPromise() { return loopPromise; },
    logHistory: () => logHist.slice(),
    state: () => ({
      running, paused, pauseCode, pauseReason, mode, dryRun, dryDone, target,
      unliked, processed, runTotal, dryTotal, total, session, sessionCap,
      repeatPauses, attempts, verifyFailsTotal, lastNextMiss,
      verifyFails: failCount(verifyTrk), verifyStreak: verifyTrk.streak,
      navFails: failCount(navTrk), navStreak: navTrk.streak,
      detFails: failCount(detTrk), detStreak: detTrk.streak,
    }),
  };
})();
