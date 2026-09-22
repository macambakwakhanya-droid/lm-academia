// api/lm-feed-videos.js
//
// POST { interests: string[], pageTokens?: { [interest]: string } }
//   -> { videos: [{ videoId, title, channel, thumbnail }], nextPageTokens: { [interest]: string } }
//   -> { notConfigured: true }  when YOUTUBE_API_KEY isn't set
//
// Called once with no pageTokens for the first batch, then again with
// whatever nextPageTokens came back to load more (infinite scroll).
//
// Each interest is searched as Shorts first. Real, honest infinite scroll
// eventually runs a topic's short-form supply dry — YouTube's Shorts
// catalog for a niche query (e.g. "related rates calculus") is finite.
// There's no public search API for TikTok content to fall back to (their
// real content-search API is restricted to approved research partners,
// so it isn't something we can wire in here). Instead, once an interest's
// Shorts are exhausted this cascades that interest to medium-length, then
// any-length YouTube videos, so a topic keeps producing results instead
// of just stopping. The `nextPageTokens[interest]` value the client holds
// onto encodes which tier it's currently in ("short:<token>",
// "medium:<token>", "any:<token>" or a bare "medium:"/"any:" to start a
// tier fresh) — opaque to the client, which just echoes it back.

const YOUTUBE_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const RESULTS_PER_INTEREST = 6;
const MAX_INTERESTS = 8;
const DURATION_TIERS = ['short', 'medium', 'any']; // 'any' omits videoDuration entirely

async function searchYouTube(apiKey, interest, duration, pageToken){
  const params = new URLSearchParams({
    key: apiKey,
    part: 'snippet',
    type: 'video',
    order: 'relevance',
    safeSearch: 'strict',
    maxResults: String(RESULTS_PER_INTEREST),
    q: interest
  });
  if(duration !== 'any') params.set('videoDuration', duration);
  if(pageToken) params.set('pageToken', pageToken);

  const r = await fetch(`${YOUTUBE_SEARCH_URL}?${params.toString()}`);
  const data = await r.json();
  if(!r.ok){
    throw new Error((data && data.error && data.error.message) || `YouTube error ${r.status}`);
  }
  const videos = (data.items || [])
    .filter(item => item.id && item.id.videoId)
    .map(item => {
      const thumbs = item.snippet.thumbnails || {};
      const thumb = thumbs.medium || thumbs.high || thumbs.default || {};
      return {
        videoId: item.id.videoId,
        title: item.snippet.title,
        channel: item.snippet.channelTitle,
        thumbnail: thumb.url || ''
      };
    });
  return { videos, nextPageToken: data.nextPageToken || null };
}

// "tier:token" -> {tier, token}; bare/legacy token -> tier 'short'; empty/missing -> tier 'short', no token
function parseState(raw){
  if(typeof raw !== 'string' || !raw) return { tier: DURATION_TIERS[0], token: undefined };
  const i = raw.indexOf(':');
  if(i === -1) return { tier: DURATION_TIERS[0], token: raw };
  const tier = raw.slice(0, i);
  const token = raw.slice(i + 1) || undefined;
  return { tier: DURATION_TIERS.includes(tier) ? tier : DURATION_TIERS[0], token };
}

async function fetchInterestCascading(apiKey, interest, rawState){
  const { tier, token } = parseState(rawState);
  let tierIdx = DURATION_TIERS.indexOf(tier);

  // Try the requested tier; if it comes back with nothing, cascade forward
  // through the wider tiers in this SAME request so the client never gets
  // handed a dry page while a wider tier still has results.
  for(; tierIdx < DURATION_TIERS.length; tierIdx++){
    const curTier = DURATION_TIERS[tierIdx];
    let result;
    try{
      result = await searchYouTube(apiKey, interest, curTier, curTier === tier ? token : undefined);
    }catch(e){
      console.error('YouTube fetch failed for', interest, curTier, e);
      result = { videos: [], nextPageToken: null };
    }
    if(result.videos.length){
      const nextState = result.nextPageToken
        ? `${curTier}:${result.nextPageToken}`
        : (tierIdx + 1 < DURATION_TIERS.length ? `${DURATION_TIERS[tierIdx + 1]}:` : null);
      return { interest, videos: result.videos, nextState };
    }
    // nothing at this tier — fall through and try the next, wider one
  }
  return { interest, videos: [], nextState: null };
}

module.exports = async (req, res) => {
  if(req.method !== 'POST'){
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if(!apiKey){
    res.status(200).json({ notConfigured: true });
    return;
  }

  let body = req.body;
  if(typeof body === 'string'){
    try{ body = JSON.parse(body); }catch(e){ body = {}; }
  }
  body = body || {};

  const interests = Array.isArray(body.interests)
    ? body.interests.filter(x => typeof x === 'string' && x.trim()).slice(0, MAX_INTERESTS)
    : [];
  const pageTokens = (body.pageTokens && typeof body.pageTokens === 'object') ? body.pageTokens : {};

  if(!interests.length){
    res.status(200).json({ videos: [], nextPageTokens: {} });
    return;
  }

  const perInterest = await Promise.all(
    interests.map(q => fetchInterestCascading(apiKey, q, pageTokens[q]))
  );

  // Round-robin across interests instead of dumping one interest's whole
  // batch before the next, so the grid stays mixed as you scroll.
  const merged = [];
  const maxLen = perInterest.reduce((m, r) => Math.max(m, r.videos.length), 0);
  for(let i = 0; i < maxLen; i++){
    for(const r of perInterest) if(r.videos[i]) merged.push(r.videos[i]);
  }

  const nextPageTokens = {};
  perInterest.forEach(r => { if(r.nextState) nextPageTokens[r.interest] = r.nextState; });

  res.status(200).json({ videos: merged, nextPageTokens });
};
