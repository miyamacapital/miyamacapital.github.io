# Miyama Capital Official Website

This repository contains the source code for the official landing page of **Miyama Capital**.
It is a static website designed for a boutique global macro and quantitative investment practice.

## 🔗 Live Site
[https://www.miyamacap.com](https://www.miyamacap.com)

## 📂 Project Structure
The project uses a **folder-based structure** for SEO-friendly multi-language support:

- `index.html` (Root): Automatically detects user language and redirects.
- `/en/index.html`: English version content.
- `/zh/index.html`: Traditional Chinese version content.
- `/web_images/`: Stores all static assets (Logos, icons, founder photos).

## 🛠 Technology
- **HTML5**: Semantic structure.
- **Tailwind CSS**: Styled via CDN for rapid development and clean UI.
- **JavaScript**: Minimal vanilla JS for language detection and redirection.
- **SVG Icons**: Lightweight, scalable vector icons used for UI elements.

## 📝 How to Update
1. **To change text**: Edit `index.html` inside the `/en/` or `/zh/` folders respectively.
2. **To update images**: Upload new files to `/web_images/` and update the `src` path in the HTML files.

## 🔄 Research catalog sync
`data/articles.json` feeds the research archive pages and the homepage "latest research" cards. It is kept current by `tools/feeds/sync.js` and the workflow `.github/workflows/sync-research.yml`:

- **What runs**: once a day and on manual dispatch, the workflow reads the vocus salon content list (zh-TW), the Substack RSS feed (en) and the note RSS feed (ja), appends every post whose URL is not yet in the catalog, and opens or updates one pull request titled **Sync research catalog** against `redesign/c-lab` (the `base` input changes the branch). Existing entries are never modified and nothing is pushed to `main` directly.
- **New entries** follow the existing schema: the id continues the per-language sequence (`art-NNN`, `art-en-NNN`, `art-ja-NNN`), the date is the publisher's local day (Taipei / US Pacific / Tokyo), the summary is the platform's own description cut to one or two sentences (never invented), the category is guessed from the title with the keyword table in the script (default `macro`), `tags` is `[]` and `featured` is `false`. Review the PR and adjust by hand where needed.
- **Run locally**: `node tools/feeds/sync.js --check` prints what would be added without writing; without `--check` it appends to the file. `--no-verify` skips the check that every new URL answers 200, `--since 2026-01-01` ignores older posts, `--source note` limits the platforms.
- **One-time setup**: in Settings → Actions → General → Workflow permissions enable *Allow GitHub Actions to create and approve pull requests*, or add a `SYNC_PR_TOKEN` secret (fine-grained PAT with contents and pull requests write access). Scheduled workflows only run from `main`, so the daily run starts once this workflow file is on `main`; before that, use *Run workflow* in the Actions tab from a branch that has it.
- `tools/` is not published to the site (`_config.yml`).

## © Copyright
© 2025 Miyama Capital. All Rights Reserved.
