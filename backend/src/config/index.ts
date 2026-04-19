import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV:                z.enum(['development', 'production', 'test']).default('development'),
  PORT:                    z.string().default('4000').transform(Number),
  API_URL:                 z.string().default('http://localhost:4000'),
  FRONTEND_URL:            z.string().default('http://localhost:3000'),
  DATABASE_URL:            z.string().default('postgresql://soundmatch:soundmatch_dev@localhost:5432/soundmatch'),
  REDIS_URL:               z.string().default('redis://localhost:6379'),
  SPOTIFY_CLIENT_ID:       z.string().min(1, 'SPOTIFY_CLIENT_ID is required'),
  SPOTIFY_CLIENT_SECRET:   z.string().min(1, 'SPOTIFY_CLIENT_SECRET is required'),
  SPOTIFY_REDIRECT_URI:    z.string().default('http://localhost:4000/auth/callback'),
  JWT_SECRET:              z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN:          z.string().default('7d'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌  Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

// All Spotify scopes the app needs
export const SPOTIFY_SCOPES = [
  'user-read-private',
  'user-read-email',
  'user-top-read',
  'user-read-recently-played',
  'user-library-read',
  'playlist-read-private',
  'playlist-modify-public',
  'playlist-modify-private',
].join(' ');

export const SPOTIFY_ACCOUNTS_URL = 'https://accounts.spotify.com';
export const SPOTIFY_API_URL      = 'https://api.spotify.com/v1';
