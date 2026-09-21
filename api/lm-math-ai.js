// api/lm-math-ai.js
// LM Personal System AI backend
// Gemini API key stays server-side in Vercel.

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'POST only'
    });
  }

  const { prompt, context, images } = req.body || {};

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({
      error: 'prompt required'
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY is not configured in the LM Personal System Vercel project.'
    });
  }

  const parts = [];

  if (context) {
    parts.push({
      text:
        "Excerpts from the student's own uploaded material. " +
        "Use these when relevant:\n\n" +
        String(context)
    });
  }

  parts.push({
    text: String(prompt)
  });

  for (const image of Array.isArray(images) ? images : []) {
    const match =
      /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(image || '');

    if (!match) continue;

    parts.push({
      inline_data: {
        mime_type: match[1],
        data: match[2]
      }
    });
  }

  try {
    const geminiRes = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=' +
        encodeURIComponent(apiKey),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [
            {
              parts
            }
          ],
          generationConfig: {
            temperature: 0.3
          }
        })
      }
    );

    const data = await geminiRes.json().catch(() => ({}));

    if (!geminiRes.ok) {
      return res.status(502).json({
        error:
          data?.error?.message ||
          `Gemini request failed (${geminiRes.status})`
      });
    }

    const text =
      (data?.candidates?.[0]?.content?.parts || [])
        .map(part => part?.text || '')
        .join('')
        .trim();

    if (!text) {
      return res.status(502).json({
        error: 'Gemini returned an empty response.'
      });
    }

    return res.status(200).json({
      text
    });

  } catch (error) {
    console.error('LM Math AI error:', error);

    return res.status(500).json({
      error: error?.message || 'AI request failed'
    });
  }
}
