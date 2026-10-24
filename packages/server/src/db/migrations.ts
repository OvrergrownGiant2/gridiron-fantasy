/**
 * Ordered SQL migrations. Kept as TypeScript strings (not .sql files) so the same
 * migrations run on PostgreSQL in production and on PGlite in the browser demo.
 * Never edit a migration that has shipped; add a new one.
 */
export const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001_init',
    sql: /* sql */ `
-- gen_random_uuid() is built into PostgreSQL 13+; no extension required.

-- ---------------------------------------------------------------- users & auth
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username        text NOT NULL,
  email           text NOT NULL,
  display_name    text NOT NULL,
  password_hash   text NOT NULL,
  avatar_media_id uuid,
  timezone        text,                         -- NULL = use the browser's zone
  theme           text NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark')),
  notification_prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_ci ON users (lower(username));
CREATE UNIQUE INDEX users_email_ci ON users (lower(email));

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,             -- SHA-256 of the bearer token; raw token never stored
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE password_resets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE media (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime          text NOT NULL CHECK (mime IN ('image/png','image/jpeg','image/webp')),
  bytes         bytea NOT NULL,
  byte_size     int NOT NULL CHECK (byte_size > 0 AND byte_size <= 2097152),
  width         int NOT NULL,
  height        int NOT NULL,
  sha256        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD CONSTRAINT users_avatar_fk FOREIGN KEY (avatar_media_id) REFERENCES media(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- NFL reference data
CREATE TABLE nfl_teams (
  id          text PRIMARY KEY,                 -- abbreviation, e.g. KC
  city        text NOT NULL,
  name        text NOT NULL,
  conference  text NOT NULL,
  division    text NOT NULL
);

CREATE TABLE nfl_players (
  id                 text PRIMARY KEY,          -- provider:providerId (stable; never matched by name)
  provider           text NOT NULL,
  provider_player_id text NOT NULL,
  full_name          text NOT NULL,
  position           text NOT NULL CHECK (position IN ('QB','RB','WR','TE','K','DST')),
  nfl_team_id        text REFERENCES nfl_teams(id),
  jersey             int,
  injury_status      text NOT NULL DEFAULT 'healthy',
  injury_note        text,
  active             boolean NOT NULL DEFAULT true,
  rank               int NOT NULL DEFAULT 9999,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_player_id)
);
CREATE INDEX nfl_players_pos ON nfl_players(position);
CREATE INDEX nfl_players_team ON nfl_players(nfl_team_id);
CREATE INDEX nfl_players_name ON nfl_players(lower(full_name));

CREATE TABLE nfl_games (
  id            text PRIMARY KEY,
  season        int NOT NULL,
  season_type   text NOT NULL DEFAULT 'REG',
  week          int NOT NULL,
  home_team_id  text NOT NULL REFERENCES nfl_teams(id),
  away_team_id  text NOT NULL REFERENCES nfl_teams(id),
  kickoff_at    timestamptz NOT NULL,
  status        text NOT NULL CHECK (status IN ('scheduled','in_progress','final','delayed','postponed','canceled')),
  home_score    int,
  away_score    int,
  quarter       text,
  clock         text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX nfl_games_week ON nfl_games(season, season_type, week);

CREATE TABLE player_game_stats (
  player_id   text NOT NULL REFERENCES nfl_players(id),
  game_id     text NOT NULL REFERENCES nfl_games(id),
  season      int NOT NULL,
  week        int NOT NULL,
  stats       jsonb NOT NULL,
  is_final    boolean NOT NULL DEFAULT false,
  hash        text NOT NULL,                    -- content hash: duplicate deliveries are no-ops
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, game_id)
);
CREATE INDEX pgs_week ON player_game_stats(season, week);

CREATE TABLE provider_sync_state (
  key                  text PRIMARY KEY,        -- e.g. 'live', 'players', 'schedule'
  provider             text NOT NULL,
  last_attempt_at      timestamptz,
  last_success_at      timestamptz,
  last_error           text,
  consecutive_failures int NOT NULL DEFAULT 0,
  next_run_at          timestamptz,
  meta                 jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ---------------------------------------------------------------- leagues
CREATE TABLE leagues (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  description   text NOT NULL DEFAULT '',
  visibility    text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  season        int NOT NULL,
  max_teams     int NOT NULL CHECK (max_teams BETWEEN 1 AND 10),
  invite_code   text NOT NULL UNIQUE,
  logo_media_id uuid REFERENCES media(id) ON DELETE SET NULL,
  created_by    uuid NOT NULL REFERENCES users(id),
  status        text NOT NULL DEFAULT 'setup' CHECK (status IN ('setup','drafting','in_season','playoffs','complete')),
  settings      jsonb NOT NULL,
  settings_version int NOT NULL DEFAULT 1,
  scoring_version  int NOT NULL DEFAULT 1,
  current_week  int NOT NULL DEFAULT 1,
  waiver_next_run_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Every settings / scoring change is versioned; finalized results reference the version used.
CREATE TABLE league_settings_versions (
  league_id   uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  version     int NOT NULL,
  settings    jsonb NOT NULL,
  changed_by  uuid REFERENCES users(id),
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (league_id, version)
);
CREATE TABLE scoring_configs (
  league_id   uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  version     int NOT NULL,
  rules       jsonb NOT NULL,
  changed_by  uuid REFERENCES users(id),
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (league_id, version)
);

CREATE TABLE league_members (
  league_id   uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('commissioner','co_commissioner','manager','observer')),
  muted_until timestamptz,
  joined_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (league_id, user_id)              -- a user cannot join the same league twice
);
CREATE INDEX league_members_user ON league_members(user_id);

CREATE TABLE teams (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id       uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  owner_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  is_ai           boolean NOT NULL DEFAULT false,
  ai_difficulty   text CHECK (ai_difficulty IN ('easy','medium','hard')),
  name            text NOT NULL,
  abbrev          text NOT NULL,
  description     text NOT NULL DEFAULT '',
  primary_color   text NOT NULL DEFAULT '#14213D' CHECK (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  secondary_color text NOT NULL DEFAULT '#FCA311' CHECK (secondary_color ~ '^#[0-9A-Fa-f]{6}$'),
  logo_media_id   uuid REFERENCES media(id) ON DELETE SET NULL,
  logo_preset     text,
  banner_media_id uuid REFERENCES media(id) ON DELETE SET NULL,
  waiver_priority int NOT NULL,
  faab_remaining  int NOT NULL DEFAULT 0 CHECK (faab_remaining >= 0),
  draft_slot      int,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (league_id, abbrev),
  CHECK ((is_ai AND owner_user_id IS NULL) OR NOT is_ai)
);
CREATE UNIQUE INDEX teams_one_per_owner ON teams(league_id, owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE INDEX teams_league ON teams(league_id);

-- ---------------------------------------------------------------- rosters
CREATE TABLE roster_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id     uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  team_id       uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id     text NOT NULL REFERENCES nfl_players(id),
  slot          text NOT NULL CHECK (slot IN ('QB','RB','WR','TE','FLEX','SUPERFLEX','K','DST','BN','IR')),
  acquired_via  text NOT NULL,
  acquired_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (league_id, player_id)                 -- THE guard: a player belongs to at most one team per league
);
CREATE INDEX roster_team ON roster_entries(team_id);

CREATE TABLE player_waivers (
  league_id   uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  player_id   text NOT NULL REFERENCES nfl_players(id),
  clears_at   timestamptz NOT NULL,
  PRIMARY KEY (league_id, player_id)
);

-- ---------------------------------------------------------------- drafts
CREATE TABLE drafts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id     uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  type          text NOT NULL CHECK (type IN ('snake','linear','auction','manual')),
  is_mock       boolean NOT NULL DEFAULT false,
  mock_user_id  uuid REFERENCES users(id) ON DELETE CASCADE,
  status        text NOT NULL CHECK (status IN ('scheduled','in_progress','paused','complete')),
  team_order    jsonb NOT NULL,                 -- team ids by draft slot
  rounds        int NOT NULL,
  pick_seconds  int NOT NULL,
  current_pick  int NOT NULL DEFAULT 1,
  pick_deadline timestamptz,
  paused_remaining_ms int,
  auction_budget int,
  auction_state jsonb,
  scheduled_at  timestamptz,
  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX drafts_one_real ON drafts(league_id) WHERE NOT is_mock;

CREATE TABLE draft_picks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id    uuid NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  league_id   uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  overall     int NOT NULL,
  round       int NOT NULL,
  pick_in_round int NOT NULL,
  team_id     uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id   text NOT NULL REFERENCES nfl_players(id),
  price       int,
  is_auto     boolean NOT NULL DEFAULT false,
  made_by     uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draft_id, overall),
  UNIQUE (draft_id, player_id)                  -- a player cannot be drafted twice
);

CREATE TABLE draft_queue (
  draft_id    uuid NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  team_id     uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id   text NOT NULL REFERENCES nfl_players(id),
  position    int NOT NULL,
  PRIMARY KEY (draft_id, team_id, player_id)
);

CREATE TABLE auction_budgets (
  draft_id    uuid NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  team_id     uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  remaining   int NOT NULL CHECK (remaining >= 0),
  PRIMARY KEY (draft_id, team_id)
);

-- ---------------------------------------------------------------- matchups & scoring
CREATE TABLE matchups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id       uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  week            int NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('regular','playoff','consolation','championship')),
  bracket_round   int,
  bracket_slot    int,
  home_team_id    uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  away_team_id    uuid REFERENCES teams(id) ON DELETE CASCADE,   -- NULL = bye / solo challenge
  home_seed       int,
  away_seed       int,
  status          text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','final')),
  home_points     numeric(8,2) NOT NULL DEFAULT 0,
  away_points     numeric(8,2) NOT NULL DEFAULT 0,
  winner_team_id  uuid REFERENCES teams(id),
  scoring_version int,
  finalized_at    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX matchups_league_week ON matchups(league_id, week);

-- Immutable snapshot of each finalized lineup (history survives later roster moves).
CREATE TABLE matchup_lineups (
  matchup_id  uuid NOT NULL REFERENCES matchups(id) ON DELETE CASCADE,
  team_id     uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id   text NOT NULL REFERENCES nfl_players(id),
  slot        text NOT NULL,
  points      numeric(8,2) NOT NULL,
  breakdown   jsonb NOT NULL,
  PRIMARY KEY (matchup_id, team_id, player_id)
);

CREATE TABLE score_corrections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id     uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  matchup_id    uuid NOT NULL REFERENCES matchups(id) ON DELETE CASCADE,
  week          int NOT NULL,
  source        text NOT NULL CHECK (source IN ('provider','scoring_change')),
  old_home      numeric(8,2) NOT NULL,
  old_away      numeric(8,2) NOT NULL,
  new_home      numeric(8,2) NOT NULL,
  new_away      numeric(8,2) NOT NULL,
  status        text NOT NULL CHECK (status IN ('pending','applied','dismissed')),
  decided_by    uuid REFERENCES users(id),
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz
);

-- ---------------------------------------------------------------- transactions & waivers
CREATE TABLE transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id       uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  type            text NOT NULL,
  status          text NOT NULL CHECK (status IN ('completed','failed')),
  team_id         uuid REFERENCES teams(id) ON DELETE SET NULL,
  actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  summary         text NOT NULL,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text UNIQUE,                  -- transactions cannot be processed twice
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tx_league ON transactions(league_id, created_at DESC);

CREATE TABLE waiver_claims (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id       uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  team_id         uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  add_player_id   text NOT NULL REFERENCES nfl_players(id),
  drop_player_id  text REFERENCES nfl_players(id),
  bid             int NOT NULL DEFAULT 0 CHECK (bid >= 0),
  rank            int NOT NULL,
  group_id        text,
  status          text NOT NULL CHECK (status IN ('pending','won','lost','invalid','canceled')),
  result_reason   text,
  processed_at    timestamptz,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX claims_pending ON waiver_claims(league_id, status);
CREATE UNIQUE INDEX claims_no_dupe ON waiver_claims(team_id, add_player_id) WHERE status = 'pending';

-- ---------------------------------------------------------------- trades
CREATE TABLE trades (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id         uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  proposer_team_id  uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  recipient_team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  parent_trade_id   uuid REFERENCES trades(id),
  status            text NOT NULL CHECK (status IN ('proposed','countered','rejected','canceled','expired','in_review','approved','vetoed','executed','failed')),
  message           text NOT NULL DEFAULT '',
  proposer_drops    jsonb NOT NULL DEFAULT '[]'::jsonb,
  recipient_drops   jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_route      text,
  review_reason     text,
  review_ends_at    timestamptz,
  flags             jsonb NOT NULL DEFAULT '[]'::jsonb,
  analysis          jsonb,
  decision_reason   text,
  decided_by        uuid REFERENCES users(id),
  expires_at        timestamptz NOT NULL,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  accepted_at       timestamptz,
  decided_at        timestamptz,
  executed_at       timestamptz,
  signature         text NOT NULL              -- canonical asset list, used for duplicate detection
);
CREATE INDEX trades_league ON trades(league_id, status);

CREATE TABLE trade_assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id      uuid NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  from_team_id  uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  to_team_id    uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  asset_type    text NOT NULL CHECK (asset_type IN ('player','faab','draft_pick')),
  player_id     text REFERENCES nfl_players(id),
  faab_amount   int,
  draft_round   int,
  draft_season  int,
  draft_original_team_id uuid REFERENCES teams(id) ON DELETE CASCADE
);

CREATE TABLE trade_votes (
  trade_id    uuid NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vote        text NOT NULL CHECK (vote IN ('approve','veto')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trade_id, user_id)               -- trade votes cannot be duplicated
);

-- Future draft picks owned by teams (tradable assets).
CREATE TABLE draft_pick_ownership (
  league_id     uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  season        int NOT NULL,
  round         int NOT NULL,
  original_team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  owner_team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  PRIMARY KEY (league_id, season, round, original_team_id)
);

-- ---------------------------------------------------------------- oversight, comms
CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  league_id     uuid REFERENCES leagues(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_kind    text NOT NULL CHECK (actor_kind IN ('user','system','ai')),
  action        text NOT NULL,
  target        text,
  reason        text,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_league ON audit_log(league_id, created_at DESC);

-- The audit log is append-only. Updates and deletes are rejected by the database itself.
CREATE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

CREATE TABLE activity (
  id          bigserial PRIMARY KEY,
  league_id   uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  summary     text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_league ON activity(league_id, id DESC);

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  league_id   uuid REFERENCES leagues(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  link        text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user ON notifications(user_id, created_at DESC);

CREATE TABLE chat_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id   uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  deleted_at  timestamptz,
  deleted_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_league ON chat_messages(league_id, created_at DESC);

CREATE TABLE app_kv (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);
`,
  },
];
