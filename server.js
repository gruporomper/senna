const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { routeMessage, parsePrefix, classifyComplexity, estimateCost } = require('./llm-router');

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...val] = line.split('=');
    if (key && val.length) process.env[key.trim()] = val.join('=').trim();
  });
}

const PORT = process.env.PORT || 3000;
const GROK_API_KEY = process.env.GROK_API_KEY;
const DIR = __dirname;
const SERVER_START_TIME = new Date().toISOString();

// ===== BUDGET GUARD =====
const DEFAULT_DAILY_BUDGET = parseFloat(process.env.DAILY_BUDGET || '2.00');
const DEFAULT_MONTHLY_BUDGET = parseFloat(process.env.MONTHLY_BUDGET || '30.00');
const COST_CONFIRM_THRESHOLD = 0.10; // ask confirmation above this per-call cost

// In-memory cost cache (TTL 60s) — avoids hitting Supabase on every request
const costCache = new Map();

async function getCachedCost(userId, period) {
  const key = `${userId}:${period}`;
  const cached = costCache.get(key);
  if (cached && Date.now() - cached.at < 60000) return cached.value;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return 0;

  const now = new Date();
  let startDate;
  if (period === 'daily') {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  } else {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  }

  return new Promise((resolve) => {
    const url = new URL(`${supabaseUrl}/rest/v1/senna_api_costs`);
    url.searchParams.set('select', 'estimated_cost');
    url.searchParams.set('created_at', `gte.${startDate}`);
    if (userId) url.searchParams.set('user_id', `eq.${userId}`);

    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: `${url.pathname}?${url.searchParams.toString()}`,
      method: 'GET',
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const rows = JSON.parse(data);
          const total = rows.reduce((sum, r) => sum + parseFloat(r.estimated_cost || 0), 0);
          costCache.set(key, { value: total, at: Date.now() });
          resolve(total);
        } catch { resolve(0); }
      });
    });
    req.on('error', () => resolve(0));
    req.end();
  });
}

function invalidateCostCache(userId) {
  for (const key of costCache.keys()) {
    if (key.startsWith(userId + ':')) costCache.delete(key);
  }
}

async function checkBudget(userId, complexity) {
  const daily = await getCachedCost(userId, 'daily');
  const monthly = await getCachedCost(userId, 'monthly');
  const dailyHard = DEFAULT_DAILY_BUDGET * 2.5;
  const monthlyHard = DEFAULT_MONTHLY_BUDGET * 1.5;

  if (monthly >= monthlyHard) {
    return { allowed: false, reason: 'monthly_limit', daily, monthly, downgrade: true };
  }
  if (daily >= dailyHard) {
    return { allowed: false, reason: 'daily_limit', daily, monthly, downgrade: true };
  }
  if (complexity === 'critical') {
    return { allowed: true, requiresConfirmation: true, daily, monthly };
  }
  const warning = daily >= DEFAULT_DAILY_BUDGET
    ? `Gasto hoje: $${daily.toFixed(2)}`
    : monthly >= DEFAULT_MONTHLY_BUDGET
      ? `Gasto mensal: $${monthly.toFixed(2)}`
      : null;
  return { allowed: true, warning, daily, monthly };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function proxyRequest(options, postData, res) {
  const apiReq = https.request(options, (apiRes) => {
    const headers = {
      'Content-Type': apiRes.headers['content-type'] || 'application/json',
      'Access-Control-Allow-Origin': '*'
    };
    res.writeHead(apiRes.statusCode, headers);
    apiRes.pipe(res);
  });
  apiReq.on('error', (err) => {
    console.error('Proxy error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });
  apiReq.write(postData);
  apiReq.end();
}

http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  // API Proxy: /api/grok (legacy — still works, bypasses router)
  if (req.url === '/api/grok' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      delete parsed._apiKey; // remove if sent from legacy client
      const postData = JSON.stringify(parsed);

      proxyRequest({
        hostname: 'api.x.ai',
        port: 443,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GROK_API_KEY}`,
          'Content-Length': Buffer.byteLength(postData)
        }
      }, postData, res);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
    return;
  }

  // ===== MULTI-LLM ROUTER: /api/chat =====
  if (req.url === '/api/chat' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      const { messages, forceProvider, forceModel, confirmed } = parsed;
      const userId = parsed.userId || 'marlon';

      if (!messages || !Array.isArray(messages)) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'messages array required' }));
        return;
      }

      // Classify complexity for budget check
      const complexity = classifyComplexity(messages);

      // Budget guard — check before calling LLM
      const budget = await checkBudget(userId, complexity);

      if (!budget.allowed && budget.downgrade) {
        // Over hard limit — force free tier only
        console.log(`[BUDGET] ${budget.reason} for ${userId}. Downgrading to free tier.`);
        const result = await routeMessage(messages, process.env, {
          forceProvider: 'grok',
          forceModel: 'grok-3-mini-fast'
        });

        logCostToSupabase(result).catch(err =>
          console.error('[COST] Failed to log:', err.message)
        );
        invalidateCostCache(userId);

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
          choices: [{ message: { content: result.content, role: 'assistant' } }],
          _senna: {
            provider: result.provider, model: result.model,
            complexity: result.complexity, cost: result.cost,
            usage: result.usage,
            budgetWarning: budget.reason === 'daily_limit'
              ? `Limite diario atingido ($${budget.daily.toFixed(2)}). Usando modelo economico.`
              : `Limite mensal atingido ($${budget.monthly.toFixed(2)}). Usando modelo economico.`
          }
        }));
        return;
      }

      // Requires confirmation for expensive calls (CRITICAL or high cost estimate)
      if (budget.requiresConfirmation && !confirmed) {
        res.writeHead(202, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
          _senna: {
            requiresConfirmation: true,
            complexity,
            estimatedCost: complexity === 'critical' ? 0.15 : 0.10,
            daily: budget.daily,
            monthly: budget.monthly
          }
        }));
        return;
      }

      const result = await routeMessage(messages, process.env, {
        forceProvider: forceProvider || null,
        forceModel: forceModel || null
      });

      // Log cost to Supabase (async, non-blocking)
      logCostToSupabase(result).catch(err =>
        console.error('[COST] Failed to log:', err.message)
      );
      invalidateCostCache(userId);

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({
        choices: [{ message: { content: result.content, role: 'assistant' } }],
        _senna: {
          provider: result.provider, model: result.model,
          complexity: result.complexity, cost: result.cost,
          usage: result.usage,
          budgetWarning: budget.warning || null
        }
      }));
    } catch (err) {
      console.error('[CHAT] Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ===== COST TRACKING: /api/costs =====
  if (req.url.startsWith('/api/costs') && req.method === 'GET') {
    try {
      const costs = await fetchCostsFromSupabase();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(costs));
    } catch (err) {
      console.error('[COSTS] Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ===== BUDGET STATUS: /api/budget =====
  if (req.url.startsWith('/api/budget') && req.method === 'GET') {
    try {
      const userId = 'marlon'; // TODO: extract from auth
      const daily = await getCachedCost(userId, 'daily');
      const monthly = await getCachedCost(userId, 'monthly');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({
        daily: { spent: Math.round(daily * 100) / 100, soft: DEFAULT_DAILY_BUDGET, hard: DEFAULT_DAILY_BUDGET * 2.5 },
        monthly: { spent: Math.round(monthly * 100) / 100, soft: DEFAULT_MONTHLY_BUDGET, hard: DEFAULT_MONTHLY_BUDGET * 1.5 },
        confirmThreshold: COST_CONFIRM_THRESHOLD
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ===== PROVIDER STATUS: /api/providers =====
  if (req.url === '/api/providers' && req.method === 'GET') {
    const providers = {
      ollama: { available: !!(process.env.OLLAMA_URL || process.env.OLLAMA_ENABLED), name: 'Ollama' },
      grok: { available: !!process.env.GROK_API_KEY, name: 'Grok' },
      gemini: { available: !!process.env.GEMINI_API_KEY, name: 'Gemini' },
      openai: { available: !!process.env.OPENAI_API_KEY, name: 'OpenAI' },
      claude: { available: !!process.env.ANTHROPIC_API_KEY, name: 'Claude' }
    };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(providers));
    return;
  }

  // API Proxy: /api/tts → Kokoro TTS (localhost:8880)
  if (req.url === '/api/tts' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const postData = JSON.stringify(JSON.parse(body));

      const apiReq = require('http').request({
        hostname: 'localhost',
        port: 8880,
        path: '/v1/audio/speech',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (apiRes) => {
        const headers = {
          'Content-Type': apiRes.headers['content-type'] || 'audio/wav',
          'Access-Control-Allow-Origin': '*'
        };
        res.writeHead(apiRes.statusCode, headers);
        apiRes.pipe(res);
      });
      apiReq.on('error', (err) => {
        console.error('Kokoro TTS proxy error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      apiReq.write(postData);
      apiReq.end();
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
    return;
  }

  // Webhook: GitHub auto-deploy
  if (req.url === '/api/deploy' && req.method === 'POST') {
    console.log('[DEPLOY] Webhook received — pulling and restarting...');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'deploying' }));
    exec('cd /var/www/senna && git pull origin main && pm2 restart senna', (err, stdout, stderr) => {
      if (err) {
        console.error('[DEPLOY] Error:', stderr);
      } else {
        console.log('[DEPLOY] Success:', stdout);
      }
    });
    return;
  }

  // API Version: returns git commit info + server start time
  if (req.url === '/api/version' && req.method === 'GET') {
    exec('git log -1 --format="%h|%ci|%s"', { cwd: DIR }, (err, stdout) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to get version' }));
        return;
      }
      const parts = stdout.trim().split('|');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        hash: parts[0] || '???',
        date: parts[1] || '',
        message: parts[2] || '',
        serverStart: SERVER_START_TIME
      }));
    });
    return;
  }

  // API Config: returns Supabase public keys for the frontend
  if (req.url === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      supabaseUrl: process.env.SUPABASE_URL,
      supabaseKey: process.env.SUPABASE_ANON_KEY
    }));
    return;
  }

  // Static files
  let filePath = path.join(DIR, req.url === '/' ? 'index.html' : decodeURIComponent(req.url));
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`SENNA server running at http://localhost:${PORT}`);
  // Log available providers
  const available = ['grok', 'gemini', 'openai', 'claude', 'ollama'].filter(p => {
    const keys = { grok: 'GROK_API_KEY', gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY', claude: 'ANTHROPIC_API_KEY', ollama: 'OLLAMA_URL' };
    return !!process.env[keys[p]];
  });
  console.log(`[ROUTER] Available providers: ${available.join(', ') || 'grok only (default)'}`);
});

// ===== SUPABASE COST LOGGING =====
async function logCostToSupabase(result) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return;

  const payload = JSON.stringify({
    provider: result.provider,
    model: result.model,
    input_tokens: result.usage?.input_tokens || 0,
    output_tokens: result.usage?.output_tokens || 0,
    estimated_cost: result.cost || 0,
    complexity: result.complexity || 'medium',
    user_id: 'marlon'
  });

  const url = new URL(`${supabaseUrl}/rest/v1/senna_api_costs`);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=minimal',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Supabase ${res.statusCode}: ${data}`));
        } else {
          resolve();
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function fetchCostsFromSupabase() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return { total: 0, byProvider: {}, requests: 0 };

  // Get costs for current month
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const url = new URL(`${supabaseUrl}/rest/v1/senna_api_costs`);
  url.searchParams.set('select', 'provider,model,estimated_cost,input_tokens,output_tokens,created_at');
  url.searchParams.set('created_at', `gte.${monthStart}`);
  url.searchParams.set('order', 'created_at.desc');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: `${url.pathname}?${url.searchParams.toString()}`,
      method: 'GET',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Supabase ${res.statusCode}: ${data}`));
          return;
        }
        try {
          const rows = JSON.parse(data);
          const total = rows.reduce((sum, r) => sum + parseFloat(r.estimated_cost || 0), 0);
          const byProvider = {};
          const byModel = {};
          rows.forEach(r => {
            byProvider[r.provider] = (byProvider[r.provider] || 0) + parseFloat(r.estimated_cost || 0);
            byModel[r.model] = (byModel[r.model] || 0) + 1;
          });
          resolve({
            total: Math.round(total * 100) / 100,
            byProvider,
            byModel,
            requests: rows.length,
            month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
          });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}
