import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';

import { config } from './config';
import { connectDatabase } from './db/client';
import { authRouter }      from './routes/auth.routes';
import { usersRouter }     from './routes/users.routes';
import { matchesRouter }   from './routes/matches.routes';   // ← was missing
import { communityRouter } from './routes/community.routes';
// import { startMusicSyncWorker }  from './jobs/music-sync.job';
// import { startMatchScoreWorker } from './jobs/match-score.job';

const app = express();
app.set('trust proxy', 1);  // Enable if behind a proxy (e.g., Heroku, Nginx) for correct client IPs in rate limiting and logging

app.use(helmet());
app.use(cors({ origin: config.FRONTEND_URL, credentials: true }));
app.use(compression() as express.RequestHandler);
app.use(express.json());
app.use(cookieParser());

app.use('/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }));
app.use('/api',  rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));

app.use('/auth',            authRouter);
app.use('/api/users',       usersRouter);
app.use('/api/matches',     matchesRouter);   // ← was missing
app.use('/api/communities', communityRouter);

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
);
app.get('/', (_req, res) =>
  res.json({ message: 'SoundMatch API running' })
);

app.use((_req, res) =>
  res.status(404).json({ success: false, error: 'Route not found' })
);
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    error: config.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

async function bootstrap() {
  try {
    await connectDatabase();
    console.log('✅  Database connected');
  } catch (err) {
    console.error('❌  Database connection failed — check DATABASE_URL in .env');
    process.exit(1);
  }

  try {
    startMusicSyncWorker();
    startMatchScoreWorker();
    console.log('✅  Background workers started');
  } catch (err) {
    console.error('❌  Worker startup failed — is Redis running? Run: docker-compose up -d');
    process.exit(1);
  }

  app.listen(config.PORT, () => {
    console.log(`\n✅  API running on port ${config.PORT}`);
    console.log(`   Health: http://localhost:${config.PORT}/health`);
    console.log(`   Login:  http://localhost:${config.PORT}/auth/login\n`);
  });
}

bootstrap();
