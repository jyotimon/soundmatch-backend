/**
 * profile.service.ts
 *
 * Transforms raw Spotify API data into a music profile and persists it.
 * Uses the pg pool (not the Supabase JS SDK) for consistency with the rest
 * of the backend.
 *
 * FIXES:
 *   - Added upsertMusicProfile() — was completely absent, causing all syncs to silently
 *     discard data after fetching it from Spotify
 *   - getMusicProfile() now uses the pg pool (works with both Supabase + local Postgres)
 */

import { query, queryOne } from '../db/client';
import type {
  SpotifyArtist,
  SpotifyTrack,
  SpotifyAudioFeatures,
  SpotifyRecentlyPlayedItem,
} from '../types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RawSpotifyData {
  topArtistsShort:  SpotifyArtist[];
  topArtistsMedium: SpotifyArtist[];
  topArtistsLong:   SpotifyArtist[];
  topTracksShort:   SpotifyTrack[];
  topTracksMedium:  SpotifyTrack[];
  topTracksLong:    SpotifyTrack[];
  recentlyPlayed:   SpotifyRecentlyPlayedItem[];
  audioFeatures:    SpotifyAudioFeatures[];
}

interface AudioFeaturesAvg {
  energy: number; valence: number; danceability: number;
  acousticness: number; instrumentalness: number;
  speechiness: number; tempo: number; loudness: number;
}

interface GenreCount { genre: string; count: number; weight: number }

// ─── Audio feature averaging ──────────────────────────────────────────────────

function averageAudioFeatures(features: SpotifyAudioFeatures[]): AudioFeaturesAvg {
  const valid = features.filter(Boolean);
  if (!valid.length) {
    return { energy: 0.5, valence: 0.5, danceability: 0.5, acousticness: 0.5,
             instrumentalness: 0.5, speechiness: 0.1, tempo: 120, loudness: -8 };
  }
  const keys = ['energy','valence','danceability','acousticness',
                 'instrumentalness','speechiness','tempo','loudness'] as const;
  const sums: Record<string, number> = {};
  keys.forEach(k => (sums[k] = 0));
  valid.forEach(f => keys.forEach(k => (sums[k] += f[k])));
  const avg: Partial<AudioFeaturesAvg> = {};
  keys.forEach(k => (avg[k] = sums[k] / valid.length));
  return avg as AudioFeaturesAvg;
}

// ─── Listening hour histogram ─────────────────────────────────────────────────

function buildListeningHistogram(items: SpotifyRecentlyPlayedItem[]): number[] {
  const histogram = new Array(24).fill(0) as number[];
  items.forEach(item => {
    if (item?.played_at) {
      histogram[new Date(item.played_at).getUTCHours()]++;
    }
  });
  return histogram;
}

// ─── Genre extraction from artists ───────────────────────────────────────────

function extractGenresFromArtists(artists: SpotifyArtist[]): GenreCount[] {
  const scores = new Map<string, number>();
  const rw = (i: number) => 1 / Math.sqrt(i + 1);

  for (let i = 0; i < artists.length; i++) {
    for (const genre of (artists[i].genres ?? [])) {
      const key = genre.toLowerCase();
      scores.set(key, (scores.get(key) ?? 0) + rw(i));
    }
  }
  if (!scores.size) return [];

  const max = Math.max(...scores.values());
  return Array.from(scores.entries())
    .map(([genre, count]) => ({ genre, count: Math.round(count * 10) / 10, weight: count / max }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 30);
}

// ─── Personality type classification ─────────────────────────────────────────

function classifyPersonality(f: AudioFeaturesAvg): string {
  const { energy, valence, danceability } = f;
  if (energy > 0.7 && valence > 0.6 && danceability > 0.65) return 'The Energiser';
  if (energy < 0.4 && valence > 0.55)                       return 'The Dreamer';
  if (energy < 0.45 && valence < 0.45)                      return 'The Philosopher';
  if (energy > 0.65 && danceability > 0.7)                  return 'The Explorer';
  if (energy < 0.5 && danceability < 0.5 && valence < 0.5)  return 'The Night Owl';
  return 'The Wanderer';
}

// ─── Main upsert function — saves a full music profile to the DB ──────────────

/**
 * Transforms raw Spotify data into a music profile and upserts it.
 * This was the missing function that caused all sync jobs to silently discard data.
 */
export async function upsertMusicProfile(userId: string, data: RawSpotifyData) {
  const allArtists = [...data.topArtistsShort, ...data.topArtistsMedium, ...data.topArtistsLong];
  const top_genres        = extractGenresFromArtists(allArtists);
  const audio_features_avg = averageAudioFeatures(data.audioFeatures);
  const listening_hours   = buildListeningHistogram(data.recentlyPlayed);
  const personality_type  = classifyPersonality(audio_features_avg);

  const recently_played = data.recentlyPlayed
    .filter(i => i?.track && i?.played_at)
    .slice(0, 50)
    .map(i => ({
      track_id:    i.track.id,
      track_name:  i.track.name,
      artist_name: i.track.artists[0]?.name ?? 'Unknown',
      played_at:   i.played_at,
      hour:        new Date(i.played_at).getUTCHours(),
    }));

  await query(
    `INSERT INTO music_profiles
       (user_id,
        top_artists_short, top_artists_medium, top_artists_long,
        top_tracks_short,  top_tracks_medium,  top_tracks_long,
        top_genres, recently_played, audio_features_avg,
        listening_hours, personality_type, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       top_artists_short  = EXCLUDED.top_artists_short,
       top_artists_medium = EXCLUDED.top_artists_medium,
       top_artists_long   = EXCLUDED.top_artists_long,
       top_tracks_short   = EXCLUDED.top_tracks_short,
       top_tracks_medium  = EXCLUDED.top_tracks_medium,
       top_tracks_long    = EXCLUDED.top_tracks_long,
       top_genres         = EXCLUDED.top_genres,
       recently_played    = EXCLUDED.recently_played,
       audio_features_avg = EXCLUDED.audio_features_avg,
       listening_hours    = EXCLUDED.listening_hours,
       personality_type   = EXCLUDED.personality_type,
       synced_at          = NOW(),
       updated_at         = NOW()`,
    [
      userId,
      JSON.stringify(data.topArtistsShort),
      JSON.stringify(data.topArtistsMedium),
      JSON.stringify(data.topArtistsLong),
      JSON.stringify(data.topTracksShort),
      JSON.stringify(data.topTracksMedium),
      JSON.stringify(data.topTracksLong),
      JSON.stringify(top_genres),
      JSON.stringify(recently_played),
      JSON.stringify(audio_features_avg),
      listening_hours,
      personality_type,
    ]
  );

  console.log(`[profile] Saved music profile for user ${userId} — personality: ${personality_type}`);
}

// ─── Read functions ───────────────────────────────────────────────────────────

export async function getMusicProfile(userId: string) {
  return queryOne('SELECT * FROM music_profiles WHERE user_id = $1', [userId]);
}

export function profileNeedsSync(profile: { synced_at: Date } | null, maxAgeHours = 24): boolean {
  if (!profile) return true;
  return Date.now() - new Date(profile.synced_at).getTime() > maxAgeHours * 3_600_000;
}
