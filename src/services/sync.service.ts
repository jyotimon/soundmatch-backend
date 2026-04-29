import { fetchAllMusicData } from './spotify.service';
import { upsertMusicProfile, getMusicProfile } from './profile.service';
import { computeScoresForNewUser } from './compatibility.service';
import { generateMusicPersona } from './ai.service';
import { query } from '../db/client';

const inProgress = new Set<string>();

export async function runMusicSync(userId: string, triggeredBy = 'manual') {
  if (inProgress.has(userId)) {
    console.log(`[sync] Already running for ${userId} — skipping`);
    return;
  }
  inProgress.add(userId);
  console.log(`[sync] Starting for ${userId} (${triggeredBy})`);

  try {
    // Check persona BEFORE overwriting profile
    // Check persona BEFORE overwriting profile
    const existing = await getMusicProfile(userId) as any;
    const hasPersona = !!(existing?.ai_persona);

    const rawData = await fetchAllMusicData(userId);
    await upsertMusicProfile(userId, rawData);

   if (!hasPersona) {
   const fresh = await getMusicProfile(userId) as any;
   if (fresh) {
    // Save template first — breaks the retry loop
     const genres = JSON.parse(typeof fresh.top_genres === 'string'
      ? fresh.top_genres : JSON.stringify(fresh.top_genres ?? []))
      .slice(0, 3).map((g: any) => g.genre).join(', ');

    const templatePersona = `Your music taste gravitates toward ${genres || 'eclectic sounds'}, reflecting a listener with a ${fresh.personality_type} spirit who finds meaning in every note.`;

    await query(
      'UPDATE music_profiles SET ai_persona = $1 WHERE user_id = $2',
      [templatePersona, userId]
    );
    console.log(`[ai] Template persona saved for ${userId}`);

    // Try Gemini to enhance it — if it fails, template stays
    const aiPersona = await generateMusicPersona(fresh).catch(() => '');
    if (aiPersona) {
      await query(
        'UPDATE music_profiles SET ai_persona = $1 WHERE user_id = $2',
        [aiPersona, userId]
      );
      console.log(`[ai] AI persona upgraded for ${userId}`);
    }
  }
} else {
  console.log(`[ai] Persona already cached — skipping Gemini`);
}

    await computeScoresForNewUser(userId);
    console.log(`[sync] Done for ${userId}`);

  } catch (err) {
    console.error(`[sync] Failed for ${userId}:`, (err as Error).message);
  } finally {
    inProgress.delete(userId);
  }
}

export function startSyncInBackground(userId: string, triggeredBy = 'login') {
  runMusicSync(userId, triggeredBy).catch(console.error);
}