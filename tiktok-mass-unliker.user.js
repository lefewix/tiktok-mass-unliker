// ==UserScript==
// @name         TikTok Mass Unliker
// @namespace    flxtcg.tools
// @version      1.9.0
// @description  Gradually unlikes videos while browsing your own Liked feed. Liked-feed page guard, paced clicking, windowed + cumulative click verification, container-scoped selectors, session caps, dry run, target count, and a start/stop panel.
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
    resumeBackoffMs: 30000,   // first backoff after a repeated same-reason pause
    resumeBackoffMaxMs: 5 * 60000,
    resumeGiveUpAfter: 5,     // refuse to resume after this many identical pauses
    logHistory: 40,           // lines of scrollback kept in the panel log
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
  let hiddenWarned = false;

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

  // Sleep with a live per-second countdown in the log. Aborts early if stopped.
  async function countdownSleep(ms, labelFn) {
    let remaining = Math.round(ms / 1000);
    while (remaining > 0 && running && !paused) {
      log(labelFn(remaining));
      await sleep(1000);
      remaining--;
    }
  }

  // ---------------- Persistence ----------------
  // `activity` = this save follows real work (a video processed, a window
  // rolled, a run started). Idle saves — toggling dry run, editing the target —
  // must NOT push `at` forward, or the 6h session window never expires.
  function save(activity) {
    if (activity) lastActivity = Date.now();
    writeStore({
      total,
      target,
      dryRun,
      handle: ownHandleCache,
      session: {
        unliked,
        processed,
        cap: sessionCap,
        runTotal,
        dryTotal,
        attempts,
        verifyFailsTotal,
        num: session,
        at: lastActivity,
      },
    });
  }

  function load() {
    const s = readStore();
    total = Number(s.total) || 0;
    target = Number(s.target) || 0;
    dryRun = !!s.dryRun;
    ownHandleCache = typeof s.handle === 'string' ? s.handle : '';
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

  // ---------------- Page guard ----------------
  // The container selectors below match TikTok's video viewer EVERYWHERE — For
  // You, hashtag pages, someone else's profile. Without this guard, reloading
  // onto For You and pressing Start from habit strips likes off the wrong feed
  // at ~500/hour. Nothing starts, and nothing keeps running, unless the
  // location still looks like the user's own liked view.
  const HANDLE_RE = /^\/@([^/?#]+)/;

  function ownHandle() {
    for (const sel of [
      'a[data-e2e="nav-profile"]',
      '[data-e2e="profile-icon"] a[href^="/@"]',
      'a[data-e2e="user-detail-profile"]',
    ]) {
      const el = document.querySelector(sel);
      const href = el && (el.getAttribute('href') || '');
      const m = href && href.match(HANDLE_RE);
      if (m) {
        const h = decodeURIComponent(m[1]).toLowerCase();
        if (h && h !== ownHandleCache) { ownHandleCache = h; save(false); }
        return h;
      }
    }
    return ownHandleCache || '';   // last known handle survives the video modal
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

  // { ok, msg }. Called before start() and again on every loop iteration.
  function pageGuard() {
    const m = (location.pathname || '').match(HANDLE_RE);
    if (!m) {
      return { ok: false, msg: 'Not on a profile page — this looks like For You, a hashtag or search feed. ' +
        'Open your own profile, pick the Liked tab, then open a video from it.' };
    }
    const here = decodeURIComponent(m[1]).toLowerCase();
    const own = ownHandle();
    if (own && here !== own) {
      return { ok: false, msg: `This is @${here}'s profile, not yours (@${own}) — refusing to unlike here.` };
    }
    if (likedTabState() === 'no') {
      return { ok: false, msg: 'The Liked tab is not the selected tab on this profile — open Liked first.' };
    }
    if (!own) {
      return { ok: false, msg: "Can't confirm this is your own Liked feed — your profile link wasn't found on the page. " +
        'Open your profile, pick the Liked tab, then open a video from it.' };
    }
    return { ok: true, msg: '' };
  }

  // ---------------- Like button detection ----------------
  // Everything is scoped to the active video container so an open comment
  // drawer can never hand us a comment's like button.
  const CONTAINER_SELECTORS = [
    'div[data-e2e="browse-video"]',
    'div[data-e2e="browse-container"]',
    '#main-content-video_detail',
    'div[class*="DivBrowserModeContainer"]',
    'div[class*="DivVideoDetailContainer"]',
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

  function activeContainer() {
    let best = null;
    let bestArea = -1;
    for (const sel of CONTAINER_SELECTORS) {
      const found = document.querySelectorAll(sel);
      for (const el of found) {
        const a = visibleArea(el);
        if (a > bestArea) { best = el; bestArea = a; }
      }
      // A selector earlier in the list is more specific: once it matched
      // anything visible, don't let a looser selector outrank it.
      if (best && bestArea > 0) return best;
    }
    return best;
  }

  // TikTok's DOM shifts often; try several strategies, most specific first.
  // No container => no button. There is deliberately NO document-wide fallback:
  // searching the whole page would let the script act on some other video (or
  // another page entirely) instead of failing safe into the 3-strike pause.
  function findLikeButton() {
    const root = activeContainer();
    if (!root) return null;
    for (const sel of [
      'span[data-e2e="browse-like-icon"]',   // desktop video viewer
      'span[data-e2e="like-icon"]',          // feed layout
    ]) {
      const el = root.querySelector(sel);
      if (el) return el.closest('button') || el;
    }
    const el = root.querySelector('button[aria-label*="Like" i]');
    if (el) return el;
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

    // 2) aria-label wording ("Like video" vs "Unlike video" / "Liked")
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    if (label.includes('unlike') || label.includes('liked')) return true;
    if (label.startsWith('like')) return false;

    // 3) SVG fill heuristic — liked heart is TikTok red (rgb(254,44,85) / #fe2c55)
    const svg = btn.querySelector('svg');
    if (svg) {
      const fills = [svg, ...svg.querySelectorAll('[fill]')]
        .map((n) => (n.getAttribute('fill') || '').toLowerCase());
      if (fills.some((f) => f.includes('fe2c55') || f.includes('rgba(254'))) return true;
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
  // Synthetic ArrowDown keydowns are ignored (isTrusted check), but
  // clicking the real button element works.
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

  function findNextButton() {
    const scope = activeContainer();
    if (!scope) { lastNextMiss = 'no-container'; return null; }
    // Most specific: TikTok's own hooks. Still deny-checked in case the hook
    // is reused on a control that does something else.
    for (const sel of [
      'button[data-e2e="arrow-right"]',
      'button[data-e2e="browse-video-next"]',
    ]) {
      const el = scope.querySelector(sel);
      if (el && !el.disabled && !vetoed(labelOf(el))) { lastNextMiss = ''; return el; }
    }
    let labelled = 0;
    for (const b of scope.querySelectorAll('button')) {
      if (b.disabled) continue;
      const label = labelOf(b);
      if (!label) continue;
      labelled++;
      if (vetoed(label)) continue;
      if (NEXT_ALLOW_RE.test(label)) { lastNextMiss = ''; return b; }
    }
    lastNextMiss = labelled ? 'no-match' : 'no-labels';
    return null;
  }

  // Clicks next and confirms the URL actually changed. Returns true/false.
  async function nextVideo() {
    const before = location.href;
    const btn = findNextButton();
    if (btn) {
      btn.click();
    } else {
      // last resort: try the keydown anyway
      const ev = new KeyboardEvent('keydown', {
        key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true,
      });
      document.body.dispatchEvent(ev);
    }
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
      updateUI();
      await countdownSleep(b, (s) => `Backoff ${s}s — repeated pause, retrying slowly.`);
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
      log(`Not starting — ${guard.msg}`);
      updateUI();
      return;
    }
    clearStrikes();
    hiddenWarned = false;
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
    loopPromise = loop();
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
    save(false);   // idle toggle: must not extend the session window
    updateUI();
  }

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
        --ttmu-ac: #8b5cf6;
        --ttmu-ac-pale: color-mix(in srgb, var(--ttmu-ac) 45%, white);
        --ttmu-ac-soft: color-mix(in srgb, var(--ttmu-ac) 72%, white);
        --ttmu-warn: #f0b866;
        --ttmu-surface: #17161c;
        --ttmu-surface3: #17171c;
        --ttmu-inp: #0c0c10;
        --ttmu-txt: #ecebf0;
        --ttmu-txtstrong: #ffffff;
        --ttmu-m1: #9b93b3;
        --ttmu-m7: #838096;
        --ttmu-b1: #24232c;
        --ttmu-hair: rgba(255, 255, 255, .08);
        --ttmu-hairh: rgba(255, 255, 255, .14);
        --ttmu-mono: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;

        position: fixed; bottom: 20px; right: 20px; z-index: 999999;
        width: 236px; padding: 14px;
        box-sizing: border-box;
        background: var(--ttmu-surface);
        border: 1px solid var(--ttmu-hair); border-radius: 14px;
        box-shadow: 0 4px 16px rgba(8, 5, 20, .45);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        font-size: 12px; line-height: 1.5; color: var(--ttmu-txt);
        font-variant-numeric: tabular-nums;
        -webkit-font-smoothing: antialiased;
        text-align: left;
      }
      #ttmu-panel *, #ttmu-panel *::before, #ttmu-panel *::after { box-sizing: border-box; }
      #ttmu-panel h4 {
        margin: 0 0 10px; padding: 0 0 10px;
        border-bottom: 1px solid var(--ttmu-hair);
        font-size: 13px; font-weight: 700; letter-spacing: -.02em;
        color: var(--ttmu-txtstrong); font-family: inherit;
      }
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
        font-family: inherit; font-size: 10.5px; font-weight: 600; letter-spacing: .03em;
        padding: 2px 7px; border-radius: 6px;
        color: var(--ttmu-m1);
        background: var(--ttmu-surface3);
        border: 1px solid var(--ttmu-b1);
        transition: color .15s, background-color .15s, border-color .15s;
      }
      #ttmu-panel #ttmu-status.active {
        color: var(--ttmu-ac-pale);
        background: color-mix(in srgb, var(--ttmu-ac) 16%, transparent);
        border-color: color-mix(in srgb, var(--ttmu-ac-soft) 32%, transparent);
      }
      #ttmu-panel #ttmu-status.warn {
        color: var(--ttmu-warn);
        background: color-mix(in srgb, var(--ttmu-warn) 14%, transparent);
        border-color: color-mix(in srgb, var(--ttmu-warn) 30%, transparent);
      }
      #ttmu-panel #ttmu-dry-chip {
        font-family: inherit; font-size: 10.5px; font-weight: 600; letter-spacing: .03em;
        padding: 2px 7px; border-radius: 6px;
        color: var(--ttmu-ac-pale);
        background: color-mix(in srgb, var(--ttmu-ac) 16%, transparent);
        border: 1px dashed color-mix(in srgb, var(--ttmu-ac-soft) 45%, transparent);
      }
      #ttmu-panel .hidden { display: none; }
      #ttmu-panel button {
        width: 100%; margin-top: 12px; padding: 8px 0;
        border: 1px solid var(--ttmu-ac); border-radius: 8px;
        font-family: inherit; font-size: 12px; font-weight: 600; letter-spacing: -.01em;
        cursor: pointer;
        background: var(--ttmu-ac); color: #fff;
        transition: color .15s, background-color .15s, border-color .15s;
      }
      #ttmu-panel button:hover {
        background: color-mix(in srgb, var(--ttmu-ac) 85%, white);
        border-color: color-mix(in srgb, var(--ttmu-ac) 85%, white);
      }
      #ttmu-panel button:active { transform: translateY(1px); }
      #ttmu-panel button:focus-visible { outline: 2px solid var(--ttmu-ac); outline-offset: 2px; }
      /* Secondary: only one solid-accent primary is ever visible at a time. */
      #ttmu-panel button.secondary {
        background: var(--ttmu-surface3); border-color: var(--ttmu-b1); color: var(--ttmu-m1);
      }
      #ttmu-panel button.secondary:hover {
        border-color: var(--ttmu-hairh); color: var(--ttmu-txt);
        background: #1a1922;
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
    </style>
    <h4>TikTok mass unliker</h4>
    <div class="row"><span>This session</span><b id="ttmu-run">0</b></div>
    <div class="row"><span>All time</span><b id="ttmu-total">0</b></div>
    <div class="row"><span>Window</span><b id="ttmu-count">–</b></div>
    <div class="row"><span>Clicks ok / failed</span><b id="ttmu-verify">0 / 0</b></div>
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
    <button id="ttmu-resume" class="hidden">Resume</button>
    <button id="ttmu-btn">Start</button>
    <div class="btnrow">
      <button id="ttmu-reset" class="secondary">Reset counters</button>
      <button id="ttmu-copy" class="secondary">Copy log</button>
    </div>
    <div id="ttmu-log"></div>
  `;
  document.body.appendChild(panel);

  const $ = (id) => panel.querySelector(id);

  load();

  $('#ttmu-btn').addEventListener('click', () => {
    if (running) stop('Stopped.');
    else start();
  });
  $('#ttmu-resume').addEventListener('click', () => resume());
  $('#ttmu-reset').addEventListener('click', () => resetCounters());
  $('#ttmu-copy').addEventListener('click', () => copyLog());

  // The README tells you to keep the tab focused; nothing used to check. A
  // background tab gets its timers throttled, so pacing quietly falls apart.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && running && !hiddenWarned) {
      hiddenWarned = true;
      log('Tab is in the background — browsers throttle background timers, so pacing will drift. Bring this tab back to the front.');
    } else if (!document.hidden) {
      hiddenWarned = false;
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
    btn.textContent = running ? 'Stop' : 'Start';
    btn.classList.toggle('secondary', running);
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

  function copyLog() {
    const text = logHist.join('\n');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        log('Log copied to the clipboard.');
        return;
      }
    } catch (e) { /* fall through */ }
    console.log('[TTMU] log:\n' + text);
    log('Clipboard unavailable — the log was printed to the console instead.');
  }

  updateUI();

  {
    const g = pageGuard();
    log(g.ok
      ? 'Ready — this looks like your own Liked feed. Press Start.'
      : `Not ready — ${g.msg}`);
  }

  // Debug / test hook.
  window.__TTMU__ = {
    CFG, P,
    start, stop, resume, pause, setDryRun, setTarget, resetCounters,
    findNextButton, findLikeButton, pageGuard, ownHandle,
    get panel() { return panel; },
    get loopPromise() { return loopPromise; },
    logHistory: () => logHist.slice(),
    state: () => ({
      running, paused, pauseCode, pauseReason, mode, dryRun, target,
      unliked, processed, runTotal, dryTotal, total, session, sessionCap,
      repeatPauses, attempts, verifyFailsTotal, lastNextMiss,
      verifyFails: failCount(verifyTrk), verifyStreak: verifyTrk.streak,
      navFails: failCount(navTrk), navStreak: navTrk.streak,
      detFails: failCount(detTrk), detStreak: detTrk.streak,
    }),
  };
})();
