import { query, queryOne } from '../db/client';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const safeJson = (v: any, fallback: any = []) => {
  if (!v) return fallback;
  try { return typeof v === 'string' ? JSON.parse(v) : v; }
  catch { return fallback; }
};

// Genre similarity — Weighted Jaccard
function genreSimilarity(gA: any[], gB: any[]): number {
  if (!gA.length || !gB.length) return 0;
  const mA = new Map(gA.map((g: any) => [g.genre?.toLowerCase(), g.weight ?? 0]));
  const mB = new Map(gB.map((g: any) => [g.genre?.toLowerCase(), g.weight ?? 0]));
  const all = new Set([...mA.keys(), ...mB.keys()]);
  let num = 0, den = 0;
  for (const g of all) {
    const wA = mA.get(g) ?? 0, wB = mB.get(g) ?? 0;
    num += Math.min(wA, wB);
    den += Math.max(wA, wB);
  }
  return den === 0 ? 0 : num / den;
}

// Artist overlap — rank-weighted
function artistOverlap(aA: any[], aB: any[]): { score: number; sharedArtists: string[] } {
  if (!aA.length || !aB.length) return { score: 0, sharedArtists: [] };
  const rw = (i: number) => 1 / Math.sqrt(i + 1);
  const mA = new Map(aA.map((a: any, i: number) => [a.id, { name: a.name, w: rw(i) }]));
  const mB = new Map(aB.map((a: any, i: number) => [a.id, { name: a.name, w: rw(i) }]));
  const shared: string[] = [];
  let score = 0;
  for (const [id, { name, w: wA }] of mA) {
    const b = mB.get(id);
    if (b) { shared.push(name); score += (2 * wA * b.w) / (wA + b.w); }
  }
  let maxP = 0;
  for (let i = 0; i < Math.min(aA.length, aB.length); i++) maxP += rw(i);
  return { score: maxP === 0 ? 0 : Math.min(score / maxP, 1), sharedArtists: shared };
}

// Mood similarity — Euclidean distance on audio features
function moodSimilarity(fA: any, fB: any): number {
  if (!fA || !fB) return 0;
  const dims = ['energy', 'valence', 'danceability', 'acousticness', 'instrumentalness'];
  let sumSq = 0;
  for (const d of dims) {
    const delta = (fA[d] ?? 0.5) - (fB[d] ?? 0.5);
    sumSq += delta * delta;
  }
  return Math.max(0, 1 - Math.sqrt(sumSq) / Math.sqrt(dims.length));
}

// Pattern similarity — cosine on 24h listening histogram
function patternSimilarity(hA: number[], hB: number[]): number {
  if (!Array.isArray(hA) || !Array.isArray(hB) || hA.length !== 24 || hB.length !== 24) return 0;
  const magA = Math.sqrt(hA.reduce((s, v) => s + v * v, 0));
  const magB = Math.sqrt(hB.reduce((s, v) => s + v * v, 0));
  if (!magA || !magB) return 0;
  let dot = 0;
  for (let i = 0; i < 24; i++) dot += hA[i] * hB[i];
  return dot / (magA * magB);
}

// ─── Main score computation ───────────────────────────────────────────────────

function computeCompatibility(pA: any, pB: any) {
  const weights = { genre: 0.30, artist: 0.30, mood: 0.20, pattern: 0.20 };

  const genresA   = safeJson(pA.top_genres);
  const genresB   = safeJson(pB.top_genres);
  const artistsA  = safeJson(pA.top_artists_medium);
  const artistsB  = safeJson(pB.top_artists_medium);
  const featA     = safeJson(pA.audio_features_avg, {});
  const featB     = safeJson(pB.audio_features_avg, {});
  const hoursA    = pA.listening_hours ?? [];
  const hoursB    = pB.listening_hours ?? [];

  const genreRaw                       = genreSimilarity(genresA, genresB);
  const { score: artistRaw, sharedArtists } = artistOverlap(artistsA, artistsB);
  const moodRaw                        = moodSimilarity(featA, featB);
  const patternRaw                     = patternSimilarity(hoursA, hoursB);

  const totalRaw = weights.genre * genreRaw + weights.artist * artistRaw
                 + weights.mood  * moodRaw  + weights.pattern * patternRaw;

  const pct = (v: number) => Math.round(v * 1000) / 10;

  const setA = new Set(genresA.map((g: any) => g.genre?.toLowerCase()));
  const sharedGenres = genresB
    .filter((g: any) => setA.has(g.genre?.toLowerCase()))
    .map((g: any) => g.genre)
    .slice(0, 10);

  return {
    totalScore:   pct(totalRaw),
    genreScore:   pct(genreRaw),
    artistScore:  pct(artistRaw),
    moodScore:    pct(moodRaw),
    patternScore: pct(patternRaw),
    sharedArtists,
    sharedGenres,
  };
}

// ─── DB functions ─────────────────────────────────────────────────────────────

export async function upsertCompatibilityScore(userIdX: string, userIdY: string): Promise<any> {
  const [userAId, userBId] = userIdX < userIdY ? [userIdX, userIdY] : [userIdY, userIdX];

  const [profileA, profileB] = await Promise.all([
    queryOne('SELECT * FROM music_profiles WHERE user_id = $1', [userAId]),
    queryOne('SELECT * FROM music_profiles WHERE user_id = $1', [userBId]),
  ]);
  if (!profileA || !profileB) return null;

  const r = computeCompatibility(profileA, profileB);
  const [row] = await query(
    `INSERT INTO compatibility_scores
       (user_a_id, user_b_id, total_score, genre_score, artist_score,
        mood_score, pattern_score, shared_artists, shared_genres, calculated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT (user_a_id, user_b_id) DO UPDATE SET
       total_score=$3, genre_score=$4, artist_score=$5,
       mood_score=$6, pattern_score=$7,
       shared_artists=$8, shared_genres=$9, calculated_at=NOW()
     RETURNING *`,
    [userAId, userBId, r.totalScore, r.genreScore, r.artistScore,
     r.moodScore, r.patternScore, r.sharedArtists, r.sharedGenres]
  );
  return row;
}

export async function getCompatibilityScore(userIdX: string, userIdY: string): Promise<any> {
  const [a, b] = userIdX < userIdY ? [userIdX, userIdY] : [userIdY, userIdX];
  return queryOne(
    'SELECT * FROM compatibility_scores WHERE user_a_id = $1 AND user_b_id = $2',
    [a, b]
  );
}

export async function getTopMatches(userId: string, limit = 20, minScore = 30): Promise<any[]> {
  return query(
    `SELECT
       cs.*,
       CASE WHEN cs.user_a_id=$1 THEN ub.display_name ELSE ua.display_name END AS display_name,
       CASE WHEN cs.user_a_id=$1 THEN ub.avatar_url   ELSE ua.avatar_url   END AS avatar_url,
       CASE WHEN cs.user_a_id=$1 THEN ub.id           ELSE ua.id           END AS matched_user_id,
       CASE WHEN cs.user_a_id=$1 THEN ubp.personality_type ELSE uap.personality_type END AS personality_type,
       CASE WHEN cs.user_a_id=$1 THEN ubp.top_genres  ELSE uap.top_genres  END AS top_genres
     FROM compatibility_scores cs
     JOIN users ua  ON ua.id  = cs.user_a_id
     JOIN users ub  ON ub.id  = cs.user_b_id
     LEFT JOIN music_profiles uap ON uap.user_id = cs.user_a_id
     LEFT JOIN music_profiles ubp ON ubp.user_id = cs.user_b_id
     WHERE (cs.user_a_id=$1 OR cs.user_b_id=$1)
       AND cs.total_score >= $2
     ORDER BY cs.total_score DESC
     LIMIT $3`,
    [userId, minScore, limit]
  );
}

export async function computeScoresForNewUser(newUserId: string, chunkSize = 50): Promise<number> {
  const others = await query<{ id: string }>('SELECT id FROM users WHERE id != $1', [newUserId]);
  let computed = 0;
  for (let i = 0; i < others.length; i += chunkSize) {
    await Promise.allSettled(
      others.slice(i, i + chunkSize).map(({ id }) => upsertCompatibilityScore(newUserId, id))
    );
    computed += Math.min(chunkSize, others.length - i);
  }
  return computed;
}
