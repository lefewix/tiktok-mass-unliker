# TikTok Mass Unliker

A userscript that gradually unlikes videos while you browse your own Liked feed on TikTok. It works in paced sessions with randomized delays and caps, and shows a floating start/stop panel with live progress.

## Features

- **Paced sessions** — each session unlikes a randomized number of videos (50–150), then takes a 3–7 minute break before the next one
- **Randomized delays** — 1.5–5 seconds between videos, plus a short "reaction time" before each click, to avoid bursty request patterns
- **Safe state detection** — a video's like state is confirmed via `aria-pressed`, `aria-label`, and icon color before clicking; if the state can't be determined, the video is skipped
- **Progress panel** — a floating panel shows session progress, running total, and current status, with a single start/stop button
- **Automatic stop** — the script stops on its own if it can't advance past the same video three times (end of feed or layout change)

## Installation

1. Install a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/)
2. Open `tiktok-mass-unliker.user.js` from this repository and install it (your userscript manager will detect it), or create a new script and paste in the contents

## Usage

1. Go to your TikTok profile and open the **Liked** tab
2. Click the first video to enter the video viewer
3. Press **START** on the panel in the bottom-right corner
4. Keep the tab open and focused; press **STOP** at any time

## How it works

The script finds the like button in the video viewer using TikTok's `data-e2e` attributes (with aria-label fallbacks), verifies the video is currently liked, clicks to unlike, then advances to the next video via the viewer's next button and confirms the URL actually changed. TikTok's DOM changes frequently, so each lookup tries several selectors from most to least specific.

## Disclaimer

This script automates interactions with your own account and only removes your own likes. Automation may nonetheless conflict with TikTok's Terms of Service — use at your own risk. Conservative pacing defaults are built in; raising them is not recommended.

## Limitations

- Desktop web layout only (tiktok.com in a desktop browser)
- If TikTok changes its DOM structure, the selectors may need updating — the script skips rather than guesses when unsure
- The tab must remain open while running

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Felix Wang
