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


function estimateMoodFromGenres(genres: any[]): any {
  const names = genres.map((g: any) => g.genre?.toLowerCase() ?? '');
  const has = (keywords: string[]) =>
    names.filter(n => keywords.some(k => n.includes(k))).length / Math.max(names.length, 1);

  const goldenEra      = has(['golden','retro','classic hindi','old hindi','evergreen',
                               'purani','lata','rafi','kishore','mukesh','hemant',
                               '50s','60s','70s bollywood','vintage bollywood']);
  const assamese       = has(['assamese','bihu','borgeet','barpeta','kamrupi',
                               'zubeen','bhupen','dixantar','jatiswar']);
  const bengali        = has(['bengali','rabindra','nazrul','baul','jibonmukhi']);
  const hindiClassical = has(['hindustani','classical','raga','thumri','dadra']);
  const carnatic       = has(['carnatic','subbulakshmi','thyagaraja','dikshitar']);
  const sufi           = has(['sufi','qawwali','kafi','nusrat','rahat fateh','sufiana']);
  const ghazal         = has(['ghazal','jagjit','pankaj udhas','mehdi hassan','gulam ali']);
  const devotional     = has(['bhajan','devotional','kirtan','aarti','mantra',
                               'spiritual','shloka','hanuman','shiva']);
  const folk           = has(['folk','lokgeet','baul','lavani','dandiya','garba',
                               'bhangra','bihu','jhumur','sohar','chaiti']);
  const bollywood      = has(['bollywood','hindi film','filmi','hindi pop',
                               'desi pop','indian pop','arijit','atif','armaan']);
  const indipop        = has(['indie','independent','prateek kuhad','ritviz',
                               'anuv jain','local train','lifafa']);
  const punjabi        = has(['punjabi','bhangra','ap dhillon','diljit','badshah']);
  const highEnergy     = has(['metal','punk','hardcore','edm','dubstep','trap',
                               'drum and bass','techno','rave','grunge']);
  const rock           = has(['rock','alternative rock','indie rock','classic rock',
                               'progressive rock','soft rock','pop rock']);
  const hiphop         = has(['hip-hop','rap','r&b','trap','drill','grime']);
  const dance          = has(['dance','house','disco','funk','club','electronic',
                               'afrobeat','reggaeton','dancehall']);
  const ambient        = has(['ambient','drone','atmospheric','space','post-rock',
                               'shoegaze','dream pop','chillwave','lo-fi']);
  const acoustic       = has(['acoustic','singer-songwriter','unplugged','fingerstyle']);
  const jazz           = has(['jazz','blues','soul','swing','bebop','smooth jazz','neo soul']);
  const classical      = has(['classical','orchestra','symphony','opera','piano','violin']);
  const lofi           = has(['lo-fi','lofi','chillhop','study music','chill beats','bedroom pop']);
  const blues          = has(['blues','sad','melancholic','heartbreak','emo']);

  const energy = Math.max(0.1, Math.min(1,
    0.3 + highEnergy*0.8 + rock*0.4 + dance*0.5 + hiphop*0.4 + punjabi*0.45
    + folk*0.3 + bollywood*0.25 - goldenEra*0.25 - ghazal*0.35
    - sufi*0.2 - ambient*0.3 - classical*0.25 - devotional*0.3 - lofi*0.25
  ));

  const valence = Math.max(0.1, Math.min(1,
    0.4 + dance*0.4 + folk*0.3 + punjabi*0.35 + bollywood*0.2
    + indipop*0.15 - ghazal*0.35 - blues*0.3 - lofi*0.15 + goldenEra*0.1
  ));

  const danceability = Math.max(0.1, Math.min(1,
    0.3 + dance*0.7 + hiphop*0.55 + punjabi*0.6 + folk*0.45
    + bollywood*0.35 - classical*0.25 - ghazal*0.3 - ambient*0.3 - goldenEra*0.15
  ));

  const acousticness = Math.max(0.1, Math.min(1,
    0.2 + acoustic*0.7 + classical*0.6 + goldenEra*0.5 + folk*0.5
    + ghazal*0.55 + sufi*0.4 + assamese*0.45 + bengali*0.4 + devotional*0.4
    - highEnergy*0.3 - dance*0.25 - hiphop*0.2
  ));

  const nostalgia = Math.max(0, Math.min(1,
    goldenEra*0.8 + ghazal*0.5 + assamese*0.4 + bengali*0.35
    + folk*0.3 + devotional*0.25 + jazz*0.2 + classical*0.2
  ));

  const transcendence = Math.max(0, Math.min(1,
    devotional*0.9 + sufi*0.7 + hindiClassical*0.6 + carnatic*0.65
    + ghazal*0.4 + ambient*0.4 + classical*0.35 + assamese*0.2
  ));

  const romance = Math.max(0, Math.min(1,
    ghazal*0.8 + goldenEra*0.55 + sufi*0.4 + bollywood*0.35
    + indipop*0.4 + acoustic*0.3 + jazz*0.3 + bengali*0.25 + assamese*0.2
  ));

  return {
    energy, valence, danceability, acousticness,
    instrumentalness: Math.max(0.1, classical*0.6 + ambient*0.5 + jazz*0.3),
    speechiness:      Math.max(0.05, hiphop*0.5 + punjabi*0.2),
    tempo:            120 + (energy * 60) - 30,
    loudness:         -8 + (energy * 6) - 3,
    nostalgia, transcendence, romance,
    assamese_weight:    assamese,
    golden_era_weight:  goldenEra,
  };
}

function classifyPersonality(f: any): string {
  const {
    energy = 0.5, valence = 0.5, danceability = 0.5,
    acousticness = 0.3, instrumentalness = 0.2,
    nostalgia = 0, transcendence = 0, romance = 0,
    assamese_weight = 0, golden_era_weight = 0,
  } = f;

  if (transcendence > 0.55)                                    return 'The Seeker';
  if (golden_era_weight > 0.35 && nostalgia > 0.45)           return 'The Nostalgic';
  if (assamese_weight > 0.25)                                  return 'The Root Keeper';
  if (romance > 0.55 && energy < 0.55)                        return 'The Romantic';
  if (nostalgia > 0.4 && energy < 0.5)                        return 'The Time Traveller';
  if (energy > 0.75 && valence > 0.65 && danceability > 0.7)  return 'The Energiser';
  if (energy > 0.65 && danceability > 0.7 && valence < 0.45)  return 'The Rebel';
  if (energy > 0.6 && danceability > 0.65 && valence > 0.5)   return 'The Social Butterfly';
  if (energy < 0.35 && valence > 0.6 && acousticness > 0.5)   return 'The Dreamer';
  if (energy < 0.4 && valence < 0.4 && acousticness > 0.4)    return 'The Philosopher';
  if (energy < 0.5 && danceability < 0.45 && valence < 0.45)  return 'The Night Owl';
  if (instrumentalness > 0.45)                                 return 'The Purist';
  if (acousticness > 0.6 && energy < 0.55 && valence > 0.45)  return 'The Storyteller';
  if (valence > 0.7 && energy > 0.5)                          return 'The Optimist';
  if (energy > 0.55 && valence > 0.55)                        return 'The Explorer';
  if (energy < 0.45 && acousticness > 0.5 && romance > 0.3)   return 'The Calm Soul';
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
  const audio_features_avg = data.audioFeatures.length > 0
  ? averageAudioFeatures(data.audioFeatures)
  : estimateMoodFromGenres(top_genres);
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
