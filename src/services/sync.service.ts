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
    const rawData = await fetchAllMusicData(userId);
    await upsertMusicProfile(userId, rawData);
    // Only generate persona if not already saved
const profile = await getMusicProfile(userId) as any;
if (profile && !profile.ai_persona) {
  const persona = await generateMusicPersona(profile).catch(() => '');
  if (persona) {
    await query(
      'UPDATE music_profiles SET ai_persona = $1 WHERE user_id = $2',
      [persona, userId]
    );
    console.log(`[ai] Persona generated for ${userId}`);
  }
} else {
  console.log(`[ai] Persona already cached — skipping Gemini call`);
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