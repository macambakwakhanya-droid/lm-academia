// api/lm-math-ai.js
// LM Personal System AI backend
// Gemini API key stays server-side in Vercel.
//
// Request body:
//   prompt        (string, required)
//   context       (string, optional)  excerpts from the student's uploads
//   images        (string[], optional) data: URLs
//   codeExecution (bool, optional)    let the model run Python for calculations
//   json          (bool, optional)    ask for a JSON-only reply
//   thinking      ('low'|'medium'|'high', optional, default 'high')
//
// Env vars:
//   GEMINI_API_KEY (required)
//   GEMINI_MODEL   (optional, default 'gemini-3.8-flash'; 'gemini-3.6-flash' also works)

const DEFAULT_MODEL = 'gemini-3.8-flash';
// If the primary model is overloaded (503/429) or missing, try these in order.
const FALLBACK_MODELS = ['gemini-3.7-flash', 'gemini-3.6-flash'];

// Thinking + code execution can take a while; ask Vercel for a longer limit.
export const config = { maxDuration: 60 };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export default async function handler(req, res) {
  // CORS headers must be on EVERY response, not just the preflight, or a
  // browser on another origin (e.g. GitHub Pages) blocks the real reply.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const { prompt, context, images, codeExecution, json, thinking } = req.body || {};

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt required' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY is not configured in the LM Personal System Vercel project.'
    });
  }

  const primary = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const models = [primary, ...FALLBACK_MODELS.filter(m => m !== primary)];
  const level = ['low', 'medium', 'high'].includes(thinking) ? thinking : 'high';

  const parts = [];
  if (context) {
    parts.push({
      text:
        "The student's own LM tracker data (profile, calendar, quiz results, uploaded library, saved notes, workspace state, earlier questions). " +
        'Use it when relevant, and ignore it when it is not:\n\n' +
        String(context)
    });
  }
  parts.push({ text: String(prompt) });

  for (const image of Array.isArray(images) ? images : []) {
    const match = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(image || '');
    if (!match) continue;
    parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
  }

  // Note: no `temperature` here. Google's Gemini 3.x guidance is to leave
  // sampling parameters at their defaults, and low values can hurt reasoning.
  function buildBody(withThinking) {
    const generationConfig = {};
    if (withThinking) generationConfig.thinkingConfig = { thinkingLevel: level };
    // Structured JSON output can't be combined with code execution, so JSON wins.
    if (json) generationConfig.responseMimeType = 'application/json';
    const body = { contents: [{ parts }], generationConfig };
    if (codeExecution && !json) body.tools = [{ code_execution: {} }];
    return body;
  }

  async function callGemini(model, body) {
    const r = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' +
        encodeURIComponent(model) +
        ':generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify(body)
      }
    );
    const data = await r.json().catch(() => ({}));
    return { r, data };
  }

  const isOverloaded = (r, data) =>
    r.status === 429 || r.status === 500 || r.status === 503 || r.status === 504 ||
    /high demand|overloaded|unavailable|try again later/i.test(data?.error?.message || '');

  async function callWithFallback() {
    let last = null;
    for (const m of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        let { r, data } = await callGemini(m, buildBody(true));
        // If the API rejects the thinking setting for this model, retry without it.
        if (!r.ok && r.status === 400 && /think/i.test(data?.error?.message || '')) {
          ({ r, data } = await callGemini(m, buildBody(false)));
        }
        last = { r, data, model: m };
        if (r.ok) return last;
        if (r.status === 404) break;                 // model not available: next model
        if (!isOverloaded(r, data)) return last;     // real error (bad request etc.): stop
        if (attempt === 0) await sleep(1500);        // brief pause, then one retry
      }
    }
    return last;
  }

  try {
    const { r, data, model } = await callWithFallback();

    if (!r.ok) {
      const status = r.status === 429 ? 429 : isOverloaded(r, data) ? 503 : 502;
      return res.status(status).json({
        error: data?.error?.message || `Gemini request failed (${r.status})`
      });
    }

    // Only the model's written text; code the model ran internally is skipped.
    const text = (data?.candidates?.[0]?.content?.parts || [])
      .filter(part => !part?.thought)
      .map(part => part?.text || '')
      .join('')
      .trim();

    if (!text) {
      return res.status(502).json({ error: 'Gemini returned an empty response.' });
    }

    return res.status(200).json({ text, model });
  } catch (error) {
    console.error('LM Math AI error:', error);
    return res.status(500).json({ error: error?.message || 'AI request failed' });
  }
}
