/**
 * music-sync.job.ts
 *
 * BullMQ background worker that fetches all Spotify data for a user
 * and saves it as a music profile.
 *
 * FIXES:
 *   - upsertMusicProfile() is now called (was commented out — data was fetched
 *     but immediately discarded, leaving the database empty)
 *   - enqueueMusicSync() signature fixed: (userId, triggeredBy) — previously had
 *     an extra unused 'type' parameter that swallowed the triggeredBy value
 */

import { Worker, Queue, Job } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';
import { fetchAllMusicData } from '../services/spotify.service';
import { upsertMusicProfile } from '../services/profile.service';
import { enqueueMatchScoring } from './match-score.job';

const redis = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

export const musicSyncQueue = new Queue<MusicSyncJobData>('music-sync', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 50  },
  },
});

export interface MusicSyncJobData {
  userId:      string;
  triggeredBy: 'login' | 'manual' | 'scheduled';
}

export function startMusicSyncWorker(): Worker {
  const worker = new Worker<MusicSyncJobData>(
    'music-sync',
    async (job: Job<MusicSyncJobData>) => {
      const { userId, triggeredBy } = job.data;
      console.log(`[music-sync] Starting for user ${userId} (${triggeredBy})`);

      await job.updateProgress(10);

      // Step 1: Fetch all Spotify data
      const rawData = await fetchAllMusicData(userId);
      await job.updateProgress(50);

      // Step 2: Save to database — FIX: this was commented out before
      await upsertMusicProfile(userId, rawData);
      await job.updateProgress(80);

      // Step 3: Trigger compatibility scoring in the background
      await enqueueMatchScoring(userId, 'profile_sync');
      await job.updateProgress(100);

      console.log(`[music-sync] Done for user ${userId}`);
      return { success: true };
    },
    { connection: redis, concurrency: 3 }
  );

  worker.on('completed', (job) => {
    console.log(`[music-sync] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[music-sync] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}

// FIX: Removed unused 'type' parameter — was: (userId, type, triggeredBy)
// which swallowed 'login'/'manual' into the wrong slot
export async function enqueueMusicSync(
  userId:      string,
  triggeredBy: MusicSyncJobData['triggeredBy'] = 'manual'
): Promise<void> {
  await musicSyncQueue.add(
    `sync-${userId}`,
    { userId, triggeredBy },
    { jobId: `sync-${userId}` } // deduplicate: if already queued, skip
  );
  console.log(`[music-sync] Enqueued sync for user ${userId} (${triggeredBy})`);
}
