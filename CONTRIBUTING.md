# Contributing to TikTok Mass Unliker

Thanks for your interest in contributing!

## Reporting issues

Open a GitHub issue and include:

- What you expected to happen and what actually happened
- Browser, userscript manager, and versions
- Any relevant messages from the panel log or browser console (prefixed `[TTMU]`)

## Development setup

1. Clone the repository
2. Load `tiktok-mass-unliker.user.js` in Tampermonkey/Violentmonkey (or point the manager at the local file for live editing)
3. Test against your own Liked feed

## Pull requests

- Keep changes focused; one feature or fix per PR
- Match the existing code style (vanilla JavaScript, no dependencies, two-space indentation)
- Do not weaken the pacing safeguards (session caps, delays, breaks) — they are intentional
- Selector changes should keep the skip-when-unsure behavior: never click when the like state is unknown

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
