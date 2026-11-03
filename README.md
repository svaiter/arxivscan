# arXivScan

A static daily scanner of arXiv's "new submissions" listings, served by GitHub Pages and
fed by a GitHub Actions workflow. Nobody's browser ever talks to arXiv: the workflow fetches
the listing of **every arXiv category** once a day, stores one JSON file per category, and
the web page merges whichever categories you pick, client-side.

Live site: `https://<owner>.github.io/arxivscan/` (for this repository: https://svaiter.github.io/arxivscan/).

## How it works

```
GitHub Actions (cron, Mon-Fri)                GitHub Pages (gh-pages branch)
┌──────────────────────────────┐              ┌──────────────────────────────┐
│ scripts/fetch_feeds.py       │   git push   │ index.html, app.js, style.css│
│  rss.arxiv.org/rss/<cat>     │ ───────────▶ │ categories.json              │
│  for all 155 categories      │              │ data/index.json              │
│  -> data/<cat>.json          │              │ data/cs.LG.json, ...         │
└──────────────────────────────┘              └──────────────────────────────┘
                                                        │ fetch data/<cat>.json
                                                        ▼
                                              browser: merge + dedupe + render
```

* **One file per category, never per combination.** Selecting `cs.AI + cs.LG` downloads
  `data/cs.AI.json` and `data/cs.LG.json` and merges them in the browser, deduplicating papers
  that appear in both. No `cs.AI+cs.LG.json` is ever created.
* **Source:** the official RSS feeds (`https://rss.arxiv.org/rss/<category>`), which contain exactly
  the daily announcement (same content as the mailing). Entries announced as `new` (primary
  category) and `cross` (cross-listed) are kept; replacements are dropped. The page shows
  primary submissions by default; tick "Include cross-lists" (or press `x`) to add cross-lists.
* **No dependencies.** The scripts use only the Python standard library. The workflow uses only
  `actions/checkout`; everything else is plain `git` and `python3` as preinstalled on the runner.
* **Robust to failures.** Each feed is retried with backoff. If a feed fails, or comes back empty
  (weekends, holidays, outages), the previously published JSON for that category is kept and
  flagged as stale; the site shows a notice listing the affected categories. The whole site is
  published even if some categories failed, and the run is marked failed only when a category has
  no data at all.
* **Pages, presets, URLs.** The selection lives in the URL (`?cat=stat.ML+cs.LG+cs.AI&cross=1`), so
  it can be bookmarked. Presets ("ML & AI", "math.OC", ...) can be extended from the category picker
  ("Save preset"); custom presets are stored in your browser's `localStorage`.
* **Interface:** keyword filter, collapsible abstracts with lazy KaTeX rendering, Markdown citation
  copy, light/dark theme, Vim-style keys (`j`/`k`, `Enter`, `y`, `g a`/`g p`/`g h`, `/`, `c`, `x`, `?`).

## Repository layout

| Path | Role |
|---|---|
| `.github/workflows/update.yml` | The workflow: fetch all feeds, assemble the site, publish to `gh-pages`. |
| `scripts/fetch_feeds.py` | Fetches the RSS feeds and writes `data/<cat>.json` + `data/index.json`. |
| `scripts/build_taxonomy.py` | Regenerates `site/categories.json` from https://arxiv.org/category_taxonomy. |
| `site/` | The static front-end (`index.html`, `app.js`, `style.css`, `categories.json`). |

The `gh-pages` branch is entirely generated. It always holds a single commit (it is force-pushed
on every run), so the repository does not grow with one copy of the data per day. Do not edit it
by hand: change `site/` on `main` instead.

## One-time setup

1. **Run the workflow once** so that the `gh-pages` branch exists: *Actions* tab → *Update arXiv
   listings* → *Run workflow* → *Run workflow*. (It also runs automatically on every push to `main`
   that touches `site/`, `scripts/` or the workflow file.)
2. **Enable GitHub Pages on that branch:** *Settings* → *Pages* → *Build and deployment* →
   *Source: Deploy from a branch* → *Branch: `gh-pages`*, folder `/ (root)` → *Save*.
   GitHub then runs its own `pages build and deployment` job after every push to `gh-pages`.
3. Open `https://<owner>.github.io/arxivscan/`. The first Pages build can take a couple of minutes.

That is all. `GITHUB_TOKEN` is enough for the push: the workflow asks for `contents: write` and
no secret has to be created.

## Schedule

arXiv announces new papers Sunday to Thursday around 20:00 US Eastern time, and rebuilds its RSS
feeds a few hours later (observed around 09:00 UTC). The workflow runs Monday to Friday at
01:15, 10:15 and 14:15 UTC: an early attempt, the main one, and a catch-up. Running more often is
harmless (the feeds are cheap, a full run takes about three minutes) but the listing only changes
once a day. Edit the `cron` lines in `.github/workflows/update.yml` to change this; GitHub may delay
scheduled runs by some minutes at busy times.

## Re-running / troubleshooting

The header badge on the site says when the data was last updated. It turns orange when some
selected categories are stale or when the last successful run is more than 36 hours old; a notice
under the header lists the affected categories with the error message, and links to the run log.
GitHub also e-mails the repository owner when a scheduled workflow fails.

**To re-run the fetch by hand** (after a failure, an arXiv outage, or just to refresh):

1. Go to the repository's *Actions* tab, select *Update arXiv listings* in the left column.
2. Click *Run workflow* (right side), leave *only* empty to fetch every category, or write a
   comma-separated list such as `cs.LG,math.OC` to refresh just those (the other categories keep
   their current data), then *Run workflow*.
3. Wait for the run to finish (about 3 minutes) and for the `pages build and deployment` workflow
   that follows it (about a minute). Reload the site: Pages caches files for 10 minutes, so a hard
   reload may be needed.

Alternatively, open a failed run and click *Re-run all jobs*, or from a clone:

```bash
gh workflow run "Update arXiv listings"
```

**Reading a run.** Each run writes a summary table (fresh / stale / failed categories, with the
error for each problem) at the top of the run page. The step *Fetch arXiv feeds* prints one line
per category.

**What "stale" and "failed" mean.**

* *stale*: today's feed could not be fetched (or was empty), so the previous day's listing for that
  category was kept. The site shows it with a notice. This is normal on weekends and holidays and
  for very quiet categories.
* *failed*: no data at all for that category (fetch failed and nothing was published before). The
  run is marked as failed so that you are notified; the rest of the site is published anyway.
  Re-run the workflow later.

**If scheduled runs stop.** GitHub disables scheduled workflows in repositories that had no activity
for 60 days and e-mails the owner. The daily push to `gh-pages` counts as activity, so this should
not happen while the workflow runs; if it ever does, open the *Actions* tab, select the workflow and
click *Enable workflow*.

**If the site shows "No data published yet".** Either the workflow never ran (see *One-time setup*),
or Pages is not configured to serve the `gh-pages` branch, or the Pages build is still running.
Check *Settings* → *Pages* and the *Actions* tab.

**If arXiv adds or renames categories.** Regenerate the taxonomy and commit it:

```bash
python3 scripts/build_taxonomy.py
```

## Running locally

Fetch a few categories into a build directory, copy the site next to the data and serve it:

```bash
python3 scripts/fetch_feeds.py --out build/data --only cs.LG,math.OC,stat.ML
```

```bash
cp -r site/. build/ && python3 -m http.server 8000 --directory build
```

Then open http://localhost:8000/?cat=cs.LG+stat.ML. Pass `--previous <dir>` to test the fallback
logic against a previously generated `data/` directory.

## Data format

`data/<category>.json`:

```json
{
  "format": 1, "category": "cs.LG", "name": "Machine Learning",
  "announced": "2026-11-03", "fetched_at": "2026-11-03T10:17:02Z",
  "stale": false, "count_new": 334, "count_cross": 236,
  "papers": [
    {"id": "2611.00015", "v": 1, "title": "...", "authors": ["..."], "abstract": "...",
     "cats": ["cs.LG", "cs.AI"], "type": "new"}
  ]
}
```

`cats[0]` is the primary category; `type` is `new` (primary category is this one) or `cross`.
`data/index.json` lists every category with its announcement date, counts and status, plus the
URL of the run that produced it.
