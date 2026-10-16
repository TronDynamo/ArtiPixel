// Vercel serverless function: lets ArtiPixel villagers talk with real AI.
// Needs ANTHROPIC_API_KEY set in Vercel > Project > Settings > Environment Variables.
const MODEL = process.env.ARTIPIXEL_MODEL || 'claude-haiku-5-5';
const hits = new Map(); // light per-IP rate limit (per warm instance)

function limited(ip) {
  const now = Date.now(), win = 60_000, max = 30;
  const h = (hits.get(ip) || []).filter(t => now - t < win);
  h.push(now); hits.set(ip, h);
  if (hits.size > 5000) hits.clear();
  return h.length > max;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(503).json({ error: 'no_key' });

  const host = req.headers.host || '';
  const origin = req.headers.origin || req.headers.referer || '';
  if (origin && host && !origin.includes(host)) return res.status(403).json({ error: 'forbidden' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
  if (limited(ip)) return res.status(429).json({ error: 'slow down' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const raw = body && Array.isArray(body.messages) ? body.messages.slice(-24) : null;
  if (!raw || !raw.length) return res.status(400).json({ error: 'messages required' });

  // Clean up: string content only, capped length, merge same-role turns, start with user.
  const msgs = [];
  for (const m of raw) {
    const role = m && m.role === 'assistant' ? 'assistant' : 'user';
    const content = String((m && m.content) || '').slice(0, 6000);
    if (!content.trim()) continue;
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content += '\n' + content;
    else msgs.push({ role, content });
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return res.status(400).json({ error: 'bad messages' });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        system: 'You voice characters in ArtiPixel, a cozy PG pixel-art life-sim. Stay in character and follow the character instructions in the conversation. Characters can chat about any topic the player brings up, in their own voice. Keep it PG. Never write code.',
        messages: msgs
      })
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: (j && j.error && j.error.message) || 'upstream error' });
    const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(502).json({ error: 'upstream unreachable' });
  }
};
