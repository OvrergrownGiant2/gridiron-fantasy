# Gridiron Fantasy

> **Website that updates itself:** this repository publishes the app on GitHub Pages and refreshes
> the real NFL data every 3 hours with GitHub Actions. See [AUTOMATION.md](AUTOMATION.md).
>
> **Playing with friends on their own devices?** Put the online version up for free (Render + Neon):
> see [ONLINE-SETUP.md](ONLINE-SETUP.md).

A browser-based NFL fantasy football platform for leagues of 1–10 human managers, with any number of independent leagues per account, AI managers, a rule-based **Digital Commissioner**, live scoring from a pluggable NFL data provider, and a polished responsive UI.

> **Data honesty.** The app never invents NFL data. Providers:
> - `nflverse` — **real** players, schedules, scores, weekly stats and injury reports from open nflverse data (updated after games), optionally with the **Sleeper** overlay for fresher injuries and provisional in-game stats.
> - `snapshot` — a frozen nflverse snapshot (used by the offline HTML app), labeled with its capture date.
> - `sportsdataio` — licensed commercial feed with live in-game data (paid key).
> - `demo` — a clearly labeled simulated season with fictional players.
> - `none` — every score surface says **DATA UNAVAILABLE**.

---

## Contents

1. [Quick start](#quick-start)
2. [Project structure](#project-structure)
3. [Configuration](#configuration)
4. [NFL data provider](#nfl-data-provider)
5. [Database: migrations and seeding](#database)
6. [Running tests](#running-tests)
7. [Production deployment](#production-deployment)
8. [Implemented features](#implemented-features)
9. [Integrations that need credentials](#integrations-that-need-credentials)
10. [Known limitations and roadmap](#known-limitations-and-roadmap)
11. [Acceptance criteria → tests](#acceptance-criteria--tests)

---

## Quick start

Requirements: Node.js 22+, PostgreSQL 13+ (16 recommended). Python 3 + Playwright only for the optional browser smoke test.

```bash
npm install
cp .env.example .env                 # defaults: local Postgres, demo data provider
createdb gridiron && createdb gridiron_test   # or use docker compose (below)
npm run db:migrate                   # applies SQL migrations
npm run db:seed                      # simulated season + demo accounts (demo provider only)
npm run build                        # builds the web app into packages/web/dist
npm start                            # API + jobs + web on http://localhost:8787
```

Sign in with **demo / demo1234** or **alex / alex1234**.

For development with hot reload run `npm run dev -w @gridiron/server` and `npm run dev -w @gridiron/web` (Vite on :5173 proxies `/api` and `/media` to :8787).

### Offline HTML app

`npm run build:artifact` produces a self-contained build in `artifact-build/` that runs the **same server services** in the browser on PGlite (PostgreSQL compiled to WebAssembly), persisted to IndexedDB. If `packages/web/public-demo/nfl-snapshot.json` exists it uses that **real nflverse snapshot** (refresh it with the snapshot script); otherwise it falls back to the simulated demo season with a time-travel control. A browser page cannot reach outside APIs from a sandboxed host, so the offline app does not update live; the server version does. A daily scheduled refresh can rebuild and republish it — see [AUTOMATION.md](AUTOMATION.md).

---

## Project structure

```
packages/
  core/      Pure TypeScript domain logic, no I/O: scoring engine, roster rules, lineup optimizer,
             draft order & auto-pick, waiver resolution, trade validation/analysis/review routing,
             schedules & playoff brackets, standings & tie-breakers, projections, permissions,
             color contrast, AI manager decisions, league-settings validation (zod).
  server/    Services over a small database port (PostgreSQL via `pg`, or PGlite):
             src/db/            migrations (SQL), drivers
             src/providers/     provider port + SportsDataIO adapter + labeled demo provider
             src/services/      auth, leagues/teams, rosters, players, drafts, waivers, trades,
                                scoring & matchups, nfl sync, social (chat, notifications, media),
                                views (dashboard, commissioner), assistant, jobs, seed
             src/api/router.ts  RPC-style API (POST /api/<method>), transport-independent
             src/http.ts        Express adapter: cookies, CSRF, rate limits, SSE, media, static web
  web/       React 18 + TypeScript + Vite + Tailwind. Two transports: HTTP (production) and an
             in-browser demo transport that runs packages/server on PGlite.
e2e/         Playwright smoke test (desktop + mobile, light + dark)
```

Business logic lives in `core` (pure, unit-tested) and `server/services` (transactional, integration-tested). UI components never compute authoritative results; scores come from the server's scoring engine.

---

## Configuration

All configuration is environment variables; see [`.env.example`](.env.example). Secrets are read only by the server. The browser never receives provider keys, AI keys or database credentials.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `NFL_PROVIDER` | `sportsdataio`, `demo` or `none` (production default: `none`) |
| `SPORTSDATAIO_API_KEY` | SportsDataIO key (sent as `Ocp-Apim-Subscription-Key`) |
| `SPORTSDATAIO_LIVE_POLL_SECONDS` | Live polling interval (min 15s, default 60s) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Optional AI assistant |
| `RESEND_API_KEY`, `MAIL_FROM` | Password-reset email delivery |
| `JOBS_ENABLED` | Run background jobs in this process (exactly one instance should) |
| `PUBLIC_URL`, `TRUST_PROXY`, `SESSION_DAYS`, `PORT` | Deployment settings |

---

## NFL data provider

`packages/server/src/providers/provider.ts` defines the port. Adapters translate vendor payloads into normalized types (`NflGame`, `NflPlayer`, `PlayerGameStat`); the scoring engine only sees normalized stat keys, so swapping providers never touches scoring.

**nflverse** (`providers/nflverse.ts`, recommended free option) downloads `players.csv`, `games.csv`, `stats_player_week_<season>.csv`, `stats_team_week_<season>.csv`, `injuries_<season>.csv` and last season's player stats (for draft ranks without hindsight) from the [nflverse-data releases](https://github.com/nflverse/nflverse-data/releases). Players are keyed by NFL GSIS id; team defenses are built from team stats plus final scores. The test suite checks that our PPR scoring reproduces nflverse's own `fantasy_points_ppr` on 200+ real 2026 stat lines. nflverse is not an in-game feed.

**Sleeper overlay** (`providers/sleeper.ts`, on by default with `NFL_PROVIDER=nflverse`; disable with `SLEEPER_LIVE=false`) uses Sleeper's public, read-only, **unofficial** endpoints (`/v1/players/nfl`, `/v1/stats/nfl/regular/<season>/<week>`) for injury designations and provisional stats while games are in progress, joined on GSIS id. If Sleeper is unreachable the nflverse data is used unchanged. Review Sleeper's terms before commercial use.

**Snapshot** (`NFL_PROVIDER=snapshot`, `NFL_SNAPSHOT=path/to/nfl-snapshot.json`): build one with `npx tsx packages/server/scripts/build-nflverse-snapshot.ts 2026 nfl-snapshot.json`. Snapshots replay the season against the clock (future results are never revealed early), so `npm run db:seed` works with them too.

**SportsDataIO** (`providers/sportsdataio.ts`) uses the v3 NFL endpoints: `scores/json/CurrentSeason`, `CurrentWeek`, `Teams`, `PlayersByAvailable`, `Schedules/{season}`, `ScoresByWeek/{season}/{week}`, `stats/json/PlayerGameStatsByWeek/{season}/{week}` and `FantasyDefenseByGame/{season}/{week}`.

Before production use, verify against your own subscription:
- Free trials return **scrambled** data, and SportsDataIO's NFL coverage and live (in-game) latency depend on the plan. Commercial licensing must be confirmed with the vendor.
- Field names in the mapper are fixture-tested (`server/test/providers.test.ts`) against the documented v3 schema but were not exercised against a live key here.
- Sportradar or another authorized provider can be added by implementing the same six methods.

**Sync pipeline** (`services/nfl.ts`): reference data refreshes every 15 minutes; the current and previous week's games and stats are polled at the provider's live interval during game windows and every 15 minutes otherwise. Every stat line is content-hashed, so duplicate deliveries are no-ops and provider corrections are detected. Failures back off exponentially (capped at 30 min, honoring `Retry-After`), and the UI shows LIVE / UPCOMING / FINAL / DELAYED / POSTPONED / DATA UNAVAILABLE with last-updated times and stale-data banners.

**Time zones.** All timestamps are stored as `timestamptz` (UTC). The UI renders in the user's chosen zone (default: browser zone) with `Intl`, so daylight-saving changes are handled by the platform. The demo schedule converts Eastern kickoffs to UTC with explicit DST rules (tested).

---

## Database

Schema: `packages/server/src/db/migrations.ts` (plain SQL, kept as TypeScript strings so the same migrations run on PostgreSQL and PGlite). Highlights:

- `league_members (league_id, user_id)` primary key — a user cannot join a league twice.
- `roster_entries UNIQUE (league_id, player_id)` — a player can be on at most one team per league; this constraint is the final guard against races.
- `draft_picks UNIQUE (draft_id, player_id)` and `UNIQUE (draft_id, overall)` — no double drafting.
- `transactions.idempotency_key UNIQUE` — client request IDs make adds/drops safe to retry.
- `trade_votes (trade_id, user_id)` primary key — one vote per manager.
- `audit_log` has a trigger that rejects every UPDATE and DELETE (append-only).
- Versioned `scoring_configs` and `league_settings_versions`; finalized matchups record the scoring version used and keep an immutable lineup snapshot (`matchup_lineups`).

Commands: `npm run db:migrate` (idempotent) and `npm run db:seed` (demo provider only; simulates the season up to the current date through the real pipeline: sync → scoring → finalization → waivers → AI lineups).

---

## Running tests

```bash
npm test               # core unit tests + server integration tests against PostgreSQL (TEST_DATABASE_URL)
npm run test:pglite    # the same integration suite on PGlite (validates the in-browser demo path)
npm run typecheck
npm start & npm run test:e2e   # headless Chromium smoke test, desktop + mobile, saves screenshots
```

Current results (run during development): **48 core unit tests, 41 server tests** (23 integration, 6 SportsDataIO/demo provider, 7 nflverse/Sleeper on real 2026 fixtures, 5 HTTP security) — all passing on PostgreSQL 16 and on PGlite. The e2e smoke test signs in and loads all 13 main pages at 1366×900 (light) and 390×844 (dark) with no horizontal overflow and no application errors.

---

## Production deployment

```bash
docker compose up --build        # PostgreSQL 16 + app on :8787 (NFL_PROVIDER defaults to none)
```

Or build the `Dockerfile` image and run it with `DATABASE_URL`, `PUBLIC_URL`, `NODE_ENV=production`, `TRUST_PROXY=true` behind TLS, and your provider key. Run one instance with `JOBS_ENABLED=true` and any additional API instances with `JOBS_ENABLED=false`. Note that realtime events (SSE) are delivered in-process; with multiple API instances, add a shared bus (e.g. PostgreSQL `LISTEN/NOTIFY` or Redis) — clients also poll as a fallback.

Security in place: scrypt password hashing; random 256-bit session tokens stored only as SHA-256 hashes; httpOnly + SameSite=Lax (+Secure in production) cookies; CSRF defense via a required custom header and origin check; per-IP rate limits; zod input validation everywhere; server-side authorization from database roles on every call (never from client-supplied roles or IDs); league-scoped access (non-members get 404); magic-byte image validation, size and dimension limits, client re-encoding, `nosniff` + sandboxed CSP on media; CSP, HSTS, frame denial; generic error messages in production.

---

## Implemented features

- **Accounts:** register, login, logout, persistent rolling sessions, profile (display name, photo, time zone, theme), notification preferences, password change, account recovery that does not reveal whether an email exists.
- **Leagues:** creation wizard (basics, roster, scoring, season, waivers & trades, draft, review) with cross-field validation; 1–10 teams; AI managers (easy/medium/hard) that act only through the same validated services; public or private visibility; invite codes and links; joining takes over an AI seat when full; leave (team becomes AI-managed); multiple independent leagues with an always-visible league switcher.
- **Roster rules:** QB/RB/WR/TE/FLEX/SUPERFLEX/K/DST/BN/IR, configurable FLEX eligibility, IR eligibility and per-position limits.
- **Scoring engine:** standard, half-PPR, PPR and fully custom per-stat values, points-allowed and yards-allowed tiers, bonuses and penalties (≥ / ≤ thresholds), decimal and negative scoring, hundredth-exact totals, per-line breakdowns, per-league computation, provisional vs final, deduplication, provider-correction reconciliation (auto or commissioner review), versioned rules and explicit audited recalculation.
- **Team identity:** name, abbreviation, description, two colors via color picker with HEX/RGB, presets, contrast check, reset, live preview; logo upload with crop/zoom, 12 original emblems, default monogram; optional banner.
- **Draft:** snake, linear, auction (budgets, nominations, anti-snipe bidding, AI bidders), commissioner-entry; configurable order and timer; auto-pick on timeout (queue first); queue; position/team filters and search; draft board; pause/resume; audited undo; mock drafts; auto-draft-all for leagues starting mid-season.
- **Lineups:** drag-and-drop plus accessible Move menus, eligibility, capacity and lock enforcement, optional optimizer with explanations that is never applied without confirmation.
- **Player explorer:** search, filters (position, NFL team, availability, injured, bye), sortable league-specific points and projections (labeled estimates), rostered %, profiles with game logs, scoring breakdowns, sparkline and upcoming schedule.
- **Waivers & free agents:** FAAB, rolling and reverse-standings priority, waiver periods and weekly processing, continuous waivers, conditional claim groups, reordering, bid edits, cancellation, explained results, atomic free-agent adds with idempotency.
- **Trades & Digital Commissioner:** multi-player, FAAB and future-pick assets; counteroffers, rejection, cancellation, expiry; review modes auto / commissioner / league vote / hybrid; validation of ownership, deadline, locks, duplicates and roster room; advisory or required analysis (value, weekly and horizon points, injuries, byes, team needs); integrity flags that explicitly do not claim to prove collusion; self-review safeguards; voting with eligibility, thresholds, privacy settings and early finalization; commissioner dashboard (alerts, pending reviews, corrections, disputes, violations, deadlines, announcements, recent actions); roles (commissioner, co-commissioner, manager, observer) with a central permission table; immutable audit log.
- **Matchups & standings:** head-to-head or total points, double headers, byes, solo points challenge, playoffs with seeding and byes, championship and consolation brackets, live player-by-player scoring with game state, projected finals, win-probability estimate, tie-breakers, streaks, clinch/elimination status.
- **Social:** activity feed, league chat with mentions, moderation (delete, mute) and flood control; notifications for trades, counters, decisions, votes, waivers, draft turns, injuries, lineup locks, results and announcements; realtime updates via Server-Sent Events.
- **AI:** optional Claude-backed assistant grounded in league data, with rule-based insights (each labeled verified / projection / recommendation / missing) when no key is configured.

## Integrations that need credentials

| Integration | Without credentials | To enable |
|---|---|---|
| Real NFL data, free (nflverse + Sleeper) | — | `NFL_PROVIDER=nflverse` (no key; needs outbound access to GitHub and api.sleeper.app) |
| Real NFL data, licensed live feed (SportsDataIO) | `none`: DATA UNAVAILABLE; `demo`: labeled simulation | `NFL_PROVIDER=sportsdataio`, `SPORTSDATAIO_API_KEY` |
| AI assistant | Rule-based insights; ask box disabled | `ANTHROPIC_API_KEY` |
| Password-reset email | Dev/demo shows the link on screen; production cannot send | `RESEND_API_KEY`, `MAIL_FROM` |
| Player headshots | Not shown (licensing) | Requires a licensed image source |

## Known limitations and roadmap

- SportsDataIO mapping is fixture-tested but has not been run against a live key in this environment; verify endpoints and fields for your plan. Projections are an in-house transparent model, not provider projections; a provider projections adapter is a natural next step.
- Realtime fan-out is in-process; multi-instance deployments need a shared bus (roadmap: Postgres `LISTEN/NOTIFY`).
- Email uses Resend only; add SMTP if needed. No social login or 2FA yet.
- Draft picks can be traded as future assets, but keeper/dynasty drafts that consume them are not implemented yet.
- Media is stored in PostgreSQL (`bytea`, ≤ 2 MB); move to object storage (S3/Supabase Storage) at scale.
- The in-browser demo keeps all data in one browser and needs WebAssembly + IndexedDB.
- Roadmap: provider projections and injury news feeds, push notifications, keeper/dynasty leagues, trade-block and player notes, Postgres row-level security if moving to Supabase.

---

## Acceptance criteria → tests

| # | Criterion | Where verified |
|---|---|---|
| 1 | Register, log in, maintain profile | `integration.test.ts` › accounts; `http.test.ts` (cookie, no hash leak) |
| 2 | Multiple independent leagues | integration › creates multiple independent leagues |
| 3 | 1–10 human managers | integration (solo + 10-team leagues); settings validation tests |
| 4 | Solo league with AI opponents | integration (AI teams, AI trade responses, AI waiver claims) |
| 5 | Join private league by invitation | integration (invite code, duplicate join rejected) |
| 6 | Independent settings and rosters | integration (per-league rosters/settings; same player in two leagues) |
| 7 | Team name, two colors, image | integration › team customization |
| 8 | Customization persists after reload | integration (re-read from DB); demo build reload test |
| 9 | Commissioner configures scoring & rosters | integration › commissioner configuration |
| 10 | Draft pick updates roster & pool | integration › draft pick |
| 11 | Duplicate acquisition prevented | integration (draft duplicate, FA race, DB constraint) |
| 12 | Scoring matches configured rules | core › scoring engine; integration (sum of breakdown = total) |
| 13 | Matchups & standings update | integration › live → final → standings; core › standings |
| 14 | Live vs final distinguished | integration (provisional stats, live matchup status) |
| 15 | Propose / accept / reject / counter | integration › trades |
| 16 | Review follows configured policy | core › review routing; integration (commissioner, vote, auto) |
| 17 | Votes cannot be duplicated | integration › league vote |
| 18 | Waiver priority rules | core › waivers; integration › FAAB |
| 19 | Simultaneous requests can't double-roster | integration › simultaneous free-agent adds |
| 20 | Unauthorized commissioner actions blocked | integration (managers/observers rejected) |
| 21 | Notifications & activity persist | integration › notifications |
| 22 | Honest provider-failure messages | integration › unconfigured/failing providers; providers.test.ts |
| 23 | Core works without AI | integration › rule-based assistant fallback |
| 24 | Desktop and mobile | `e2e/smoke.py` (1366×900 light, 390×844 dark) |
| 25 | Reproducible migrations & setup | `npm run db:migrate` / `db:seed`; tests rebuild the schema each run |
