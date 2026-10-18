// Vercel serverless function: lets ArtiPixel villagers talk with real AI.
// Works with an API key from ANY provider. Set ONE of these in Vercel > Project > Settings > Environment Variables:
//   AI_API_KEY          any key (Anthropic, OpenAI, Google Gemini, Groq, OpenRouter, xAI, DeepSeek, Mistral, Together...)
//   or a provider-specific name: ANTHROPIC_API_KEY, GEMINI_API_KEY (or GOOGLE_API_KEY), OPENAI_API_KEY, GROQ_API_KEY,
//   OPENROUTER_API_KEY, XAI_API_KEY, DEEPSEEK_API_KEY, MISTRAL_API_KEY, TOGETHER_API_KEY
// Optional: AI_BASE_URL (any OpenAI-compatible address, e.g. a local or company gateway) and AI_MODEL (or ARTIPIXEL_MODEL).
// The provider is detected from the key, and a fast chat model is picked from the provider's own model list.
const hits = new Map(); // light per-IP rate limit (per warm instance)

function limited(ip) {
  const now = Date.now(), win = 60_000, max = 30;
  const h = (hits.get(ip) || []).filter(t => now - t < win);
  h.push(now); hits.set(ip, h);
  if (hits.size > 5000) hits.clear();
  return h.length > max;
}

const PREFIX = [
  ['sk-ant-', 'anthropic', 'Anthropic'], ['sk-or-', 'https://openrouter.ai/api/v1', 'OpenRouter'],
  ['gsk_', 'https://api.groq.com/openai/v1', 'Groq'], ['AIza', 'https://generativelanguage.googleapis.com/v1beta/openai', 'Google Gemini'],
  ['xai-', 'https://api.x.ai/v1', 'xAI'], ['pplx-', 'https://api.perplexity.ai', 'Perplexity'], ['csk-', 'https://api.cerebras.ai/v1', 'Cerebras'],
  ['nvapi-', 'https://integrate.api.nvidia.com/v1', 'NVIDIA'], ['hf_', 'https://router.huggingface.co/v1', 'Hugging Face'],
  ['fw_', 'https://api.fireworks.ai/inference/v1', 'Fireworks'], ['sk-proj-', 'https://api.openai.com/v1', 'OpenAI']
];
const NAMED = [
  ['ANTHROPIC_API_KEY', 'anthropic'], ['GEMINI_API_KEY', 'https://generativelanguage.googleapis.com/v1beta/openai'],
  ['GOOGLE_API_KEY', 'https://generativelanguage.googleapis.com/v1beta/openai'], ['OPENAI_API_KEY', 'https://api.openai.com/v1'],
  ['GROQ_API_KEY', 'https://api.groq.com/openai/v1'], ['OPENROUTER_API_KEY', 'https://openrouter.ai/api/v1'], ['XAI_API_KEY', 'https://api.x.ai/v1'],
  ['DEEPSEEK_API_KEY', 'https://api.deepseek.com'], ['MISTRAL_API_KEY', 'https://api.mistral.ai/v1'], ['TOGETHER_API_KEY', 'https://api.together.xyz/v1']
];

function guess(key) {
  for (const [p, base] of PREFIX) if (key.startsWith(p)) return base;
  if (/^sk-[0-9a-f]{32}$/.test(key)) return 'https://api.deepseek.com';
  if (key.startsWith('sk-')) return 'https://api.openai.com/v1';
  if (/^[A-Za-z0-9]{32}$/.test(key)) return 'https://api.mistral.ai/v1';
  if (/^[0-9a-f]{64}$/.test(key)) return 'https://api.together.xyz/v1';
  return null;
}

function config() {
  const env = process.env;
  let key = (env.AI_API_KEY || '').trim(), base = (env.AI_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!key) for (const [name, b] of NAMED) if ((env[name] || '').trim()) { key = env[name].trim(); if (!base) base = b; break; }
  if (!key && !base) return null;
  if (base.includes('api.anthropic.com')) base = 'anthropic';
  if (!base) base = guess(key);
  if (!base) return { error: 'Could not tell which AI provider the key is for. Set AI_BASE_URL to the provider\'s API address.' };
  return { key, base, model: (env.AI_MODEL || env.ARTIPIXEL_MODEL || '').trim() };
}

const isGemini = c => c.base.includes('generativelanguage.googleapis.com') || c.key.startsWith('AIza');
const SKIP = ['embed', 'whisper', 'tts', 'dall-e', 'image', 'audio', 'moderation', 'realtime', 'transcribe', 'search', 'rerank', 'guard', 'vision-preview', 'babbage', 'davinci', 'computer-use', 'speech', 'veo', 'imagen', 'aqa', 'learnlm', 'ocr', '-instruct-', 'deep-research', 'sora', 'live', 'lyria', 'robotics', 'banana', 'diffusion'];
const unstable = id => /preview|exp|thinking|beta/i.test(id) ? 1 : 0;

async function listModels(c) {
  const native = c.base === 'anthropic';
  const r = await fetch(native ? 'https://api.anthropic.com/v1/models?limit=100' : c.base + '/models', { headers: authHeaders(c) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(errText(j, r.status));
  const gem = isGemini(c);
  let ids = ((j && (j.data || j.models)) || []).map(m => String(m.id || m.name || '')).filter(Boolean).map(id => gem ? id.replace(/^models\//, '') : id);
  ids = [...new Set(ids)].filter(id => { const l = id.toLowerCase(); return !SKIP.some(k => l.includes(k)) && !(gem && l.startsWith('gemma')); });
  const out = [];
  if (gem) for (const p of ['gemini-2.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash', 'gemini-2.0-flash-lite']) if (ids.includes(p)) out.push(p);
  const prefer = native ? ['haiku', 'sonnet', 'opus'] : ['flash-lite', 'flash', 'mini', 'haiku', 'small', 'instant', 'lite', 'turbo', 'chat', '8b', 'llama', 'gpt', 'gemini', 'mistral', 'deepseek', 'qwen'];
  for (const p of prefer) out.push(...ids.filter(id => id.toLowerCase().includes(p) && !out.includes(id)).sort((a, b) => unstable(a) - unstable(b) || (a < b ? 1 : a > b ? -1 : 0)));
  for (const id of ids) if (!out.includes(id)) out.push(id);
  if (!out.length) throw new Error('no chat models were listed for this key');
  return out;
}

function authHeaders(c) {
  if (c.base === 'anthropic') return { 'x-api-key': c.key, 'anthropic-version': '2023-06-01' };
  const h = c.key ? { authorization: 'Bearer ' + c.key } : {};
  if (c.base.includes('openrouter.ai')) { h['x-title'] = 'ArtiPixel'; h['http-referer'] = 'https://artipixel-two.vercel.app'; }
  return h;
}
function errText(j, code) {
  const e = Array.isArray(j) ? j[0] && j[0].error : j && j.error;
  const m = (e && (e.message || (typeof e === 'string' ? e : ''))) || (j && j.message) || '';
  return ('HTTP ' + code + (m ? ' ' + m : '')).slice(0, 300);
}
const keyRefused = m => /HTTP 40[13]\b|api key not valid|valid api key|invalid api key|api_key_invalid|incorrect api key|invalid x-api-key/i.test(m);

const SYSTEM = 'You voice characters in ArtiPixel, a cozy PG pixel-art life-sim. Stay in character and follow the character instructions in the conversation. Characters can chat about any topic the player brings up, in their own voice. Keep it PG. Never write code.';

async function chatOnce(c, model, msgs) {
  const native = c.base === 'anthropic';
  const body = native
    ? { model, max_tokens: 400, system: SYSTEM, messages: msgs }
    : { model, max_tokens: isGemini(c) ? 2048 : 400, messages: [{ role: 'system', content: SYSTEM }, ...msgs] };
  const r = await fetch(native ? 'https://api.anthropic.com/v1/messages' : c.base + '/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders(c) }, body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(errText(j, r.status));
  let text = native
    ? ((j && j.content) || []).filter(x => x.type === 'text').map(x => x.text).join('')
    : String((j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text) throw new Error('the reply was empty');
  return text;
}

let chosen = null; // model that last answered (per warm instance)
async function chat(c, msgs) {
  const first = c.model || chosen;
  let last = null;
  if (first) { try { const t = await chatOnce(c, first, msgs); chosen = first; return t; } catch (e) { last = e; if (keyRefused(e.message) || c.model) throw e; } }
  const cands = await listModels(c);
  let n = 0;
  for (const id of cands) {
    if (id === first) continue; if (++n > 6) break;
    try { const t = await chatOnce(c, id, msgs); chosen = id; return t; }
    catch (e) { last = e; if (keyRefused(e.message)) break; }
  }
  throw last || new Error('no model answered');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const c = config();
  if (!c) return res.status(503).json({ error: 'no_key' });
  if (c.error) return res.status(503).json({ error: c.error });

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
    const text = await chat(c, msgs);
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(502).json({ error: (e && e.message) || 'upstream error' });
  }
};
