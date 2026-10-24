# Auto-updating website (GitHub Pages)

The repository builds and publishes Gridiron Fantasy as a website by itself, with
`.github/workflows/publish.yml`:

- **Every 3 hours** (and on every push) it downloads the latest real NFL data from nflverse,
  rebuilds the app, and publishes it at `https://<your-username>.github.io/<repo-name>/`.
- It saves each new data snapshot to `packages/web/public-demo/nfl-snapshot.json`.
- **Run it now:** Actions tab → *Publish app* → *Run workflow*.

Leagues you create on the website are stored in your browser (per season), so they survive
every data update. Press **Refresh league** to load newer data without reloading the page.
They are not shared between devices or people — for shared leagues with friends and truly
live in-game scores, run the server version (see README.md).

nflverse posts stats after games finish (usually within a few hours, often by the next morning),
so this is "after the game" freshness, not live play-by-play.

## If something goes wrong

| What you see | Fix |
|---|---|
| Red ❌ run with "GitHub Pages is not switched on" | Settings → Pages → Source: **GitHub Actions**, then Actions → *Publish app* → *Re-run all jobs*. |
| Pages settings say Pages isn't available | Pages on free accounts needs a **public** repository (Settings → General → Change visibility). |
| "Permission denied to github-actions[bot]" | Settings → Actions → General → Workflow permissions → **Read and write permissions** → Save, then re-run. |
| Schedule stopped running | GitHub pauses schedules after 60 days with no commits (e.g. off-season). Actions → *Publish app* → *Enable workflow*. |
| Data shows an old date | nflverse hasn't published newer stats yet, or the download failed — the run keeps the last snapshot and says so in its log. |

## Running the steps yourself

```bash
npm ci
npm run refresh:data     # download nflverse → packages/web/public-demo/nfl-snapshot.json
npm run build:demo       # → packages/web/dist-demo (the website)
npm run build:artifact   # → artifact-build/ (variant for hosts that serve only common web file types)
```
Set `NFL_SEASON` to pick a season; by default it's the current one (September–February).
