import axios, { AxiosInstance } from 'axios';
import { config, SPOTIFY_ACCOUNTS_URL, SPOTIFY_API_URL, SPOTIFY_SCOPES } from '../config';
import { encrypt, decrypt } from '../utils/crypto';
import { query, queryOne } from '../db/client';
import type {
  SpotifyTokenResponse, SpotifyRefreshResponse, SpotifyUserProfile,
  SpotifyArtist, SpotifyTrack, SpotifyAudioFeatures,
  SpotifyRecentlyPlayedItem, SpotifyPaginated, User,
} from '../types';

// ─── Build the Spotify login URL ──────────────────────────────────────────────
export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     config.SPOTIFY_CLIENT_ID,
    scope:         SPOTIFY_SCOPES,
    redirect_uri:  config.SPOTIFY_REDIRECT_URI,
    state,
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

// ─── Exchange auth code for tokens ───────────────────────────────────────────
export async function exchangeCode(code: string): Promise<SpotifyTokenResponse> {
  const credentials = Buffer.from(
    `${config.SPOTIFY_CLIENT_ID}:${config.SPOTIFY_CLIENT_SECRET}`
  ).toString('base64');

  const { data } = await axios.post<SpotifyTokenResponse>(
    `${SPOTIFY_ACCOUNTS_URL}/api/token`,
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: config.SPOTIFY_REDIRECT_URI }).toString(),
    { headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return data;
}

// ─── Refresh an expired access token ─────────────────────────────────────────
export async function refreshAccessToken(refreshToken: string): Promise<SpotifyRefreshResponse> {
  const credentials = Buffer.from(
    `${config.SPOTIFY_CLIENT_ID}:${config.SPOTIFY_CLIENT_SECRET}`
  ).toString('base64');

  const { data } = await axios.post<SpotifyRefreshResponse>(
    `${SPOTIFY_ACCOUNTS_URL}/api/token`,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
    { headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return data;
}

// ─── Get an authenticated Spotify client for a user ──────────────────────────
export async function getSpotifyClient(userId: string): Promise<AxiosInstance> {
  const user = await queryOne<User>('SELECT * FROM users WHERE id = $1', [userId]);
  if (!user) throw new Error('User not found');

  let accessToken = decrypt(user.access_token_enc);

  // Auto-refresh if token expires within 5 minutes
  const expiresAt = new Date(user.token_expires_at).getTime();
  if (Date.now() > expiresAt - 5 * 60 * 1000) {
    const refreshToken = decrypt(user.refresh_token_enc);
    const refreshed = await refreshAccessToken(refreshToken);
    accessToken = refreshed.access_token;

    await query(
      `UPDATE users SET access_token_enc=$1, token_expires_at=$2, updated_at=NOW() WHERE id=$3`,
      [encrypt(refreshed.access_token), new Date(Date.now() + refreshed.expires_in * 1000), userId]
    );
  }

  return axios.create({
    baseURL: SPOTIFY_API_URL,
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// ─── Fetch /me profile using a raw access token (used at login time) ─────────
export async function fetchUserProfile(accessToken: string): Promise<any> {
  const { data } = await axios.get('https://api.spotify.com/v1/me', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  return data;
}


// ─── Fetch top artists ────────────────────────────────────────────────────────
export async function fetchTopArtists(
  client: AxiosInstance,
  timeRange: 'short_term' | 'medium_term' | 'long_term'
): Promise<SpotifyArtist[]> {
  const { data } = await client.get<SpotifyPaginated<SpotifyArtist>>(
    `/me/top/artists?limit=50&time_range=${timeRange}`
  );
  return data.items;
}

// ─── Fetch top tracks ─────────────────────────────────────────────────────────
export async function fetchTopTracks(
  client: AxiosInstance,
  timeRange: 'short_term' | 'medium_term' | 'long_term'
): Promise<SpotifyTrack[]> {
  const { data } = await client.get<SpotifyPaginated<SpotifyTrack>>(
    `/me/top/tracks?limit=50&time_range=${timeRange}`
  );
  return data.items;
}

// ─── Fetch recently played ────────────────────────────────────────────────────
export async function fetchRecentlyPlayed(client: AxiosInstance): Promise<SpotifyRecentlyPlayedItem[]> {
  const { data } = await client.get<{ items: SpotifyRecentlyPlayedItem[] }>(
    '/me/player/recently-played?limit=50'
  );
  return data.items;
}

// ─── Fetch audio features for a list of track IDs ────────────────────────────
export async function fetchAudioFeatures(
  client: AxiosInstance,
  trackIds: string[]
): Promise<any[]> {
  if (!trackIds.length) return [];
  try {
    const results: any[] = [];
    for (let i = 0; i < trackIds.length; i += 100) {
      const chunk = trackIds.slice(i, i + 100);
      const { data } = await client.get(`/audio-features?ids=${chunk.join(',')}`);
      results.push(...(data.audio_features ?? []).filter(Boolean));
    }
    return results;
  } catch {
    console.warn('[spotify] Audio features unavailable (403) — skipping');
    return [];
  }
}


// ─── Fetch everything needed to build a music profile ────────────────────────
export async function fetchAllMusicData(userId: string) {
  const client = await getSpotifyClient(userId);

  const [
    topArtistsShort, topArtistsMedium, topArtistsLong,
    topTracksShort,  topTracksMedium,  topTracksLong,
    recentlyPlayed,
  ] = await Promise.all([
    fetchTopArtists(client, 'short_term'),
    fetchTopArtists(client, 'medium_term'),
    fetchTopArtists(client, 'long_term'),
    fetchTopTracks(client, 'short_term'),
    fetchTopTracks(client, 'medium_term'),
    fetchTopTracks(client, 'long_term'),
    fetchRecentlyPlayed(client),
  ]);

  // Audio features for medium-term tracks
  const audioFeatures = await fetchAudioFeatures(client, topTracksMedium.map((t) => t.id));

  return {
    topArtistsShort, topArtistsMedium, topArtistsLong,
    topTracksShort,  topTracksMedium,  topTracksLong,
    recentlyPlayed,  audioFeatures,
  };
}

// ─── Create a shared playlist on Spotify ─────────────────────────────────────
export async function createSharedPlaylist(
  userId: string,
  trackUris: string[],
  playlistName = 'SoundMatch — Our Mix'   // ← add this parameter
): Promise<string | null> {
  try {
    const client       = await getSpotifyClient(userId);
    const { data: me } = await client.get('/me');

    const { data: playlist } = await client.post(`/users/${me.id}/playlists`, {
      name:        playlistName,            // ← use it here
      description: 'Generated by SoundMatch — where music brings people together',
      public:      false,
    });
    // rest stays the same...

    if (trackUris.length > 0) {
      await client.post(`/playlists/${playlist.id}/tracks`, {
        uris: trackUris.slice(0, 100),
      });
    }

    return playlist.id as string;
  } catch (err) {
    console.error('Failed to create shared playlist:', err);
    return null;
  }
}
