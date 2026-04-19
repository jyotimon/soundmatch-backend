-- SoundMatch Database Schema — PostgreSQL 16+
-- Run with: npx ts-node src/db/migrate.ts

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spotify_id        TEXT UNIQUE NOT NULL,
  display_name      TEXT NOT NULL,
  email             TEXT UNIQUE NOT NULL,
  avatar_url        TEXT,
  country           CHAR(2),
  product           TEXT,
  access_token_enc  TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  token_expires_at  TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_spotify_id ON users(spotify_id);

-- ─── Music Profiles ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS music_profiles (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  top_artists_short   JSONB NOT NULL DEFAULT '[]',
  top_artists_medium  JSONB NOT NULL DEFAULT '[]',
  top_artists_long    JSONB NOT NULL DEFAULT '[]',
  top_tracks_short    JSONB NOT NULL DEFAULT '[]',
  top_tracks_medium   JSONB NOT NULL DEFAULT '[]',
  top_tracks_long     JSONB NOT NULL DEFAULT '[]',
  top_genres          JSONB NOT NULL DEFAULT '[]',
  recently_played     JSONB NOT NULL DEFAULT '[]',
  audio_features_avg  JSONB NOT NULL DEFAULT '{}',
  listening_hours     INTEGER[] NOT NULL DEFAULT ARRAY_FILL(0, ARRAY[24]),
  personality_type    TEXT NOT NULL DEFAULT 'Unknown',
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_music_profiles_user_id ON music_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_music_profiles_genres  ON music_profiles USING gin(top_genres);

-- ─── Compatibility Scores ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compatibility_scores (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total_score     NUMERIC(5,2) NOT NULL CHECK (total_score BETWEEN 0 AND 100),
  genre_score     NUMERIC(5,2) NOT NULL DEFAULT 0,
  artist_score    NUMERIC(5,2) NOT NULL DEFAULT 0,
  mood_score      NUMERIC(5,2) NOT NULL DEFAULT 0,
  pattern_score   NUMERIC(5,2) NOT NULL DEFAULT 0,
  shared_artists  TEXT[] NOT NULL DEFAULT '{}',
  shared_genres   TEXT[] NOT NULL DEFAULT '{}',
  calculated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT compat_unique_pair  UNIQUE  (user_a_id, user_b_id),
  CONSTRAINT compat_ordered_pair CHECK   (user_a_id < user_b_id),
  CONSTRAINT compat_no_self      CHECK   (user_a_id != user_b_id)
);
CREATE INDEX IF NOT EXISTS idx_compat_user_a ON compatibility_scores(user_a_id);
CREATE INDEX IF NOT EXISTS idx_compat_user_b ON compatibility_scores(user_b_id);
CREATE INDEX IF NOT EXISTS idx_compat_score  ON compatibility_scores(total_score DESC);

-- ─── Matches ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS matches (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  compatibility_score NUMERIC(5,2) NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','matched','declined','unmatched')),
  shared_playlist_id  TEXT,
  matched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT matches_unique_pair UNIQUE (user_a_id, user_b_id),
  CONSTRAINT matches_no_self     CHECK  (user_a_id != user_b_id)
);
CREATE INDEX IF NOT EXISTS idx_matches_user_a ON matches(user_a_id);
CREATE INDEX IF NOT EXISTS idx_matches_user_b ON matches(user_b_id);

-- ─── Communities ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS communities (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT UNIQUE NOT NULL,
  genre_tag    TEXT NOT NULL,
  description  TEXT,
  member_count INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS community_members (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id)       ON DELETE CASCADE,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT community_members_unique UNIQUE (community_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_cm_community ON community_members(community_id);
CREATE INDEX IF NOT EXISTS idx_cm_user      ON community_members(user_id);

-- ─── Auto-update updated_at ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at_users') THEN
    CREATE TRIGGER set_updated_at_users
      BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at_music_profiles') THEN
    CREATE TRIGGER set_updated_at_music_profiles
      BEFORE UPDATE ON music_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- ─── Seed default communities ─────────────────────────────────────────────────
INSERT INTO communities (name, genre_tag, description) VALUES
  ('Indie & Alternative',   'indie',      'For the guitar-and-feelings crowd'),
  ('Electronic & Ambient',  'electronic', 'Late nights and synthesizers'),
  ('Hip-Hop & R&B',         'hip-hop',    'Beats, bars, and culture'),
  ('Jazz & Soul',           'jazz',       'Timeless music, new ears'),
  ('Pop & Dance',           'pop',        'Guilty pleasures, no guilt'),
  ('Metal & Rock',          'metal',      'Loud and proud'),
  ('Classical & Cinematic', 'classical',  'For the epicly dramatic')
ON CONFLICT (name) DO NOTHING;
