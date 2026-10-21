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

## Research catalog sync
`data/articles.json` feeds the research archive pages and the homepage "latest research" cards. It is kept current by `tools/feeds/sync.js` and the workflow `.github/workflows/sync-research.yml`:

- **What runs**: once a day and on manual dispatch, the workflow reads the vocus salon content list (zh-TW), the Substack RSS feed (en) and the note RSS feed (ja), appends every post whose URL is not yet in the catalog, and opens or updates one pull request titled **Sync research catalog** against `redesign/c-lab` (the `base` input changes the branch). Existing entries are never modified and nothing is pushed to `main` directly.
- **New entries** follow the existing schema: the id continues the per-language sequence (`art-NNN`, `art-en-NNN`, `art-ja-NNN`), the date is the publisher's local day (Taipei / US Pacific / Tokyo), the summary is the platform's own description cut to one or two sentences (never invented), the category is guessed from the title with the keyword table in the script (default `macro`), `tags` is `[]` and `featured` is `false`. Review the PR and adjust by hand where needed.
- **Run locally**: `node tools/feeds/sync.js --check` prints what would be added without writing; without `--check` it appends to the file. `--no-verify` skips the check that every new URL answers 200, `--since 2026-01-01` ignores older posts, `--source note` limits the platforms.
- **One-time setup**: in Settings → Actions → General → Workflow permissions enable *Allow GitHub Actions to create and approve pull requests*, or add a `SYNC_PR_TOKEN` secret (fine-grained PAT with contents and pull requests write access). Scheduled workflows only run from `main`, so the daily run starts once this workflow file is on `main`; before that, use *Run workflow* in the Actions tab from a branch that has it.
- `tools/` is not published to the site (`_config.yml`).

© 2026 Miyama Capital LLC. All Rights Reserved.
