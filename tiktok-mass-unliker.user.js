// ==UserScript==
// @name         TikTok Mass Unliker
// @namespace    flxtcg.tools
// @version      1.6.0
// @description  Gradually unlikes videos while browsing your Liked feed. Paced clicking, session caps, and a start/stop panel.
// @author       Felix Wang
// @license      MIT
// @match        https://www.tiktok.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------------- Config ----------------
  const CFG = {
    sessionCapMin: 50,        // session cap is rolled randomly in this range
    sessionCapMax: 150,       //   at the start of each session
    sessionBreakMinMs: 3 * 60000,   // break between sessions: min (3 min)
    sessionBreakMaxMs: 7 * 60000,  // break between sessions: max (7 min)
    delayMinMs: 1500,         // min wait between videos
    delayMaxMs: 5000,         // max wait between videos
    clickJitterMs: 400,       // random pause between "seeing" and clicking
  };

  // ---------------- State ----------------
  let running = false;
  let unliked = 0;   // this session
  let total = 0;     // all sessions since START
  let session = 0;   // completed sessions
  let scanned = 0;
  let stuck = 0;
  let timer = null;
  let sessionCap = 0; // rolled per session
  let mode = 'idle';  // idle | running | on break

  const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
  const sleep = (ms) => new Promise((r) => (timer = setTimeout(r, ms)));

  // Sleep with a live per-second countdown in the log. Aborts early if stopped.
  async function countdownSleep(ms, labelFn) {
    let remaining = Math.round(ms / 1000);
    while (remaining > 0 && running) {
      log(labelFn(remaining));
      await sleep(1000);
      remaining--;
    }
  }

  // ---------------- Like button detection ----------------
  // TikTok's DOM shifts often; try several strategies, most specific first.
  function findLikeButton() {
    const selectors = [
      'span[data-e2e="browse-like-icon"]',   // desktop video viewer
      'span[data-e2e="like-icon"]',          // feed layout
      'button[aria-label*="Like" i]',        // aria fallback
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el.closest('button') || el;
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

  // Find TikTok's "next video" chevron and click it.
  // Synthetic ArrowDown keydowns are ignored (isTrusted check), but
  // clicking the real button element works.
  function findNextButton() {
    const selectors = [
      'button[data-e2e="arrow-right"]',
      'button[data-e2e="browse-video-next"]',
      'button[aria-label*="next" i]',
      'button[aria-label*="scroll down" i]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && !el.disabled) return el;
    }
    // Heuristic fallback: a button whose SVG path points downward,
    // positioned on the right half of the viewer (the ˅ chevron).
    const candidates = [...document.querySelectorAll('button:has(svg)')];
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
      if (location.href !== before) return true;
    }
    return false;
  }

  // ---------------- Main loop ----------------
  async function loop() {
    while (running) {
      if (unliked >= sessionCap) {
        session++;
        const b = rand(CFG.sessionBreakMinMs, CFG.sessionBreakMaxMs);
        mode = 'on break';
        updateUI();
        await countdownSleep(b, (s) =>
          `☕ Break — ${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`);
        if (!running) return;
        // roll a fresh session
        unliked = 0;
        sessionCap = rand(CFG.sessionCapMin, CFG.sessionCapMax + 1);
        mode = 'running';
        log(`Session ${session + 1} started — cap: ${sessionCap}`);
        updateUI();
      }

      const btn = findLikeButton();
      scanned++;

      if (!btn) {
        log('No like button found — are you in the video viewer? Retrying…');
        await sleep(4000);
        updateUI();
        continue;
      }

      const liked = isLiked(btn);
      await sleep(rand(200, CFG.clickJitterMs)); // human "reaction time"
      if (!running) return;

      if (liked === true) {
        btn.click();
        unliked++;
        total++;
        log(`Unliked #${total}`);
      } else if (liked === false) {
        log('Already unliked, skipping.');
      } else {
        log('Could not determine like state — skipping to be safe.');
      }
      updateUI();

      const advanced = await nextVideo();
      if (!running) return;
      if (!advanced) {
        stuck++;
        log(`Couldn't advance to next video (${stuck}/3)…`);
        if (stuck >= 3) {
          log('Stuck on the same video 3x — end of feed or nav button not found. Stopping.');
          stop();
          return;
        }
      } else {
        stuck = 0;
      }
      await sleep(rand(CFG.delayMinMs, CFG.delayMaxMs));
    }
  }

  function start() {
    if (running) return;
    unliked = 0;
    scanned = 0;
    stuck = 0;
    session = 0;
    total = 0;
    sessionCap = rand(CFG.sessionCapMin, CFG.sessionCapMax + 1);
    running = true;
    mode = 'running';
    updateUI();
    log(`Session 1 started — cap: ${sessionCap}. Keep this tab focused.`);
    loop();
  }

  function stop() {
    running = false;
    mode = 'idle';
    if (timer) clearTimeout(timer);
    updateUI();
  }

  // ---------------- UI (retro sunset: navy base, cream text, sunset orange accent) ----------------
  const panel = document.createElement('div');
  panel.id = 'ttmu-panel';
  panel.innerHTML = `
    <style>
      #ttmu-panel {
        position: fixed; bottom: 20px; right: 20px; z-index: 999999;
        width: 230px; padding: 12px 14px;
        background: linear-gradient(180deg, #273248 0%, #1E2738 100%);
        border: 1px solid #46536F; border-radius: 10px;
        font-family: ui-monospace, "Cascadia Code", "JetBrains Mono", Menlo, monospace;
        color: #FFEBD2; box-shadow: 0 12px 32px rgba(2, 8, 20, .45);
        font-size: 12px; line-height: 1.5;
        font-variant-numeric: tabular-nums;
      }
      #ttmu-panel h4 {
        position: relative; margin: 0 0 12px; padding-bottom: 8px;
        font-size: 13px; font-weight: 700; letter-spacing: .05em;
        color: #FFEBD2;
      }
      #ttmu-panel h4::before { content: "▂ "; color: #FC7643; }
      #ttmu-panel h4::after {
        content: ""; position: absolute; left: 0; right: 0; bottom: 0;
        height: 4px; border-radius: 2px;
        background: linear-gradient(90deg, #FFA364 0%, #FC7643 50%, #AF4F41 100%);
      }
      #ttmu-panel .row { display: flex; justify-content: space-between; margin: 3px 0; gap: 12px; }
      #ttmu-panel .row span { color: #A2ABBE; }
      #ttmu-panel button {
        width: 100%; margin-top: 10px; padding: 7px 0; border: 1px solid #FC7643; border-radius: 6px;
        font-family: inherit; font-weight: 700; font-size: 12px; cursor: pointer;
        background: #FC7643; color: #2A1408;
      }
      #ttmu-panel button:hover { background: #FFA364; border-color: #FFA364; }
      #ttmu-panel button.running { background: #313E58; color: #FFA364; border: 1px solid #FFA364; }
      #ttmu-log { margin-top: 8px; color: #A2ABBE; font-size: 11px; min-height: 14px;
        white-space: normal; word-break: break-word; line-height: 1.4;
        font-variant-numeric: tabular-nums; }
    </style>
    <h4>TikTok Mass Unliker</h4>
    <div class="row"><span>Session</span><b id="ttmu-count">–</b></div>
    <div class="row"><span>Total</span><b id="ttmu-total">0</b></div>
    <div class="row"><span>Status</span><b id="ttmu-status">idle</b></div>
    <button id="ttmu-btn">START</button>
    <div id="ttmu-log">Open a video in your Liked tab first.</div>
  `;
  document.body.appendChild(panel);

  const $ = (id) => panel.querySelector(id);
  $('#ttmu-btn').addEventListener('click', () => {
    if (running) { stop(); log('Stopped.'); } else { start(); }
  });

  function updateUI() {
    $('#ttmu-count').textContent = sessionCap ? `${unliked} / ${sessionCap}` : '–';
    $('#ttmu-total').textContent = total;
    $('#ttmu-status').textContent = mode;
    const btn = $('#ttmu-btn');
    btn.textContent = running ? 'STOP' : 'START';
    btn.classList.toggle('running', running);
  }

  updateUI();

  function log(msg) {
    $('#ttmu-log').textContent = msg;
    console.log('[TTMU]', msg);
  }
})();