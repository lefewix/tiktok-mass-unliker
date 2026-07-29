// ==UserScript==
// @name         TikTok Mass Unliker
// @namespace    flxtcg.tools
// @version      1.7.0
// @description  Gradually unlikes videos while browsing your Liked feed. Paced clicking, verified clicks, session caps, dry run, target count, and a start/stop panel.
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
    strikes: 3,               // consecutive failures before auto-pausing
    sessionIdleMs: 6 * 3600000, // persisted session window expires after 6h idle
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
  let dryRun = false;
  let target = 0;      // 0 = no target

  let unliked = 0;     // successful unlikes in the current cap window
  let processed = 0;   // videos seen in the current cap window
  let runTotal = 0;    // real unlikes this session (persisted)
  let dryTotal = 0;    // dry-run "would unlike" count this session (persisted)
  let total = 0;       // lifetime real unlikes (persisted)
  let session = 1;     // current session number
  let sessionCap = 0;  // rolled per cap window

  let stuck = 0;       // consecutive navigation failures
  let missing = 0;     // consecutive "no like button" failures
  let unflipped = 0;   // consecutive clicks that did not flip the state
  let loopPromise = null;
  let mode = 'idle';   // idle | running | break | paused | done

  const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

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
  function save() {
    writeStore({
      total,
      target,
      dryRun,
      dryTotal,
      session: {
        unliked,
        processed,
        cap: sessionCap,
        runTotal,
        num: session,
        at: Date.now(),
      },
    });
  }

  function load() {
    const s = readStore();
    total = Number(s.total) || 0;
    target = Number(s.target) || 0;
    dryRun = !!s.dryRun;
    dryTotal = Number(s.dryTotal) || 0;
    const sess = s.session;
    if (sess && Date.now() - (Number(sess.at) || 0) < CFG.sessionIdleMs) {
      unliked = Number(sess.unliked) || 0;
      processed = Number(sess.processed) || 0;
      sessionCap = Number(sess.cap) || 0;
      runTotal = Number(sess.runTotal) || 0;
      session = Number(sess.num) || 1;
    }
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

  function activeContainer() {
    for (const sel of CONTAINER_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // TikTok's DOM shifts often; try several strategies, most specific first.
  function findLikeButton() {
    const root = activeContainer();
    const scope = root || document;
    for (const sel of [
      'span[data-e2e="browse-like-icon"]',   // desktop video viewer
      'span[data-e2e="like-icon"]',          // feed layout
    ]) {
      const el = scope.querySelector(sel);
      if (el) return el.closest('button') || el;
    }
    // aria fallback only inside a known container — never document-wide.
    if (root) {
      const el = root.querySelector('button[aria-label*="Like" i]');
      if (el) return el;
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
  function findNextButton() {
    const scope = activeContainer() || document;
    const selectors = [
      'button[data-e2e="arrow-right"]',
      'button[data-e2e="browse-video-next"]',
      'button[aria-label*="next" i]',
      'button[aria-label*="scroll down" i]',
    ];
    for (const sel of selectors) {
      const el = scope.querySelector(sel);
      if (el && !el.disabled) return el;
    }
    // Heuristic fallback: a button whose label points downward (the ˅ chevron).
    const candidates = [...scope.querySelectorAll('button')];
    for (const b of candidates) {
      const label = (b.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('down') || label.includes('next')) return b;
    }
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
  async function loop() {
    while (running && !paused) {
      try {
        // --- target reached? ---
        const done = dryRun ? dryTotal : runTotal;
        if (target > 0 && done >= target) {
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
          save();
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
            pause("Can't find the like button — are you on the Liked feed?");
            return;
          }
          await sleep(4000);
          continue;
        }
        missing = 0;

        processed++;
        const liked = isLiked(btn);
        await sleep(rand(200, CFG.clickJitterMs)); // human "reaction time"
        if (!running || paused) return;

        if (liked === true) {
          if (dryRun) {
            dryTotal++;
            unliked++;
            log(`Would unlike #${dryTotal} (dry run)`);
          } else {
            btn.click();
            // verify the click actually flipped the state
            await sleep(rand(CFG.verifyMinMs, CFG.verifyMaxMs));
            if (!running || paused) return;
            const after = readLikeStateAgain(btn);
            if (after === false) {
              unflipped = 0;
              unliked++;
              runTotal++;
              total++;
              log(`Unliked #${total}`);
            } else if (after === true) {
              unflipped++;
              log(`Warning: click did not unlike (${unflipped}/2) — not counted.`);
              if (unflipped >= 2) {
                pause('Two clicks in a row left the video liked — stopping before we like something by mistake.');
                return;
              }
            } else {
              log('Warning: could not verify the click — not counted.');
            }
          }
        } else if (liked === false) {
          log('Already unliked, skipping.');
        } else {
          log('Could not determine like state — skipping to be safe.');
        }
        save();
        updateUI();

        // --- advance ---
        const advanced = await nextVideo();
        if (!running || paused) return;
        if (!advanced) {
          stuck++;
          log(`Couldn't advance to next video (${stuck}/${CFG.strikes})…`);
          if (stuck >= CFG.strikes) {
            pause('Stuck on the same video — end of feed, or the next button moved.');
            return;
          }
        } else {
          stuck = 0;
        }
        await sleep(rand(CFG.delayMinMs, CFG.delayMaxMs));
      } catch (err) {
        pause(`Error: ${(err && err.message) || err}`);
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
    save();
    updateUI();
  }

  // ---------------- Start / stop / pause ----------------
  function start() {
    if (running) return;
    stuck = 0;
    missing = 0;
    unflipped = 0;
    paused = false;
    pauseReason = '';
    running = true;
    mode = 'running';
    if (!sessionCap) {
      sessionCap = rand(CFG.sessionCapMin, CFG.sessionCapMax + 1);
    }
    log(`Session ${session} — cap: ${sessionCap}, ${unliked} done. Keep this tab focused.`);
    save();
    updateUI();
    loopPromise = loop();
    return loopPromise;
  }

  function stop(msg) {
    running = false;
    paused = false;
    pauseReason = '';
    mode = 'idle';
    abortSleep();
    if (msg) log(msg);
    save();
    updateUI();
  }

  function finish(msg) {
    running = false;
    paused = false;
    pauseReason = '';
    mode = 'done';
    abortSleep();
    log(msg);
    save();
    updateUI();
  }

  // Anomaly stop: distinct from a user-initiated stop, and resumable.
  function pause(reason) {
    running = false;
    paused = true;
    pauseReason = reason;
    mode = 'paused';
    abortSleep();
    log(`Paused: ${reason}`);
    save();
    updateUI();
  }

  function resume() {
    if (!paused) return;
    stuck = 0;
    missing = 0;
    unflipped = 0;
    return start();
  }

  function setDryRun(on) {
    dryRun = !!on;
    save();
    updateUI();
  }

  function setTarget(n) {
    target = Math.max(0, Number(n) || 0);
    save();
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
        --ttmu-m7: #7d7a90;
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
      #ttmu-panel button.running {
        background: var(--ttmu-surface3); border-color: var(--ttmu-b1); color: var(--ttmu-m1);
      }
      #ttmu-panel button.running:hover {
        border-color: var(--ttmu-hairh); color: var(--ttmu-txt);
        background: #1a1922;
      }
      #ttmu-panel #ttmu-resume { margin-top: 6px; }
      #ttmu-log {
        margin-top: 10px; padding-top: 10px;
        border-top: 1px solid var(--ttmu-hair);
        color: var(--ttmu-m7); font-size: 11px; min-height: 15px;
        white-space: normal; word-break: break-word; line-height: 1.45;
        font-variant-numeric: tabular-nums;
      }
      #ttmu-log.warn { color: var(--ttmu-warn); }
    </style>
    <h4>TikTok mass unliker</h4>
    <div class="row"><span>This session</span><b id="ttmu-run">0</b></div>
    <div class="row"><span>All time</span><b id="ttmu-total">0</b></div>
    <div class="row"><span>Window</span><b id="ttmu-count">–</b></div>
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
    <button id="ttmu-btn">Start</button>
    <button id="ttmu-resume" class="hidden">Resume</button>
    <div id="ttmu-log">Open a video in your Liked tab first.</div>
  `;
  document.body.appendChild(panel);

  const $ = (id) => panel.querySelector(id);

  load();

  $('#ttmu-btn').addEventListener('click', () => {
    if (running) stop('Stopped.');
    else start();
  });
  $('#ttmu-resume').addEventListener('click', () => resume());
  $('#ttmu-dry').addEventListener('change', (e) => setDryRun(e.target.checked));
  $('#ttmu-target').addEventListener('change', (e) => setTarget(e.target.value));

  function updateUI() {
    $('#ttmu-run').textContent = dryRun ? `${dryTotal} dry` : String(runTotal);
    $('#ttmu-total').textContent = String(total);
    $('#ttmu-count').textContent = sessionCap
      ? `${unliked} / ${sessionCap} · ${processed}v`
      : '–';

    const status = $('#ttmu-status');
    status.textContent = paused ? 'paused' : mode;
    status.classList.toggle('active', running);
    status.classList.toggle('warn', paused);

    $('#ttmu-dry-chip').classList.toggle('hidden', !dryRun);
    $('#ttmu-dry').checked = dryRun;
    $('#ttmu-target').value = target ? String(target) : '';

    const btn = $('#ttmu-btn');
    btn.textContent = running ? 'Stop' : 'Start';
    btn.classList.toggle('running', running);
    $('#ttmu-resume').classList.toggle('hidden', !paused);
    $('#ttmu-log').classList.toggle('warn', paused);
  }

  function log(msg) {
    $('#ttmu-log').textContent = msg;
    console.log('[TTMU]', msg);
  }

  updateUI();

  // Debug / test hook.
  window.__TTMU__ = {
    start, stop, resume, pause, setDryRun, setTarget,
    get loopPromise() { return loopPromise; },
    state: () => ({
      running, paused, pauseReason, mode, dryRun, target,
      unliked, processed, runTotal, dryTotal, total, session, sessionCap,
    }),
  };
})();
