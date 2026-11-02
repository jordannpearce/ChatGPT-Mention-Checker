// ChatGPT Mention Checker — PUBLIC, BYO DataForSEO key (visitors test their own brands)
// Two modes:
//  1) Prompt Checker  -> POST /v3/ai_optimization/chat_gpt/llm_responses/live
//     You supply prompts; we run them live through ChatGPT and scan each answer
//     for your brand mention + your domain citation, plus competitors.
//  2) Mentions Explorer -> POST /v3/ai_optimization/llm_mentions/search_mentions/live
//     Searches DataForSEO's database of real user prompts/answers for prompts
//     where your domain/keyword appears — i.e. what prompts users actually used.
// Zero dependencies. Node 18+. Run: node server.js  (PORT env, default 3456)
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3456;
const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

// PUBLIC version: visitors use their OWN DataForSEO credentials, sent per request
// through this proxy and NEVER stored on the server (no file, no logs).
// Optional env DATAFORSEO_LOGIN/PASSWORD = owner-managed mode (owner pays) — off by default.
function loadCreds(bodyCreds) {
  if (process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD)
    return { login: process.env.DATAFORSEO_LOGIN, password: process.env.DATAFORSEO_PASSWORD, source: 'env' };
  if (bodyCreds && bodyCreds.login && bodyCreds.password)
    return { login: String(bodyCreds.login), password: String(bodyCreds.password), source: 'visitor' };
  return null;
}
// Simple in-memory rate limit per IP (runs/hour)
const RL = new Map();
function rateLimited(ip) {
  const now = Date.now(), win = 3600e3, max = 30;
  const arr = (RL.get(ip) || []).filter(t => now - t < win);
  arr.push(now); RL.set(ip, arr);
  return arr.length > max;
}
function saveLead(lead, detail) {
  if (!lead || !lead.email) return;
  let l = []; try { l = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); } catch {}
  l.unshift({ at: new Date().toISOString(), name: lead.name || '', email: lead.email, business: lead.business || '', ...detail });
  try { fs.writeFileSync(LEADS_FILE, JSON.stringify(l.slice(0, 5000), null, 2)); } catch {}
}
function dfs(pathname, creds, payload) {
  return new Promise((resolve, reject) => {
    const data = payload === null ? '' : JSON.stringify(payload);
    const auth = Buffer.from(`${creds.login}:${creds.password}`).toString('base64');
    const req = https.request({
      hostname: 'api.dataforseo.com', path: pathname, method: payload === null ? 'GET' : 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data || '') },
      timeout: 130000,
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => { try { resolve({ http: res.statusCode, json: JSON.parse(buf) }); } catch { resolve({ http: res.statusCode, json: null, raw: buf.slice(0, 500) }); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('DataForSEO request timed out (130s)')));
    if (payload !== null) req.write(data);
    req.end();
  });
}
function send(res, code, obj, type = 'application/json') {
  const body = type === 'application/json' ? JSON.stringify(obj) : obj;
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', d => { b += d; if (b.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('Invalid JSON body')); } });
    req.on('error', reject);
  });
}
const esc = s => String(s || '').toLowerCase();

// ---------- mention analysis (shared, pure) ----------
function analyzeAnswer(text, brand, domain, competitors) {
  const low = esc(text);
  const out = { brand_mentioned: false, brand_count: 0, brand_first_index: -1, domain_cited: false, competitors: {} };
  if (brand) {
    let i = low.indexOf(esc(brand)); out.brand_first_index = i;
    while (i !== -1) { out.brand_count++; i = low.indexOf(esc(brand), i + 1); }
    out.brand_mentioned = out.brand_count > 0;
  }
  (competitors || []).forEach(c => {
    if (!c) return; let n = 0, i = low.indexOf(esc(c));
    while (i !== -1) { n++; i = low.indexOf(esc(c), i + 1); }
    out.competitors[c] = n;
  });
  return out;
}
function parseLlmResponse(task) {
  const r = (task.result && task.result[0]) || {};
  const items = r.items || [];
  let text = '';
  const annotations = [];
  for (const it of items) for (const s of (it.sections || [])) {
    if (s.text) text += (text ? '\n\n' : '') + s.text;
    for (const a of (s.annotations || [])) annotations.push({ title: a.title || '', url: a.url || '' });
  }
  const searchResults = (r.search_results || []).map(s => ({ title: s.title || '', url: s.url || '' }));
  return { model: r.model_name || '', input_tokens: r.input_tokens || 0, output_tokens: r.output_tokens || 0,
    money_spent: r.money_spent || task.cost || 0, text, annotations, search_results: searchResults,
    fan_out_queries: r.fan_out_queries || [] };
}
function domainInUrls(domain, urls) {
  if (!domain) return false;
  const d = esc(domain).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  return urls.some(u => esc(u.url).includes(d));
}

// ---------- DEMO data (clearly flagged; never presented as live) ----------
function demoPromptResult(prompt, brand, domain, competitors) {
  const b = brand || 'Your Brand';
  const mentioned = /best|recommend|top|which|compare/i.test(prompt);
  const text = mentioned
    ? `Here are strong options for that need:\n\n1. **${b}** — a popular choice known for hands-on service and clear pricing.\n2. Competitor examples and national chains round out the list.\n\nFor local work, ${b} is frequently recommended because of reviews and response time.`
    : `That topic covers general background information. Several national providers are discussed, along with guides and directories. No specific local brand is named in this overview.`;
  const annotations = mentioned ? [{ title: `${b} — official site`, url: `https://${(domain || 'example.com').replace(/^https?:\/\//,'')}/` }, { title: 'Industry guide', url: 'https://example.org/guide' }] : [{ title: 'Industry guide', url: 'https://example.org/guide' }];
  const a = analyzeAnswer(text, brand, domain, competitors);
  a.domain_cited = domainInUrls(domain, annotations);
  return { prompt, demo: true, model: 'demo', input_tokens: 0, output_tokens: 0, money_spent: 0, text, annotations, search_results: [], fan_out_queries: [prompt], ...a };
}
function demoMentions(targetVal) {
  const v = targetVal || 'your brand';
  const mk = (q, vol, cited) => ({ platform: 'chat_gpt', model_name: 'gpt-5', question: q,
    answer: `People asking this often get a list of providers. **${v}** appears in this demo answer${cited ? ' and its site is cited as a source' : ''}. (Demo data — connect a DataForSEO key for real prompts.)`,
    sources: cited ? [{ title: `${v} — site`, domain: String(v).includes('.') ? v : 'example.com', url: `https://${String(v).includes('.') ? v : 'example.com'}/`, rank: 1 }] : [{ title: 'Directory', domain: 'example.org', url: 'https://example.org/', rank: 1 }],
    ai_search_volume: vol, monthly_searches: [{ year: 2026, month: 10, search_volume: vol }], first_response_at: '2026-09-01 00:00:00 +00:00', last_response_at: '2026-11-01 00:00:00 +00:00' });
  return { total_count: 3, items: [mk(`what is the best provider for ${v}?`, 12100, true), mk(`who would you recommend near me for this service?`, 8100, false), mk(`how much does this service usually cost?`, 5400, true)] };
}

function saveHistory(entry) { /* public version: history lives in the visitor's browser, not on the server */ }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/api/status' && req.method === 'GET') {
      const c = loadCreds(null);
      return send(res, 200, { ok: true, mode: c ? 'live' : 'demo', creds_source: c ? c.source : null, login_hint: c ? c.login.replace(/(^.).*(@.*$)/, '$1***$2') : null });
    }
    if (url.pathname === '/api/test-creds' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.login || !b.password) return send(res, 400, { error: 'Enter your DataForSEO API login and password.' });
      const r = await dfs('/v3/appendix/user_data', { login: String(b.login), password: String(b.password) }, null);
      if (!r.json || r.json.status_code !== 20000) return send(res, 400, { error: `DataForSEO rejected those credentials (${r.json ? r.json.status_code + ' ' + r.json.status_message : 'HTTP ' + r.http})` });
      const money = r.json.tasks?.[0]?.result?.[0]?.money?.balance;
      return send(res, 200, { ok: true, balance: money ?? null }); // tested only — nothing is stored
    }
    if (url.pathname === '/api/models' && (req.method === 'GET' || req.method === 'POST')) {
      const b = req.method === 'POST' ? await readBody(req) : {};
      const c = loadCreds(b.creds);
      if (!c) return send(res, 200, { demo: true, models: ['gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5'] });
      const r = await dfs('/v3/ai_optimization/chat_gpt/llm_responses/models', c, null);
      const items = r.json?.tasks?.[0]?.result || [];
      const models = items.map(m => m.model_name || m.id || m.name).filter(Boolean);
      return send(res, 200, { demo: false, models: models.length ? models : ['gpt-4o', 'gpt-4.1-mini', 'gpt-5'] });
    }
    // ---- Mode 1: run YOUR prompts live through ChatGPT ----
    if (url.pathname === '/api/prompt-check' && req.method === 'POST') {
      const b = await readBody(req);
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0];
      if (rateLimited(ip)) return send(res, 429, { error: 'Rate limit: 30 runs per hour. Please try again later.' });
      const prompts = (b.prompts || []).map(s => String(s).trim()).filter(Boolean).slice(0, 10);
      if (!prompts.length) return send(res, 400, { error: 'Add at least one prompt (one per line, up to 10 per run).' });
      const brand = String(b.brand || '').trim(), domain = String(b.domain || '').trim();
      const competitors = (b.competitors || []).map(s => String(s).trim()).filter(Boolean).slice(0, 10);
      const creds = loadCreds(b.creds);
      if (creds && creds.source === 'visitor' && !/^\S+@\S+\.\S+$/.test(String(b.lead?.email || '')))
        return send(res, 400, { error: 'Please add your name and a valid email above before running a live check — that is how you get your results summary.' });
      if (!creds) {
        const results = prompts.map(p => demoPromptResult(p, brand, domain, competitors));
        return send(res, 200, { demo: true, results });
      }
      const results = [];
      for (const prompt of prompts) {
        const payload = [{ user_prompt: prompt, model_name: b.model_name || 'gpt-4o', web_search: b.web_search !== false,
          ...(b.web_search_country_iso_code ? { web_search_country_iso_code: String(b.web_search_country_iso_code).toUpperCase() } : {}),
          ...(b.web_search_city ? { web_search_city: String(b.web_search_city) } : {}),
          max_output_tokens: Number(b.max_output_tokens) || 1024, temperature: 0.7 }];
        const r = await dfs('/v3/ai_optimization/chat_gpt/llm_responses/live', creds, payload);
        const task = r.json?.tasks?.[0];
        if (!r.json || r.json.status_code !== 20000 || !task || task.status_code !== 20000)
          { results.push({ prompt, error: `DataForSEO error: ${r.json ? r.json.status_code + ' ' + (task?.status_message || r.json.status_message) : 'HTTP ' + r.http}` }); continue; }
        const parsed = parseLlmResponse(task);
        const a = analyzeAnswer(parsed.text, brand, domain, competitors);
        a.domain_cited = domainInUrls(domain, [...parsed.annotations, ...parsed.search_results]);
        results.push({ prompt, ...parsed, ...a });
      }
      if (results.some(r => !r.error)) saveLead(b.lead, { mode: 'prompt-check', brand, domain, prompts_count: prompts.length, hit_rate: results.filter(r => r.brand_mentioned).length + '/' + results.length });
      return send(res, 200, { demo: false, results });
    }
    // ---- Mode 2: find REAL user prompts where you appear (LLM Mentions DB) ----
    if (url.pathname === '/api/mentions-search' && req.method === 'POST') {
      const b = await readBody(req);
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0];
      if (rateLimited(ip)) return send(res, 429, { error: 'Rate limit: 30 runs per hour. Please try again later.' });
      const value = String(b.target_value || '').trim();
      if (!value) return send(res, 400, { error: 'Enter a domain (e.g. yoursite.com) or a keyword/brand.' });
      const type = b.target_type === 'keyword' ? 'keyword' : 'domain';
      const creds = loadCreds(b.creds);
      if (creds && creds.source === 'visitor' && !/^\S+@\S+\.\S+$/.test(String(b.lead?.email || '')))
        return send(res, 400, { error: 'Please add your name and a valid email above before running a live search.' });
      if (!creds) { const d = demoMentions(value); return send(res, 200, { demo: true, ...d }); }
      const target = type === 'domain' ? [{ domain: value, search_scope: ['any'] }] : [{ keyword: value, search_scope: ['any'] }];
      const payload = [{ target, platform: b.platform === 'google' ? 'google' : 'chat_gpt',
        location_code: 2840, language_code: 'en', limit: Math.min(Math.max(Number(b.limit) || 25, 1), 100),
        order_by: ['ai_search_volume,desc'] }];
      const r = await dfs('/v3/ai_optimization/llm_mentions/search_mentions/live', creds, payload);
      const task = r.json?.tasks?.[0];
      if (!r.json || r.json.status_code !== 20000 || !task || task.status_code !== 20000)
        return send(res, 400, { error: `DataForSEO error: ${r.json ? r.json.status_code + ' ' + (task?.status_message || r.json.status_message) : 'HTTP ' + r.http}. Note: LLM Mentions needs an eligible DataForSEO account (see pricing page).` });
      const result = task.result?.[0] || {};
      const items = (result.items || []).map(it => {
        const sources = it.sources || [];
        const cited = type === 'domain' ? domainInUrls(value, sources) : false;
        return { platform: it.platform, model_name: it.model_name, question: it.question, answer: it.answer,
          sources, ai_search_volume: it.ai_search_volume || 0, monthly_searches: it.monthly_searches || [],
          first_response_at: it.first_response_at, last_response_at: it.last_response_at, cited };
      });
      saveLead(b.lead, { mode: 'mentions-search', target: value, target_type: type, total_count: result.total_count || items.length });
      return send(res, 200, { demo: false, total_count: result.total_count || items.length, cost: task.cost || r.json.cost || 0, items });
    }
    if (url.pathname === '/api/history' && req.method === 'GET') {
      return send(res, 200, { history: [], note: 'Public version: history is kept in the visitor browser only.' });
    }
    // static
    const file = url.pathname === '/' ? path.join(PUB, 'index.html') : path.join(PUB, path.normalize(url.pathname));
    if (!file.startsWith(PUB) || !fs.existsSync(file)) return send(res, 404, { error: 'Not found' });
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    return send(res, 200, fs.readFileSync(file), types[path.extname(file)] || 'text/plain');
  } catch (e) { return send(res, 500, { error: e.message }); }
});
server.listen(PORT, () => console.log(`ChatGPT Mention Checker (public) on http://localhost:${PORT} (owner-managed creds: ${loadCreds(null) ? 'ON' : 'off — visitors bring their own key; demo until they do'})`));
