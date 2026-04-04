const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { routeMessage, routeMessageStream, parsePrefix, classifyComplexity, estimateCost } = require('./llm-router');
const memory = require('./memory-engine');

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
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
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

      // Inject memory context into system prompt (if not a forced internal call)
      const enrichedMessages = [...messages];
      if (!forceProvider || forceProvider !== 'grok') {
        try {
          const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
          if (lastUserMsg) {
            const memCtx = await memory.retrieveContext(
              lastUserMsg.content,
              { user_id: userId, agent_id: 'senna_core' },
              process.env
            );
            if (memCtx.context && memCtx.memoriesUsed > 0) {
              const sysIdx = enrichedMessages.findIndex(m => m.role === 'system');
              if (sysIdx >= 0) {
                enrichedMessages[sysIdx] = {
                  ...enrichedMessages[sysIdx],
                  content: enrichedMessages[sysIdx].content + memCtx.context
                };
              }
              console.log(`[MEMORY] Injected ${memCtx.memoriesUsed} memories into context`);
            }
          }
        } catch (memErr) {
          console.error('[MEMORY] Retrieval failed (non-blocking):', memErr.message);
        }
      }

      // ===== STREAMING MODE =====
      if (parsed.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });

        try {
          const result = await routeMessageStream(enrichedMessages, process.env, {
            forceProvider: forceProvider || null,
            forceModel: forceModel || null
          }, (token) => {
            res.write(`data: ${JSON.stringify({ token })}\n\n`);
          });

          // Send final metadata event
          res.write(`data: ${JSON.stringify({
            done: true,
            _senna: {
              provider: result.provider, model: result.model,
              complexity: result.complexity, cost: result.cost,
              usage: result.usage,
              budgetWarning: budget.warning || null
            }
          })}\n\n`);
          res.end();

          // Async: log cost + extract memories
          logCostToSupabase(result).catch(err => console.error('[COST] Failed:', err.message));
          invalidateCostCache(userId);
          if (!forceProvider) {
            memory.processConversationMemory(messages, {
              user_id: userId, agent_id: 'senna_core',
              source: 'conversation', source_type: 'message'
            }, process.env).catch(err => console.error('[MEMORY] Extraction failed:', err.message));
          }
        } catch (streamErr) {
          res.write(`data: ${JSON.stringify({ error: streamErr.message })}\n\n`);
          res.end();
        }
        return;
      }

      // ===== NON-STREAMING MODE =====
      const result = await routeMessage(enrichedMessages, process.env, {
        forceProvider: forceProvider || null,
        forceModel: forceModel || null
      });

      logCostToSupabase(result).catch(err =>
        console.error('[COST] Failed to log:', err.message)
      );
      invalidateCostCache(userId);

      if (!forceProvider) {
        memory.processConversationMemory(messages, {
          user_id: userId, agent_id: 'senna_core',
          source: 'conversation', source_type: 'message'
        }, process.env).catch(err =>
          console.error('[MEMORY] Extraction failed (non-blocking):', err.message)
        );
      }

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

  // ===== MEMORY ENGINE API =====

  // POST /api/memory — add a memory
  if (req.url === '/api/memory' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      const result = await memory.addMemory(parsed, process.env);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/memory/search?user_id=X&q=Y&type=Z
  if (req.url.startsWith('/api/memory/search') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const userId = url.searchParams.get('user_id') || 'marlon';
      const query = url.searchParams.get('q') || '';
      const memType = url.searchParams.get('type') || null;
      const results = await memory.searchMemories(userId, query, process.env, {
        memory_type: memType, limit: 50
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(results));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // PUT /api/memory/:id — update a memory
  if (req.url.match(/^\/api\/memory\/[a-f0-9-]+$/) && req.method === 'PUT') {
    try {
      const memoryId = req.url.split('/').pop();
      const body = await readBody(req);
      const updates = JSON.parse(body);
      const result = await memory.updateMemory(memoryId, updates, process.env);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // DELETE /api/memory/:id — archive a memory
  if (req.url.match(/^\/api\/memory\/[a-f0-9-]+$/) && req.method === 'DELETE') {
    try {
      const memoryId = req.url.split('/').pop();
      const result = await memory.deleteMemory(memoryId, process.env);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/memory/:id/history — audit trail
  if (req.url.match(/^\/api\/memory\/[a-f0-9-]+\/history$/) && req.method === 'GET') {
    try {
      const memoryId = req.url.split('/')[3];
      const result = await memory.getMemoryHistory(memoryId, process.env);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/memory/context — retrieve context for prompt injection
  if (req.url === '/api/memory/context' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      const result = await memory.retrieveContext(
        parsed.query, {
          user_id: parsed.user_id || 'marlon',
          agent_id: parsed.agent_id || 'senna_core',
          session_id: parsed.session_id
        }, process.env
      );
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/memory/extract — manually extract facts from messages
  if (req.url === '/api/memory/extract' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      const result = await memory.processConversationMemory(
        parsed.messages, {
          user_id: parsed.user_id || 'marlon',
          agent_id: parsed.agent_id || 'senna_core',
          source: 'conversation', source_type: 'message'
        }, process.env
      );
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/memory/ingest-event — ingest business event
  if (req.url === '/api/memory/ingest-event' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const event = JSON.parse(body);
      const result = await memory.ingestBusinessEvent(event, process.env);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/memory/health — memory system health
  if (req.url === '/api/memory/health' && req.method === 'GET') {
    try {
      const result = await memory.getMemoryHealth(process.env);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // DELETE /api/memory/user/:userId/all — LGPD purge
  if (req.url.match(/^\/api\/memory\/user\/[^/]+\/all$/) && req.method === 'DELETE') {
    try {
      const userId = req.url.split('/')[4];
      const result = await memory.purgeUserMemories(userId, process.env);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/memory/user/:userId/export — LGPD export
  if (req.url.match(/^\/api\/memory\/user\/[^/]+\/export$/) && req.method === 'GET') {
    try {
      const userId = req.url.split('/')[4];
      const result = await memory.exportUserMemories(userId, process.env);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API Proxy: /api/tts → Kokoro TTS (localhost:8880)
  if (req.url === '/api/tts' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const postData = JSON.stringify(JSON.parse(body));

      const kokoroBase = process.env.KOKORO_URL || 'http://localhost:8880';
      const kokoroParsed = new URL(kokoroBase);
      const apiReq = (kokoroParsed.protocol === 'https:' ? https : http).request({
        hostname: kokoroParsed.hostname,
        port: kokoroParsed.port || (kokoroParsed.protocol === 'https:' ? 443 : 8880),
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

  // ===== HEALTH CHECK: /api/health =====
  if (req.url === '/api/health' && req.method === 'GET') {
    const checks = {};
    const errors = [];

    // Check Ollama
    const ollamaUrl = process.env.OLLAMA_URL;
    if (ollamaUrl) {
      try {
        const ollamaOk = await new Promise((resolve) => {
          const req = (ollamaUrl.startsWith('https') ? https : http).get(ollamaUrl, { timeout: 3000 }, (r) => {
            resolve(r.statusCode < 500);
          });
          req.on('error', () => resolve(false));
          req.on('timeout', () => { req.destroy(); resolve(false); });
        });
        checks.ollama = ollamaOk ? 'ok' : 'down';
        if (!ollamaOk) errors.push('ollama');
      } catch { checks.ollama = 'down'; errors.push('ollama'); }
    } else {
      checks.ollama = 'not_configured';
    }

    // Check Kokoro TTS
    const kokoroUrl = process.env.KOKORO_URL || 'http://localhost:8880';
    try {
      const kokoroOk = await new Promise((resolve) => {
        const req = http.get(kokoroUrl, { timeout: 3000 }, (r) => {
          resolve(r.statusCode < 500);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
      });
      checks.kokoro_tts = kokoroOk ? 'ok' : 'down';
      if (!kokoroOk) errors.push('kokoro_tts');
    } catch { checks.kokoro_tts = 'down'; errors.push('kokoro_tts'); }

    // Check n8n
    try {
      const n8nOk = await new Promise((resolve) => {
        const req = http.get('http://localhost:5678/healthz', { timeout: 3000 }, (r) => {
          resolve(r.statusCode < 500);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
      });
      checks.n8n = n8nOk ? 'ok' : 'down';
      if (!n8nOk) errors.push('n8n');
    } catch { checks.n8n = 'down'; errors.push('n8n'); }

    // Check API keys
    checks.grok = process.env.GROK_API_KEY ? 'configured' : 'missing';
    checks.gemini = process.env.GEMINI_API_KEY ? 'configured' : 'missing';
    checks.openai = process.env.OPENAI_API_KEY ? 'configured' : 'missing';
    checks.claude = process.env.ANTHROPIC_API_KEY ? 'configured' : 'missing';

    // Check Supabase
    checks.supabase = process.env.SUPABASE_URL ? 'configured' : 'missing';

    const status = errors.length === 0 ? 'healthy' : 'degraded';
    const uptime = Math.floor((Date.now() - new Date(SERVER_START_TIME).getTime()) / 1000);

    res.writeHead(status === 'healthy' ? 200 : 503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ status, uptime, serverStart: SERVER_START_TIME, checks, errors }));
    return;
  }

  // ===== AUTOMATION: /api/automate =====
  // Triggers n8n workflows via webhook
  if (req.url === '/api/automate' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      const { action, payload, confirmed } = parsed;

      if (!action) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Missing action' }));
        return;
      }

      // Action registry with risk levels
      const ACTIONS = {
        send_email: { level: 'L3', n8nWebhook: 'send-email', label: 'Enviar email' },
        create_event: { level: 'L2', n8nWebhook: 'create-event', label: 'Criar evento' },
        send_whatsapp: { level: 'L3', n8nWebhook: 'send-whatsapp', label: 'Enviar WhatsApp' },
      };

      const actionDef = ACTIONS[action];
      if (!actionDef) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: `Unknown action: ${action}` }));
        return;
      }

      // L3+ actions require explicit confirmation
      if ((actionDef.level === 'L3' || actionDef.level === 'L4') && !confirmed) {
        res.writeHead(202, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
          requiresConfirmation: true,
          action,
          label: actionDef.label,
          level: actionDef.level,
          payload,
          message: `Confirmar: ${actionDef.label}? Esta acao nao pode ser desfeita.`
        }));
        return;
      }

      // Forward to n8n webhook
      const n8nBase = process.env.N8N_WEBHOOK_URL || 'http://localhost:5678/webhook';
      const n8nUrl = new URL(`${n8nBase}/${actionDef.n8nWebhook}`);

      const n8nPayload = JSON.stringify({ ...payload, _senna: { action, timestamp: new Date().toISOString() } });
      const n8nReq = (n8nUrl.protocol === 'https:' ? https : http).request({
        hostname: n8nUrl.hostname,
        port: n8nUrl.port,
        path: n8nUrl.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(n8nPayload) },
        timeout: 30000
      }, (n8nRes) => {
        let data = '';
        n8nRes.on('data', (chunk) => data += chunk);
        n8nRes.on('end', () => {
          // Log to Supabase automation_logs
          logAutomation(action, payload, n8nRes.statusCode < 400 ? 'success' : 'failed', data).catch(() => {});

          res.writeHead(n8nRes.statusCode < 400 ? 200 : 502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({
            success: n8nRes.statusCode < 400,
            action,
            result: data ? JSON.parse(data) : null
          }));
        });
      });

      n8nReq.on('error', (err) => {
        logAutomation(action, payload, 'failed', err.message).catch(() => {});
        res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: `n8n unreachable: ${err.message}` }));
      });

      n8nReq.write(n8nPayload);
      n8nReq.end();
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    }
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

async function logAutomation(action, payload, status, result) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return;

  const data = JSON.stringify({
    user_id: 'marlon',
    action_type: action,
    payload: payload || {},
    status,
    error_message: status === 'failed' ? (typeof result === 'string' ? result : null) : null,
    confirmed_by_user: true
  });

  const url = new URL(`${supabaseUrl}/rest/v1/automation_logs`);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname, port: 443, path: url.pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`, 'Prefer': 'return=minimal',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => res.statusCode >= 400 ? reject(new Error(body)) : resolve());
    });
    req.on('error', reject);
    req.write(data);
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
