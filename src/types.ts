export type SpotifyTokenResponse = any;
export type SpotifyRefreshResponse = any;
export type SpotifyUserProfile = any;
export type SpotifyArtist = any;
export type SpotifyTrack = any;
export type SpotifyAudioFeatures = any;
export type SpotifyRecentlyPlayedItem = any;
export type SpotifyPaginated<SpotifyArtist> = any;
export type User = any;
export interface JwtPayload {
    sub: string;
    spotify_id: string;
    display_name: string;
}