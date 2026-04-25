import { fetchAllMusicData } from './spotify.service';
import { upsertMusicProfile } from './profile.service';
import { computeScoresForNewUser } from './compatibility.service';

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