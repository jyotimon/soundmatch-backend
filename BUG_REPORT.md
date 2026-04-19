# SoundMatch Backend — Bug Report & Fix Guide
# =====================================================

## BUG 1 — Callback redirects to wrong URL (dashboard flickers back to home)
File: src/routes/auth.routes.ts

BROKEN:
  res.redirect(`${config.FRONTEND_URL}/dashboard?token=${jwtToken}`)

The frontend has NO token handler at /dashboard. The token disappears from the URL
immediately, auth.setToken() is never called, so useAuth() finds no token in
localStorage, and the dashboard page guard kicks the user back to the landing page.

FIXED:
  res.redirect(`${config.FRONTEND_URL}/auth/callback?token=${jwtToken}`)

The frontend /auth/callback page reads the ?token= param, calls setToken(), then
redirects to /dashboard. This is the only correct flow.


## BUG 2 — signToken called with entire user object
File: src/routes/auth.routes.ts

BROKEN:
  const jwtToken = signToken(user);

signToken() expects { sub, spotify_id, display_name }. Passing the whole user object
signs a JWT with encrypted tokens inside — a security leak and likely a crash because
the user object doesn't match the JwtPayload type.

FIXED:
  const jwtToken = signToken({
    sub:          user.id,
    spotify_id:   user.spotify_id,
    display_name: user.display_name,
  });


## BUG 3 — Music sync fetches data but never saves it
File: src/jobs/music-sync.job.ts

BROKEN:
  // await upsertMusicProfile(userId, rawData);   ← commented out!

The job fetches all Spotify data correctly, then throws it away. The database gets
nothing. Dashboard, matches, everything — all empty.

FIXED: upsertMusicProfile() call is uncommented and the import is restored.


## BUG 4 — /auth/me hardcodes profile = null
File: src/routes/auth.routes.ts

BROKEN:
  const profile = null;  // hardcoded!

Even if a profile existed in the database, the /me endpoint returns null for it.
The dashboard receives user data but no music profile, so all the charts, genres,
and artists sections show empty.

FIXED:
  const profile = await getMusicProfile(userId);


## BUG 5 — upsertMusicProfile completely missing from profile.service.ts
File: src/services/profile.service.ts

The file only has getMusicProfile() using the Supabase SDK. The upsertMusicProfile()
function that transforms raw Spotify data and writes it to the DB is entirely absent.
This is why Bug 3 existed — there was nothing to uncomment to.

FIXED: Full profile.service.ts with upsertMusicProfile() using the pg pool.


## BUG 6 — enqueueMusicSync has a wrong parameter signature
File: src/jobs/music-sync.job.ts

BROKEN:
  export async function enqueueMusicSync(userId, type, triggeredBy = 'manual')

Callers do: enqueueMusicSync(userId, 'login')
The value 'login' goes into the `type` parameter (unused), and triggeredBy
defaults to 'manual'. The job always logs "manual" even for login triggers.

FIXED: Signature matches all callers — enqueueMusicSync(userId, triggeredBy)


## BUG 7 — index.ts is still the placeholder (all API routes missing)
File: src/index.ts

The server only mounts /auth routes on port 5000 with no CORS, no helmet,
no rate limiting. The /api/users, /api/matches, /api/communities routes don't
exist, so the frontend gets 404 on everything except login.

FIXED: Full production-ready Express server on the port from config,
with all 4 routers, CORS, helmet, rate limiting.


## BUG 8 — bullmq and ioredis missing from package.json
File: package.json

bullmq and ioredis are imported in jobs/music-sync.job.ts and jobs/match-score.job.ts
but aren't listed as dependencies. This causes a runtime crash when the server starts.

FIXED: Updated package.json includes all required packages.


## WHAT TO DO
1. Replace these files in your apps/api/ folder:
   - src/index.ts
   - src/routes/auth.routes.ts
   - src/services/profile.service.ts
   - src/jobs/music-sync.job.ts
   - package.json

2. Make sure your .env has:
   FRONTEND_URL=http://localhost:3000   (or wherever your Next.js app runs)
   PORT=4000                            (optional, defaults to 4000)

3. Run: npm install  (to get bullmq and ioredis)

4. Restart the server: npm run dev

5. Try logging in again. After ~30 seconds, refresh the dashboard.
