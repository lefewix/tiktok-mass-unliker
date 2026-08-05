# TikTok Mass Unliker

A Chrome extension / userscript that gradually unlikes videos while you browse your own Liked feed on TikTok. It works in paced sessions with randomized delays and caps, and shows a floating panel with live progress, a dry run mode, a target count, and a Start/Stop button.

## Features

- **Anchored liked-feed page guard** — the script refuses to start anywhere except your own Liked view, and pauses immediately if the page navigates away mid-run. Because a liked video's URL carries its *creator's* handle rather than yours, authorisation is taken on your own profile page and carried into the viewer as a per-tab anchor — see [The page guard](#the-page-guard)
- **Paced sessions** — each session unlikes a randomized number of videos (50–150), then takes a 3–7 minute break before the next one
- **Randomized delays** — 1.5–5 seconds between videos, plus a short "reaction time" before each click, to avoid bursty request patterns
- **Processed cap** — a session also breaks after seeing `cap × 2` videos even if it never reaches the unlike cap, so a feed full of already-unliked videos can't spin at full speed forever
- **Safe state detection** — a video's like state is confirmed via `aria-pressed`, `aria-label`, and icon color before clicking; if the state can't be determined, the video is skipped
- **Determinacy guard** — if the like state becomes unreadable (a DOM change), the script pauses and says so. It used to keep looping and unlike nothing for hours with the panel still reading "running"
- **Container-scoped selectors** — every lookup is scoped to the active video container, chosen by how much of the viewport it covers so a stale off-screen container can't win. If no container is on the page, the script finds nothing and pauses rather than clicking something on another part of the page
- **Verified clicks, rate guard + hard ceiling** — after each click the state is re-read. The script pauses on 2 consecutive failures, 3 failures in the last 10 verifications, *or* 10 failed verifications in total for the run — see [What the guards actually bound](#what-the-guards-actually-bound)
- **Two-step Start** — a real run permanently unlikes videos, so one stray click can't begin one: the first click arms the button ("Confirm — permanently unlikes") for 5 seconds, the second starts. Dry runs start on a single click
- **Dry run, on by default on the first run** — counts what it *would* unlike without clicking the like button. Until a dry run has been completed once, the checkbox starts ticked, so the very first **Start** a new user presses is a rehearsal
- **Unliked-URL export** — every *verified* unlike is recorded, and **Copy unliked list** hands back one URL per line, so a run you regret can be manually re-liked
- **Auto-pause in a background tab** — browsers throttle background timers, which distorts the pacing and can trip the navigation guard on phantom timeouts. The run pauses when the tab is hidden and resumes when it is visible again, without spending the escalation budget
- **Target count** — "Stop after N", counted across reloads within the session window
- **Persistence** — counts, target, dry-run flag, panel position/collapse, and the current session survive a reload
- **Paused state with escalating backoff** — anomalies pause the script rather than stopping it; **Resume** picks up where it left off, but repeating the same *kind* of pause earns an increasing cooldown and eventually a refusal
- **Readable log** — the panel keeps the last 40 log lines with a **Copy log** button, instead of one line that overwrites itself before you can read it. Break and backoff countdowns tick on their own status line, so a 7-minute break can't push 420 lines through the history and wipe the diagnostics
- **Reset counters** — a confirm-armed button that clears the session, run, and dry-run counters (lifetime total is kept)
- **Movable panel** — drag it by its title bar, collapse it with the **–** button; both are remembered

## Installation

### As an unpacked Chrome extension

1. Download or clone this repository
2. Open `chrome://extensions`, enable **Developer mode** (top right)
3. Click **Load unpacked** and select the repository folder

The same script runs as a content script; state is kept in the site's `localStorage` instead of userscript storage.

### As a userscript

1. Install a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/)
2. Open `tiktok-mass-unliker.user.js` from this repository and install it (your userscript manager will detect it), or create a new script and paste in the contents

## Usage

1. Go to your TikTok profile and open the **Liked** tab. The panel logs `Liked feed armed for @you` — this step is what authorises the run, so it cannot be skipped by pasting a video URL
2. Click the first video to enter the video viewer
3. Press **Start** on the panel in the bottom-right corner. On a real run the first press only *arms* the button — press the amber **Confirm — permanently unlikes** within 5 seconds to actually begin
4. Keep the tab open and focused; press **Stop** at any time. Switching away pauses the run rather than letting a throttled tab distort the pacing

The panel carries a live readiness line, re-checked every two seconds:

| It says | What to do |
| --- | --- |
| `Ready — this is your own Liked feed.` | press **Start** |
| `Armed for @you — open a video from your Liked grid.` | you are on the grid; open the first video |
| `Not ready — …` | it names the problem: For You, someone else's profile, the wrong tab, or a video URL you arrived at without going through your Liked grid |

Pressing **Start** when it is not ready does nothing, on purpose.

### The page guard

Everything below the surface of TikTok's video viewer looks identical on every feed: the same container, the same like button, the same next arrow. The guard is what makes "your Liked feed" a precondition rather than an assumption.

**What the URL can and cannot tell you.** A video opened from your Liked tab lives at `/@<creator>/video/<id>`. The handle in that path belongs to whoever *posted* the video — never to you. Your liked feed is full of other people's videos; that is what liking is. So the URL cannot answer "is this my liked feed?", and a guard built on comparing that handle to your own rejects every video in the feed. (Version 2.0.0 did exactly that and could never run at all — see [Version history](#version-history).)

The question is instead answered where it *is* answerable — on your own profile page, where the path really is yours and the Liked tab is visibly selected — and that fact is carried into the viewer as an **anchor**. The anchor lives in `sessionStorage`, so it is per tab: it survives a reload of a running job, and it dies with the tab rather than following you into a fresh window that happened to land on For You.

On a profile page the guard requires:

- the path handle is **yours**, matched against your own profile link in the nav chrome
- the Liked tab is explicitly the selected tab

Both true, it **arms** the anchor and tells you to open a video. It never runs here — there is nothing to unlike on a grid.

On a video permalink it requires:

- an anchor, armed in this tab, for the account that is *currently* signed in
- the anchor is not stale — see below
- no recommendation-feed container is on screen. For You and hashtag feeds also rewrite the address bar to the playing video's `/@creator/video/…` permalink, which is the one lookalike a URL check cannot catch
- a video viewer container *is* on screen
- the Liked tab is not explicitly some other tab

The handle in the URL is deliberately **not** checked. That is the fix.

Anchor staleness measures time since the guard last *passed*, not wall-clock age: a running loop re-confirms it once per video, so a long job never expires, while a tab parked on For You for four hours cannot come back and still count as armed.

The guard runs before **Start**, on every loop iteration, *and* on a 2-second idle poll. The poll matters because TikTok is a single-page app: walking from For You to your profile to the Liked tab to a video never reloads the extension, so without it nothing would re-evaluate the guard — or arm the anchor — between page loads. It is also what keeps the panel's readiness line honest instead of showing whatever was true at injection time.

Because it re-runs every iteration, an autoplay, a back button or a tapped hashtag pauses the run within one video instead of unliking its way through a stranger's feed.

Your own handle is read only from signed-in-user chrome (the nav bar profile link, the avatar menu). It is never read from a profile-detail link, which points at whoever's profile is being *viewed* — trusting that cached a stranger as "you", after which their profile read as your own.

### What the panel shows

| Row | Meaning |
| --- | --- |
| **This session** | Real (or would-be, in a dry run) unlikes since the session started |
| **All time** | Lifetime unlikes; never expires |
| **Window** | Progress through the current cap window, and videos seen in it |
| **Verified / failed** | Verified unlikes vs clicks that did *not* flip the like state. The second number is the one that matters — it turns amber as soon as it is non-zero |
| **Status** | `idle`, `running`, `break`, `paused` or `done` |

### Panel controls

| Control | What it does |
| --- | --- |
| **Start / Stop** | Runs or halts the loop. Hidden while paused. On a real run, Start is confirm-armed: click once to arm, again within 5s to begin. Toggling **Dry run** disarms it. |
| **Resume** | Only shown when the script paused itself. Clears the rolling strike counters and continues — but not the cumulative failure ceiling. |
| **Reset counters** | Clears session, run, dry-run and failed-verification counters and any paused state. Lifetime total is kept. Confirm-armed, like Start. |
| **Copy log** | Copies the panel's log scrollback to the clipboard. Success is only reported once the write actually settles; it falls back to a hidden textarea, then to the console. |
| **Copy unliked list** | Copies the URL of every verified unlike this session, one per line — the manual recovery path. |
| **Dry run** | Counts would-be unlikes without clicking the like button. Ticked by default until you have completed one dry run. |
| **Stop after** | Target count, `0` = no target. Leave the field focused while typing — the panel won't overwrite it. |

### Dry run

Dry run does **not** click the like button, so nothing is unliked. It **does still navigate the feed for real** — it clicks the next-video button and loads every video exactly as a real run would, at the same pacing. It is a rehearsal of the detection and pacing logic, not an offline simulation, and it generates the same navigation traffic against TikTok.

The dry-run count (`dryTotal`) lives inside the same 12-hour session window as the real run total. If you leave a dry run with a target of 50 and come back the next day, the count is gone and the run starts fresh instead of instantly reporting "Target reached".

### Target count

"Stop after N" compares against the *session* total (the real total in a normal run, the would-be total in a dry run), not the lifetime total. Because the session persists, stopping at 12/20 and reloading within 12 hours resumes toward 20, not 32. The target is checked before each navigation, so hitting it does not cost an extra page load. Use **Reset counters** to clear a stale target state.

### Persistence and the session window

State is stored under `ttmu.v1` via `GM_setValue` (or `localStorage` as a fallback): lifetime total, target, dry-run flag, the "a dry run has been completed" flag behind the first-run default, panel position and collapse state, your cached profile handle, and the current session (unliked, processed, cap, run total, dry total, clicks attempted, failed verifications, session number, last-activity timestamp, and the unliked-URL recovery list, capped at 2000).

The liked-feed anchor is deliberately **not** part of that store. It lives in `sessionStorage` under `ttmu.anchor.v1`, so it is scoped to the tab: authorisation to unlike does not outlive the browsing session that earned it, and it never leaks into a new window.

The session expires **12 hours after the last real activity**. It used to be 6, which was shorter than a measured full run (4–6 hours), so a long job could have its own counters expire underneath it. Expiry is now logged loudly instead of silently zeroing the session.

Only real work — processing a video, rolling a new cap window, starting a run — refreshes that timestamp. Toggling dry run or editing the target does not, so idling in the panel can't extend the window indefinitely. The lifetime total never expires.

### Paused vs stopped

**Stopped** is user-initiated. **Paused** is the script stopping itself because something looked wrong. The status chip turns amber and a **Resume** button appears as the only primary action. Each pause carries a stable internal *code*:

| Code | What happened |
| --- | --- |
| `guard` | the page is no longer your own Liked feed — a different profile, a recommendation feed, the viewer closed, or the anchor went stale |
| `no-like-button` | 6 strikes without a like button in the container (~39s of patience) |
| `indeterminate` | the like state can't be read at all — TikTok's DOM probably changed |
| `verify-streak` / `verify-window` | clicks aren't flipping the like state: 2 in a row, or 3 of the last 10 |
| `verify-ceiling` | 10 failed verifications in this run, however spread out |
| `nav-streak` / `nav-window` | can't advance past the same video |
| `nav-labels` | no button matched a next-video label — usually a non-English TikTok UI |
| `hidden-tab` | the tab went to the background; it resumes by itself when the tab is visible again |

Resume is not free. If the script pauses repeatedly for the same *code* it waits before retrying — 30s, then 60s, then 120s, capped at 5 minutes — and after the fifth pause with that code it refuses to resume and asks you to fix the page or reset the counters. The escalation used to key on the message text, which embeds live counters ("3 of the last 5…", "3 of the last 7…"): three different failure patterns produced three different sentences, reset the counter to 1 every time, and disarmed both the backoff and the refusal.

## How it works

The script finds the active video container first (`data-e2e="browse-video"` and friends), then looks for the like button *inside it* using TikTok's `data-e2e` attributes with an `aria-label` fallback. That fallback rejects any button inside a comment container: on desktop the comment drawer renders *inside* the same video container and its per-comment like buttons carry a "Like"-ish label, so an unqualified `aria-label*="Like"` match could unlike a comment. There is deliberately no document-wide fallback: no container means no button, which means the strike pause fires (6 strikes, ~39s of patience for a slow load) with an accurate message rather than the script quietly operating on some other element.

The like state itself is read in strict order: `aria-pressed` first, then label wording — the *unliked* forms are tested before any `liked` substring, so "Like video, liked by 1.2M" reads as unliked and social-proof copy can never masquerade as a liked state — and only then the icon fill, anchored to TikTok's actual like red (`#fe2c55` / `rgb(254, 44, 85)`) rather than a loose `rgba(254` match that treated near-white fills as liked and clicked *like* on unliked videos.

It confirms the video is currently liked, clicks, waits 300–500ms, re-reads the state, and only counts the unlike if the state actually flipped. Failures feed a rolling window of the last 10 verifications *and* a cumulative per-run counter.

Navigation clicks the viewer's next button and confirms `location.href` actually changed. The next button is matched on precise next / arrow-down semantics; a deny list (download, share, save, report, copy, embed, bookmark, repost, duet, delete, …) vetoes a control **only when the next-pattern didn't match**, and every deny term is word-bounded. As an unbounded substring list it also blocked legitimate labels — "Next video in profile feed" (and the Liked feed *is* on the profile page), "in this collection", "comment count 12", "· muted", "fullscreen" — which stalled navigation rather than misclicking. "Download this video" is still never mistaken for "next", and "swipe down to save" still is one.

## What the guards actually bound

**The rate window bounds the failure *rate*, not the cumulative total.** An earlier version of this README claimed re-likes were bounded to "about 3". That was wrong, and these are the measured numbers.

Failure model: a click that does not flip the like state, i.e. the script may have re-liked the video. All figures come from `node test.js` and the same harness (seeded RNGs, virtual clock, 25 seeds per rate), so they are reproducible.

| Failure pattern | Rate window alone (v1.8.0) | With the cumulative ceiling (v1.9.0) |
| --- | --- | --- |
| 2% random | worst 116 re-likes, mean 37 | worst **10** |
| 5% random | worst 33 re-likes, mean 13 | worst **10** |
| 10% random | worst 23 re-likes, mean 7 | worst **10** |
| 20% random | worst 10 re-likes, mean 4 | worst **10** |
| perfectly periodic 1-in-5 | **never trips** — 2,483 re-likes in 24 simulated hours and still going | **10**, after 50 clicks |

The window catches dense failures well: at 20% it trips almost immediately, and every seeded run at every rate above trips. What it cannot see is a sparse-but-endless pattern — a perfectly periodic 1-in-5 never puts 3 failures inside a 10-verification window and never produces 2 in a row, so it evaded the guard forever. The cumulative ceiling (`verifyFailCeiling`, 10 per run) is what closes that: whatever the shape of the failures, the run stops at the tenth one.

The ceiling is per *run*, not per resume — resuming a run that hit it re-pauses at once, which then escalates through the backoff into the refusal. **Reset counters** is the deliberate way to clear it.

## Pacing

Measured on a virtual clock with an instantly-responding page, five seeded runs of one simulated hour each:

| | Unlikes / hour |
| --- | --- |
| Sustained, across five seeds | **461 – 547** (mean ~508) |
| Peak inside a single window, before its break | ~850 |

Every number assumes zero page latency, so a real browser is slower. Expect roughly **450–550 per hour** in practice, less on a slow connection.

## Version history

### 2.1.0 — the guard could never pass

**2.0.0 did not run.** The page guard required the handle in the URL to equal your own:

```js
const here = decodeURIComponent(m[1]).toLowerCase();   // the video's creator
const own  = ownHandle();                              // you
if (own && here !== own) return { ok: false, msg: `This is @${here}'s profile, not yours (@${own})…` };
```

Every video in a Liked feed was posted by someone else, so `here` was always a creator's handle and the guard refused on all of them: *"This is @someone's profile, not yours — refusing to unlike here."* The only page it ever accepted was a video you had both posted and liked yourself.

The test suite could not see it, because the harness generated feed URLs as `/@<your-handle>/video/<n>` — it modelled a liked feed in which you had authored every video, the single shape in which the check passes. The harness now generates `/@creator<n>/video/<id>`, and re-inserting the old comparison fails 26 tests.

Fixed by removing the comparison entirely and replacing it with the anchor described in [The page guard](#the-page-guard). Also in this release:

- `a[data-e2e="user-detail-profile"]` is no longer trusted as a source for your own handle. It is a link to the profile being *viewed*, so on a stranger's profile it cached them as "you" — which would have made the old guard agree that their profile was yours
- recommendation-feed containers are detected and vetoed, closing the lookalike the URL check never covered: For You rewrites the address bar to `/@creator/video/…` too
- a 2-second idle poll re-evaluates the guard, so the panel's verdict tracks single-page navigation instead of freezing at whatever was true when the script was injected
- **Start** on your Liked grid now says to open a video, instead of starting and burning six no-like-button strikes

## Disclaimer

This script automates interactions with your own account and only removes your own likes. Automation may nonetheless conflict with TikTok's Terms of Service — use at your own risk. Conservative pacing defaults are built in; raising them is not recommended.

## Limitations

- Desktop web layout only (tiktok.com in a desktop browser)
- **English UI only** — the next-video button is matched on English `aria-label` text. On another language the run pauses with the `nav-labels` code and says so
- If TikTok changes its DOM structure, the selectors may need updating — the script skips or pauses rather than guessing when unsure
- The tab must remain open and in the foreground: background tabs get their timers throttled, so pacing drifts. The script auto-pauses when the tab is hidden and resumes when it comes back, so a backgrounded tab costs you time rather than accuracy
- Verification is only as good as the DOM. If TikTok reports a stale like state, the guards bound the damage to **10 mistaken clicks per run** (see [What the guards actually bound](#what-the-guards-actually-bound)) — not zero, and not "about 3"
- **Unliking is irreversible from the script's side.** The recovery path is manual: **Copy unliked list** gives you every verified unlike's URL so you can re-like them by hand. The list is capped at 2000 URLs and lives in the same session window as the counters
- The page guard identifies your account from the signed-in-user chrome on the page (nav profile link, avatar menu). If TikTok stops rendering it and no handle has been cached yet, the script refuses to start rather than guessing
- The liked-feed anchor is per tab and is armed only by visiting your own profile's Liked tab. Opening a liked video's URL directly in a fresh tab is refused — there is no evidence there that the video came from *your* liked feed rather than from anywhere else on TikTok
- Distinguishing the liked feed from For You, once For You has rewritten the address bar to a video permalink, rests on recognising TikTok's recommendation-feed containers. If those markers change, the guard fails *closed* — it stops recognising your liked feed and refuses to run, rather than mistaking For You for it

## Tests

```
node test.js
```

No dependencies, no test runner, no network. It evaluates the real `tiktok-mass-unliker.user.js` in a `vm` context against a hand-rolled DOM, a virtual clock and seeded RNGs, prints a pass/fail line per test, and exits non-zero on failure. It covers the page guard — including the anchor lifecycle, a liked video posted by another creator, a cold landing on a video URL, a For You feed rewritten to a video permalink, anchor staleness, and the profile-detail link that must never identify you — the determinacy guard, pause-code escalation, the cumulative ceiling, the next-button deny/allow rules, the two-click confirm-arm on Start and Reset, the first-run dry-run default, adversarial like-state input (`"Like video, liked by 1.2M"`, near-white `rgba(254,254,254)` fills, a comment drawer's like button), the non-flooding countdown, the unliked-URL recovery list, every tier of the clipboard fallback, and a regression guard asserting the windowed failure tracker still trips at 2/5/10/20% failure rates. Every number in this README is produced by that harness.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Felix Wang
