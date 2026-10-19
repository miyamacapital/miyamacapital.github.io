# Miyama Capital Official Website

Source for [www.miyamacap.com](https://www.miyamacap.com), the static site of Miyama Capital LLC. Hosted on GitHub Pages from the `main` branch.

## Structure

- `index.html` — language redirect (remembers the visitor's choice).
- `zh/`, `en/`, `jp/` — one folder per language, each with `index.html`, `insights.html` (research archive), `disclosures.html`, `privacy.html` and `subscribed.html` (subscription status page).
- `assets/` — shared CSS and JS: `tailwind.css` (built, see below), `lab.css`, `lab.js` (menu), `lab-research.js` (homepage research cards), `subscribe.js` (subscription form).
- `data/articles.json` — the research catalog used by the archive pages and the homepage cards.
- `tools/apps-script/` — the Google Apps Script backend for research subscriptions and its deploy guide. Not published to the site (`_config.yml`).
- `tools/tailwind/` — Tailwind build config. Run `sh tools/tailwind/build.sh` after changing page markup or `assets/lab-tailwind.js`, then commit `assets/tailwind.css`.

## Updating

- **Text**: edit the page in the matching language folder.
- **Research archive**: add an entry to `data/articles.json` (newest first is not required; pages sort by date).
- **Subscription backend**: see `tools/apps-script/README.md`; tests run with `node tools/apps-script/test.js`.

© 2026 Miyama Capital LLC. All Rights Reserved.
