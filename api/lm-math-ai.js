// api/lm-math-ai.js — Vercel serverless function (Node 18+, no extra deps)
// Same pattern as VAULT's /api/ai-curriculum-lab: the Gemini key lives
// server-side in process.env.GEMINI_API_KEY and is never in the HTML.
//
// Accepts POST JSON:
//   { prompt: string, context?: string, images?: string[] }
// where images are dataURLs ("data:image/png;base64,....").
// Returns: { text: string }
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { prompt, context, images } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not set on the server' });

  const parts = [];
  if (context) {
    parts.push({ text: "Excerpts from the student's own uploaded material (may or may not be relevant):\n" + context });
  }
  parts.push({ text: prompt });
  for (const d of (images || [])) {
    const m = /^data:image\/(\w+);base64,(.+)$/.exec(d || '');
    if (m) parts.push({ inline_data: { mime_type: 'image/' + m[1], data: m[2] } });
  }

  const r = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + encodeURIComponent(apiKey),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature: 0.3 }
      })
    }
  );
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return res.status(r.status).json({ error: (data.error && data.error.message) || 'Gemini request failed' });

  const text = ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [])
    .map(p => p.text).join('').trim();
  if (!text) return res.status(500).json({ error: 'empty completion' });

  return res.status(200).json({ text });
}
