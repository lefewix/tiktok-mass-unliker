<div align="center">

<img src="icons/icon128.png" width="88" alt="TikTok Mass Unliker icon">

# TikTok Mass Unliker

**Clear out your TikTok likes gradually and safely.**

![Chrome extension](https://img.shields.io/badge/Chrome-extension-4285F4?style=flat-square&logo=googlechrome&logoColor=white)
![Userscript](https://img.shields.io/badge/userscript-Tampermonkey-00485B?style=flat-square&logo=tampermonkey&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![License](https://img.shields.io/badge/license-MIT-lightgrey?style=flat-square)

</div>

A Chrome extension and userscript that unlikes videos in your own Liked feed, in paced sessions with
randomised delays. A floating panel shows live progress, with a dry run mode, a target count and Start/Stop.

## Features

- **Only runs on your own Liked feed**, and pauses the moment the page changes
- **Human pacing**: 50–150 unlikes per session, 1.5–5 s between videos, 3–7 min breaks
- **Verified clicks**: every unlike is re-checked; repeated failures pause the run
- **Dry run first**: the first run is a rehearsal by default
- **Two-step Start** so one stray click can't begin a real run
- **Recovery list**: copy the URL of every video it unliked
- **Survives reloads**: counts, target and position are remembered

## Install

**As a Chrome extension:** download this repo, open `chrome://extensions`, turn on **Developer mode**,
click **Load unpacked** and select the folder.

**As a userscript:** install [Tampermonkey](https://www.tampermonkey.net/) or
[Violentmonkey](https://violentmonkey.github.io/), then open `tiktok-mass-unliker.user.js` to install it.

## Usage

1. Open your TikTok profile and click the **Liked** tab (this arms the script)
2. Open the first video
3. Press **Start**, then **Confirm** within 5 seconds for a real run
4. Keep the tab in front; press **Stop** any time

## How it works

The script finds the video on screen, reads its like state from `aria-pressed`, the label and the icon
colour, clicks, then re-reads the state and only counts the unlike if it really flipped. A page guard checks
on every video that you're still in your own Liked feed, and any anomaly pauses the run instead of guessing.

<details>
<summary><b>The page guard</b></summary>

A liked video's URL carries its creator's handle, not yours, so the URL alone can't prove you're in your own
Liked feed. Instead, the script arms an anchor on your own profile's Liked tab and carries it into the viewer.
The anchor is per tab (`sessionStorage`), so it never follows you into a new window.

On a video it requires the anchor for the signed-in account, a viewer on screen and no recommendation feed.
For You also rewrites the URL to a video permalink, so the difference is settled in the page: a browse-mode
container proves the video was opened from a list. Handles are validated against `[a-z0-9_.]{1,24}`
everywhere they're read. The guard re-runs before Start, on every video and every 2 seconds.

</details>

<details>
<summary><b>Pauses and safety limits</b></summary>

Each pause has a reason code (`guard`, `no-like-button`, `indeterminate`, `verify-streak`, `verify-ceiling`,
`nav-labels`, `hidden-tab`…). Repeating the same pause adds a growing cooldown (30 s up to 5 min), and after
five the script refuses to resume.

Measured with the test harness (seeded, virtual clock):

| Failure pattern | Rolling window only | With the per-run ceiling |
| --- | --- | --- |
| 2% random | worst 116 mistaken clicks | worst **10** |
| 10% random | worst 23 | worst **10** |
| periodic 1-in-5 | never trips | **10** |

Sustained pace is about **450–550 unlikes per hour**.

</details>

<details>
<summary><b>Limitations</b></summary>

- Desktop web, English UI only
- TikTok DOM changes can break detection; the script pauses rather than guesses
- The tab must stay in front (background tabs pause automatically)
- Unliking can't be undone by the script; use **Copy unliked list** to re-like by hand
- Run `__TTMU__.diagnose()` in the console to see why the guard refused

</details>

> [!NOTE]
> This only removes your own likes on your own account, but automation may still conflict with TikTok's
> Terms of Service. Use at your own risk and keep the default pacing.

## Development

No dependencies, no test runner, no network.

```
node test.js
```

It runs the real script against a hand-built DOM with a virtual clock and seeded randomness. Every number
in this README comes from that harness.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Felix Wang
