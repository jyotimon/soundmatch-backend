const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

async function askGemini(prompt: string): Promise<string> {
  try {
    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 250,
          temperature: 0.8,
        }
      })
    });

    if (!response.ok) {
      console.error('[gemini] API error:', response.status);
      return '';
    }

    const data = await response.json() as any;
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  } catch (err) {
    console.error('[gemini] Failed:', (err as Error).message);
    return '';
  }
}

function safeJson(v: any, fallback: any = []) {
  if (!v) return fallback;
  try { return typeof v === 'string' ? JSON.parse(v) : v; }
  catch { return fallback; }
}

export async function generateMusicPersona(profile: any): Promise<string> {
  const genres = safeJson(profile.top_genres, [])
    .slice(0, 8).map((g: any) => g.genre).filter(Boolean).join(', ');

  const artists = safeJson(profile.top_artists_medium, [])
    .slice(0, 6).map((a: any) => a.name).filter(Boolean).join(', ');

  const prompt = `You are a music psychologist writing poetic, insightful listener profiles.

A user's music profile:
- Personality type: ${profile.personality_type}
- Top genres: ${genres || 'not available'}
- Top artists: ${artists || 'not available'}

Write 2-3 sentences describing their music taste and what it reveals about them as a person.
Be poetic but specific. Reference their actual artists and genres where possible.
Write in second person ("You..."). No clichés. Keep it under 70 words.
Return only the description, no quotes, no preamble.`;

  return askGemini(prompt);
}

export async function generateCompatibilityInsight(
  profileA: any,
  profileB: any,
  score: any
): Promise<string> {
  const artistsA = safeJson(profileA.top_artists_medium, [])
    .slice(0, 5).map((a: any) => a.name).filter(Boolean).join(', ');

  const artistsB = safeJson(profileB.top_artists_medium, [])
    .slice(0, 5).map((a: any) => a.name).filter(Boolean).join(', ');

  const shared = (score.shared_artists ?? []).slice(0, 4).join(', ');

  const prompt = `You are a music compatibility analyst.

Person A: ${profileA.personality_type}, listens to ${artistsA || 'various artists'}
Person B: ${profileB.personality_type}, listens to ${artistsB || 'various artists'}
Shared artists: ${shared || 'none yet'}
Compatibility score: ${score.total_score}%

Write 2-3 sentences explaining why these two people are or aren't musically compatible.
Be specific about their artists and personality types.
Address Person A directly ("You and...").
Keep it under 80 words.
Return only the insight, no quotes, no preamble.`;

  return askGemini(prompt);
}

export async function generatePlaylistName(
  personalityA: string,
  personalityB: string,
  sharedArtists: string[]
): Promise<string> {
  const artists = sharedArtists.slice(0, 3).join(', ');

  const prompt = `Create a creative, poetic playlist name for two people with these music personalities:
Person A: ${personalityA}
Person B: ${personalityB}
${artists ? `Shared artists: ${artists}` : ''}

The name should be evocative and feel like it belongs on Spotify.
Examples of good names: "Midnight Philosophers", "Between Two Worlds", "Where the Rhythm Lives"
Return only the playlist name, nothing else. Maximum 5 words.`;

  const result = await askGemini(prompt);
  return result.trim() || 'Our Shared Sound';
}