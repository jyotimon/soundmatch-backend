import { Router, Request, Response } from 'express';
import { requireAuth, AuthRequest } from '../auth.middleware';   // ← was '../middleware/auth.middleware' (wrong)
import { query, queryOne } from '../db/client';

export const communityRouter = Router();
communityRouter.use(requireAuth);

communityRouter.get('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthRequest).user.sub;
    const data   = await query(
      `SELECT c.*,
         CASE WHEN cm.user_id IS NOT NULL THEN true ELSE false END AS is_member
       FROM communities c
       LEFT JOIN community_members cm ON cm.community_id = c.id AND cm.user_id = $1
       ORDER BY c.member_count DESC`,
      [userId]
    );
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

communityRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const userId    = (req as AuthRequest).user.sub;
    const community = await queryOne('SELECT * FROM communities WHERE id = $1', [req.params.id]);
    if (!community) return res.status(404).json({ success: false, error: 'Not found' });

    const members = await query(
      `SELECT u.id, u.display_name, u.avatar_url, mp.personality_type
       FROM community_members cm
       JOIN users u ON u.id = cm.user_id
       LEFT JOIN music_profiles mp ON mp.user_id = u.id
       WHERE cm.community_id = $1 ORDER BY cm.joined_at DESC LIMIT 20`,
      [req.params.id]
    );
    const is_member = members.some((m: any) => m.id === userId);
    res.json({ success: true, data: { community, members, is_member } });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

communityRouter.post('/:id/join', async (req: Request, res: Response) => {
  try {
    const userId    = (req as AuthRequest).user.sub;
    const community = await queryOne<any>('SELECT * FROM communities WHERE id = $1', [req.params.id]);
    if (!community) return res.status(404).json({ success: false, error: 'Not found' });

    await query(
      'INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.params.id, userId]
    );
    await query('UPDATE communities SET member_count = member_count + 1 WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: `Joined ${community.name}` });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

communityRouter.delete('/:id/leave', async (req: Request, res: Response) => {
  try {
    const userId  = (req as AuthRequest).user.sub;
    const deleted = await query(
      'DELETE FROM community_members WHERE community_id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, userId]
    );
    if (deleted.length > 0) {
      await query(
        'UPDATE communities SET member_count = GREATEST(member_count - 1, 0) WHERE id = $1',
        [req.params.id]
      );
    }
    res.json({ success: true, message: 'Left community' });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});
