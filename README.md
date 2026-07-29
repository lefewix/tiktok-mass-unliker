# TikTok Mass Unliker

A userscript that gradually unlikes videos while you browse your own Liked feed on TikTok. It works in paced sessions with randomized delays and caps, and shows a floating panel with live progress, a dry run mode, a target count, and a Start/Stop button.

## Features

- **Paced sessions** — each session unlikes a randomized number of videos (50–150), then takes a 3–7 minute break before the next one
- **Randomized delays** — 1.5–5 seconds between videos, plus a short "reaction time" before each click, to avoid bursty request patterns
- **Processed cap** — a session also breaks after seeing `cap × 2` videos even if it never reaches the unlike cap, so a feed full of already-unliked videos can't spin at full speed forever
- **Safe state detection** — a video's like state is confirmed via `aria-pressed`, `aria-label`, and icon color before clicking; if the state can't be determined, the video is skipped
- **Container-scoped selectors** — every lookup is scoped to the active video container. If no container is on the page, the script finds nothing and pauses rather than clicking something on another part of the page
- **Verified clicks with a windowed failure guard** — after each click the state is re-read. The script pauses on 2 consecutive failures *or* 3 failures in the last 10 verifications, so an alternating good/bad pattern can't keep it running
- **Dry run** — counts what it *would* unlike without clicking the like button
- **Target count** — "Stop after N", counted across reloads within the session window
- **Persistence** — counts, target, dry-run flag, and the current session survive a reload
- **Paused state with escalating backoff** — anomalies pause the script rather than stopping it; **Resume** picks up where it left off, but repeating the same pause earns an increasing cooldown and eventually a refusal
- **Reset counters** — a button that clears the session, run, and dry-run counters (lifetime total is kept)

## Installation

1. Install a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/)
2. Open `tiktok-mass-unliker.user.js` from this repository and install it (your userscript manager will detect it), or create a new script and paste in the contents

## Usage

1. Go to your TikTok profile and open the **Liked** tab
2. Click the first video to enter the video viewer
3. Press **Start** on the panel in the bottom-right corner
4. Keep the tab open and focused; press **Stop** at any time

### Panel controls

| Control | What it does |
| --- | --- |
| **Start / Stop** | Runs or halts the loop. Hidden while paused. |
| **Resume** | Only shown when the script paused itself. Clears the strike counters and continues. |
| **Reset counters** | Clears session, run, and dry-run counters and any paused state. Lifetime total is kept. |
| **Dry run** | Counts would-be unlikes without clicking the like button. |
| **Stop after** | Target count, `0` = no target. Leave the field focused while typing — the panel won't overwrite it. |

### Dry run

Dry run does **not** click the like button, so nothing is unliked. It **does still navigate the feed for real** — it clicks the next-video button and loads every video exactly as a real run would, at the same pacing. It is a rehearsal of the detection and pacing logic, not an offline simulation, and it generates the same navigation traffic against TikTok.

The dry-run count (`dryTotal`) lives inside the same 6-hour session window as the real run total. If you leave a dry run with a target of 50 and come back the next day, the count is gone and the run starts fresh instead of instantly reporting "Target reached".

### Target count

"Stop after N" compares against the *session* total (the real total in a normal run, the would-be total in a dry run), not the lifetime total. Because the session persists, stopping at 12/20 and reloading within 6 hours resumes toward 20, not 32. The target is checked before each navigation, so hitting it does not cost an extra page load. Use **Reset counters** to clear a stale target state.

### Persistence and the session window

State is stored under `ttmu.v1` via `GM_setValue` (or `localStorage` as a fallback): lifetime total, target, dry-run flag, and the current session (unliked, processed, cap, run total, dry total, session number, last-activity timestamp).

The session expires **6 hours after the last real activity**. Only real work — processing a video, rolling a new cap window, starting a run — refreshes that timestamp. Toggling dry run or editing the target does not, so idling in the panel can't extend the window indefinitely. The lifetime total never expires.

### Paused vs stopped

**Stopped** is user-initiated. **Paused** is the script stopping itself because something looked wrong: it can't find the like button (3 strikes), clicks aren't flipping the like state, or it can't advance past the same video. The status chip turns amber and a **Resume** button appears as the only primary action.

Resume is not free. If the script pauses repeatedly for the same reason it waits before retrying — 30s, then 60s, then 120s, capped at 5 minutes — and after the fifth identical pause it refuses to resume and asks you to fix the page or reset the counters.

## How it works

The script finds the active video container first (`data-e2e="browse-video"` and friends), then looks for the like button *inside it* using TikTok's `data-e2e` attributes with an `aria-label` fallback. There is deliberately no document-wide fallback: no container means no button, which means the 3-strike pause fires with an accurate message rather than the script quietly operating on some other element.

It confirms the video is currently liked, clicks, waits 300–500ms, re-reads the state, and only counts the unlike if the state actually flipped. Failures are tracked in a rolling window of the last 10 verifications — 2 in a row or 3 in the window pauses the run.

Navigation clicks the viewer's next button and confirms `location.href` actually changed. The next button is matched on precise next / arrow-down semantics with an explicit deny list (download, share, save, report, copy, embed, bookmark, comment, follow, …), so a "Download this video" button can never be mistaken for "next". Navigation failures use the same rolling-window guard.

## Pacing

Measured on a virtual clock over one simulated hour with an instantly-responding page (the fastest the pacing config allows):

| Scenario | Unlikes / hour |
| --- | --- |
| Fastest delays, cap rolled low (50) | ~600 |
| Fastest delays, cap rolled high (150) | ~650 |
| Mid-range seeded RNG | ~490 |
| Slowest delays | ~430 |

Within a single large 150-video window, before its break, the instantaneous rate peaks at roughly **970 unlikes/hour**. A real browser is slower than this, since every number above assumes zero page latency. Expect **400–650 per hour** in practice.

## Disclaimer

This script automates interactions with your own account and only removes your own likes. Automation may nonetheless conflict with TikTok's Terms of Service — use at your own risk. Conservative pacing defaults are built in; raising them is not recommended.

## Limitations

- Desktop web layout only (tiktok.com in a desktop browser)
- If TikTok changes its DOM structure, the selectors may need updating — the script skips or pauses rather than guessing when unsure
- The tab must remain open while running
- Verification is only as good as the DOM: if TikTok reports a stale like state, the windowed guard bounds the damage to about 3 mistaken clicks, but it cannot make it zero

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Felix Wang
