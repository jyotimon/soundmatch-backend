import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { config } from '../config';
import { buildAuthUrl, exchangeCode, fetchUserProfile } from '../services/spotify.service';
import { upsertUser, getUserById } from '../services/user.service';
import { signToken } from '../utils/jwt';
import { requireAuth, AuthRequest } from '../auth.middleware';
import { getMusicProfile } from '../services/profile.service';
import { enqueueMusicSync } from '../jobs/music-sync.job';

export const authRouter = Router();

// In-memory CSRF state store (use Redis in production for multi-instance deployments)
const stateStore = new Map<string, number>();

// ─── GET /auth/login — redirect user to Spotify ───────────────────────────────
authRouter.get('/login', (_req: Request, res: Response) => {
  const state = randomBytes(16).toString('hex');
  stateStore.set(state, Date.now() + 10 * 60 * 1000); // expires in 10 min
  res.redirect(buildAuthUrl(state));
});

// ─── GET /auth/callback — Spotify redirects here after login ─────────────────
// FIX 1: Redirects to /auth/callback (not /dashboard) so the frontend token handler fires
// FIX 2: signToken receives correct payload { sub, spotify_id, display_name }
// FIX 3: enqueueMusicSync is called so the profile builds after login
authRouter.get('/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, error } = req.query as Record<string, string>;

    if (error) {
      console.error('Spotify OAuth error:', error);
      return res.redirect(`${config.FRONTEND_URL}?error=${encodeURIComponent(error)}`);
    }

    // Verify CSRF state
    const expiry = stateStore.get(state);
    if (!expiry || Date.now() > expiry) {
      console.error('Invalid or expired OAuth state');
      return res.redirect(`${config.FRONTEND_URL}?error=invalid_state`);
    }
    stateStore.delete(state);

    // Exchange code for Spotify tokens
    const tokens = await exchangeCode(code);

    // Fetch the Spotify user profile
    const spotifyProfile = await fetchUserProfile(tokens.access_token);

    // Upsert user in the database
    const user = await upsertUser(spotifyProfile, tokens);

    // Build JWT — FIX: pass only the correct payload fields, not the whole user object
    const jwtToken = signToken({
      sub:          user.id,
      spotify_id:   user.spotify_id,
      display_name: user.display_name,
    });

    // Kick off async music sync — FIX: was commented out before, so no data ever arrived
    enqueueMusicSync(user.id, 'login').catch((err) =>
      console.error('[auth] Failed to queue music sync:', err)
    );

    // FIX: redirect to /auth/callback (not /dashboard) so the frontend captures the token
    return res.redirect(`${config.FRONTEND_URL}/auth/callback?token=${jwtToken}`);

  } catch (err) {
    console.error('OAuth callback error:', err);
    return res.redirect(`${config.FRONTEND_URL}?error=auth_failed`);
  }
});

// ─── GET /auth/me — current user + their music profile ───────────────────────
// FIX 4: profile is now actually fetched instead of being hardcoded to null
authRouter.get('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthRequest).user.sub;

    const [user, profile] = await Promise.all([
      getUserById(userId),
      getMusicProfile(userId),
    ]);

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Strip encrypted tokens before sending to client
    const { access_token_enc, refresh_token_enc, ...safeUser } = user;

    res.json({
      success: true,
      data: { user: safeUser, profile },
    });
  } catch (err) {
    console.error('/auth/me error:', err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── POST /auth/logout ────────────────────────────────────────────────────────
authRouter.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie('token');
  res.json({ success: true, message: 'Logged out' });
});
