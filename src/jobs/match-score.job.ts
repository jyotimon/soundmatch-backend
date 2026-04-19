import { Worker, Queue, Job } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';
import { computeScoresForNewUser } from '../services/compatibility.service';  // ← was commented out

const redis = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  tls: {},
  connectTimeout: 10000,
  retryStrategy: (times) => Math.min(times * 500, 5000),
  enableOfflineQueue: false,
  lazyConnect: true,
});


export const matchScoreQueue = new Queue<MatchScoreJobData>('match-scores', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 50  },
  },
});

export interface MatchScoreJobData {
  userId:      string;
  triggeredBy: 'new_user' | 'profile_sync' | 'manual';
}

export function startMatchScoreWorker(): Worker {
  const worker = new Worker<MatchScoreJobData>(
    'match-scores',
    async (job: Job<MatchScoreJobData>) => {
      const { userId } = job.data;
      console.log(`[match-score] Computing scores for user ${userId}`);

      await job.updateProgress(10);
      const computed = await computeScoresForNewUser(userId, 50);  // ← was commented out
      await job.updateProgress(100);

      console.log(`[match-score] Done — ${computed} scores computed for ${userId}`);
      return { computed };
    },
    { connection: redis, concurrency: 5 }
  );

  worker.on('completed', (job) => {
    console.log(`[match-score] Job ${job.id} completed`);
  });
  worker.on('failed', (job, err) => {
    console.error(`[match-score] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}

export async function enqueueMatchScoring(
  userId:      string,
  triggeredBy: MatchScoreJobData['triggeredBy'] = 'profile_sync'
): Promise<void> {
  await matchScoreQueue.add(
    `score-${userId}`,
    { userId, triggeredBy },
    { jobId: `score-${userId}` }
  );
}
