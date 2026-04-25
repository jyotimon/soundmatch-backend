import { Router, Request, Response } from 'express';
import { requireAuth, AuthRequest } from '../auth.middleware';
import { getTopMatches, getCompatibilityScore, upsertCompatibilityScore } from '../services/compatibility.service';
import { createSharedPlaylist } from '../services/spotify.service';
import { query, queryOne } from '../db/client';
import { generateCompatibilityInsight, generatePlaylistName } from '../services/ai.service';
import { getMusicProfile } from '../services/profile.service';

// Add to the GET /:userId route, after getting the score:

export const matchesRouter = Router();
matchesRouter.use(requireAuth);
matchesRouter.get('/:userId', async (req: Request, res: Response) => {
  try {
    const currentUserId = (req as AuthRequest).user.sub;
    const { userId }    = req.params;

    if (currentUserId === userId)
      return res.status(400).json({ success: false, error: 'Cannot compare with yourself' });

    const score = await getCompatibilityScore(currentUserId, userId)
      ?? await upsertCompatibilityScore(currentUserId, userId);

    if (!score) return res.status(404).json({ success: false, error: 'No profiles found' });

    // AI insight — inside the route handler, not outside
    const [profileA, profileB] = await Promise.all([
      getMusicProfile(currentUserId),
      getMusicProfile(userId),
    ]);

    const insight = (profileA && profileB)
      ? await generateCompatibilityInsight(profileA, profileB, score).catch(() => null)
      : null;

    res.json({ success: true, data: { ...score, ai_insight: insight } });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// GET /api/matches — top compatibility matches for current user
matchesRouter.get('/', async (req: Request, res: Response) => {
  try {
    const userId   = (req as AuthRequest).user.sub;
    const limit    = Math.min(Number(req.query.limit  ?? 20), 50);
    const minScore = Number(req.query.min_score ?? 30);
    const matches  = await getTopMatches(userId, limit, minScore);
    res.json({ success: true, data: matches });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// GET /api/matches/:userId — compatibility with a specific user
matchesRouter.get('/:userId', async (req: Request, res: Response) => {
  try {
    const currentUserId = (req as AuthRequest).user.sub;
    const { userId }    = req.params;

    if (currentUserId === userId)
      return res.status(400).json({ success: false, error: 'Cannot compare with yourself' });

    const score = await getCompatibilityScore(currentUserId, userId)
      ?? await upsertCompatibilityScore(currentUserId, userId);

    if (!score) return res.status(404).json({ success: false, error: 'No profiles found to compare' });
    res.json({ success: true, data: score });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST /api/matches/:userId — send a match request
matchesRouter.post('/:userId', async (req: Request, res: Response) => {
  try {
    const currentUserId = (req as AuthRequest).user.sub;
    const { userId }    = req.params;

    if (currentUserId === userId)
      return res.status(400).json({ success: false, error: 'Cannot match yourself' });

    const score = await getCompatibilityScore(currentUserId, userId);
    if (!score)
      return res.status(422).json({ success: false, error: 'Both users need synced profiles first' });

    const [userAId, userBId] = currentUserId < userId
      ? [currentUserId, userId] : [userId, currentUserId];

    const existing = await queryOne(
      'SELECT * FROM matches WHERE user_a_id = $1 AND user_b_id = $2',
      [userAId, userBId]
    );
    if (existing)
      return res.status(409).json({ success: false, error: 'Match already exists', data: existing });

    const [match] = await query(
      `INSERT INTO matches (user_a_id, user_b_id, compatibility_score, status)
       VALUES ($1, $2, $3, 'pending') RETURNING *`,
      [userAId, userBId, score.total_score]
    );
    res.status(201).json({ success: true, data: match });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// PUT /api/matches/:matchId — update status (matched / declined / unmatched)
matchesRouter.put('/:matchId', async (req: Request, res: Response) => {
  try {
    const currentUserId = (req as AuthRequest).user.sub;
    const { matchId }   = req.params;
    const { status }    = req.body;

    if (!['matched', 'declined', 'unmatched'].includes(status))
      return res.status(400).json({ success: false, error: 'Invalid status' });

    const match = await queryOne(
      'SELECT * FROM matches WHERE id = $1 AND (user_a_id = $2 OR user_b_id = $2)',
      [matchId, currentUserId]
    );
    if (!match) return res.status(404).json({ success: false, error: 'Match not found' });

    const [updated] = await query(
      'UPDATE matches SET status = $1 WHERE id = $2 RETURNING *',
      [status, matchId]
    );
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST /api/matches/:matchId/playlist — create shared Spotify playlist
matchesRouter.post('/:matchId/playlist', async (req: Request, res: Response) => {
  try {
    const currentUserId = (req as AuthRequest).user.sub;
    const { matchId }   = req.params;

    const match = await queryOne(
      `SELECT * FROM matches
       WHERE id = $1 AND (user_a_id = $2 OR user_b_id = $2) AND status = 'matched'`,
      [matchId, currentUserId]
    );
    if (!match) return res.status(404).json({ success: false, error: 'Active match not found' });

    const tracks = await query<{ track_id: string }>(
      `SELECT DISTINCT jsonb_array_elements(top_tracks_medium)->>'id' AS track_id
       FROM music_profiles
       WHERE user_id IN ($1, $2) LIMIT 30`,
      [(match as any).user_a_id, (match as any).user_b_id]
    );

    const uris = tracks.map(t => `spotify:track:${t.track_id}`);

// Get both profiles for AI playlist name
const [profileA, profileB] = await Promise.all([
  getMusicProfile((match as any).user_a_id),
  getMusicProfile((match as any).user_b_id),
]);

const compatScore = await getCompatibilityScore(
  (match as any).user_a_id,
  (match as any).user_b_id
);

const aiPlaylistName = await generatePlaylistName(
  String(profileA?.personality_type ?? 'Music Lover'),  // ← wrap in String()
  String(profileB?.personality_type ?? 'Music Lover'),  // ← wrap in String()
  compatScore?.shared_artists ?? []
).catch(() => 'Our Shared Sound');

const playlistId = await createSharedPlaylist(currentUserId, uris, aiPlaylistName);
    if (!playlistId)
      return res.status(500).json({ success: false, error: 'Could not create Spotify playlist' });

    const [updated] = await query(
      'UPDATE matches SET shared_playlist_id = $1 WHERE id = $2 RETURNING *',
      [playlistId, matchId]
    );
    res.json({
      success: true,
      data: {
        match: updated,
        playlist_url: `https://open.spotify.com/playlist/${playlistId}`,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});
