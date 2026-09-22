// api/lm-feed-videos.js
// Backend for the "LM Live" tab's video panel.
// Searches YouTube for the student's chosen interests and returns real
// results only. If no key is configured, it says so honestly instead of
// returning fake or empty-looking data.
//
// Env vars:
//   YOUTUBE_API_KEY (required — get one in Google Cloud Console, "YouTube Data API v3")

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    // Not an error — the frontend checks this flag and shows an honest
    // "not configured" message rather than treating it as a failure.
    return res.status(200).json({ notConfigured: true, videos: [] });
  }

  const { interests } = req.body || {};
  const list = Array.isArray(interests) ? interests.filter(Boolean).slice(0, 6) : [];
  if (!list.length) {
    return res.status(200).json({ videos: [] });
  }

  try {
    const perQuery = Math.max(1, Math.floor(9 / list.length));
    const results = await Promise.all(
      list.map(async q => {
        const url =
          'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=relevance' +
          '&videoDuration=short&relevanceLanguage=en&maxResults=' +
          perQuery +
          '&q=' +
          encodeURIComponent(q) +
          '&key=' +
          encodeURIComponent(apiKey);
        const r = await fetch(url);
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          console.error('YouTube search failed for', q, data?.error?.message);
          return [];
        }
        return (data.items || []).map(it => ({
          videoId: it.id?.videoId,
          title: it.snippet?.title,
          channel: it.snippet?.channelTitle,
          publishedAt: it.snippet?.publishedAt,
          thumbnail: it.snippet?.thumbnails?.medium?.url || it.snippet?.thumbnails?.default?.url || ''
        })).filter(v => v.videoId);
      })
    );

    const seen = new Set();
    const videos = [];
    results.flat().forEach(v => {
      if (!seen.has(v.videoId)) { seen.add(v.videoId); videos.push(v); }
    });
    videos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    return res.status(200).json({ videos: videos.slice(0, 12) });
  } catch (error) {
    console.error('LM Feed Videos error:', error);
    return res.status(500).json({ error: error?.message || 'video search failed' });
  }
}
