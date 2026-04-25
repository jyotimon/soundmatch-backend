import { Router, Request, Response } from 'express';
import { requireAuth, AuthRequest } from '../auth.middleware';
import { getPublicUser } from '../services/user.service';
import { getMusicProfile } from '../services/profile.service';
import { getCompatibilityScore, upsertCompatibilityScore } from '../services/compatibility.service';
import { enqueueMusicSync } from '../jobs/music-sync.job';
import { generateMusicPersona } from '../services/ai.service';


export const usersRouter = Router();
usersRouter.use(requireAuth);



// GET /api/users/me/profile — full music profile for current user
usersRouter.get('/me/profile', async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthRequest).user.sub;
    const profile = await getMusicProfile(userId);
    if (!profile) {
      return res.status(202).json({
        success: false,
        error: 'Profile not ready yet — sync is running, check back in 30 seconds',
      });
    }
    res.json({ success: true, data: profile });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST /api/users/me/sync — manually trigger a Spotify data refresh
usersRouter.post('/me/sync', async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthRequest).user.sub;
    await enqueueMusicSync(userId, 'manual');
    res.json({ success: true, message: 'Sync queued — refresh your profile in ~30 seconds' });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// GET /api/users/:id — public profile of any user + compatibility score
usersRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const currentUserId = (req as AuthRequest).user.sub;
    const { id } = req.params;

    const user = await getPublicUser(id);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    let compatibility = null;
    if (id !== currentUserId) {
      compatibility = await getCompatibilityScore(currentUserId, id);
      if (!compatibility) {
        compatibility = await upsertCompatibilityScore(currentUserId, id);
      }
    }

    res.json({ success: true, data: { user, compatibility } });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});


// GET /api/users/me/persona — AI music description
usersRouter.get('/me/persona', async (req: Request, res: Response) => {
  try {
    const userId  = (req as AuthRequest).user.sub;
    const profile = await getMusicProfile(userId);
    if (!profile) return res.status(404).json({ success: false, error: 'No profile yet' });

    const description = await generateMusicPersona(profile);
    res.json({ success: true, data: { description } });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});
