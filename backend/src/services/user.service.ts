import { query, queryOne } from '../db/client';
import { encrypt } from '../utils/crypto';
import type { User, SpotifyUserProfile, SpotifyTokenResponse } from '../types';

export async function upsertUser(
  spotifyProfile: SpotifyUserProfile,
  tokens: SpotifyTokenResponse
): Promise<User> {
  const avatarUrl      = spotifyProfile.images?.[0]?.url ?? null;
  const tokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  const [user] = await query<User>(
    `INSERT INTO users
       (spotify_id, display_name, email, avatar_url, country, product,
        access_token_enc, refresh_token_enc, token_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (spotify_id) DO UPDATE SET
       display_name      = EXCLUDED.display_name,
       email             = EXCLUDED.email,
       avatar_url        = EXCLUDED.avatar_url,
       country           = EXCLUDED.country,
       product           = EXCLUDED.product,
       access_token_enc  = EXCLUDED.access_token_enc,
       refresh_token_enc = EXCLUDED.refresh_token_enc,
       token_expires_at  = EXCLUDED.token_expires_at,
       updated_at        = NOW()
     RETURNING *`,
    [
      spotifyProfile.id,
      spotifyProfile.display_name,
      spotifyProfile.email,
      avatarUrl,
      spotifyProfile.country,
      spotifyProfile.product,
      encrypt(tokens.access_token),
      encrypt(tokens.refresh_token),
      tokenExpiresAt,
    ]
  );
  return user;
}

export async function getUserById(id: string): Promise<User | null> {
  return queryOne<User>('SELECT * FROM users WHERE id = $1', [id]);
}

// Returns a safe public view of a user (no tokens) + their music profile
export async function getPublicUser(id: string) {
  return queryOne(
    `SELECT
       u.id, u.display_name, u.avatar_url, u.country, u.created_at,
       mp.personality_type,
       mp.top_genres,
       mp.top_artists_medium,
       mp.top_tracks_medium,
       mp.audio_features_avg,
       mp.listening_hours,
       mp.synced_at
     FROM users u
     LEFT JOIN music_profiles mp ON mp.user_id = u.id
     WHERE u.id = $1`,
    [id]
  );
}
