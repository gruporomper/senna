// ===== SENNA — LLM Router =====
// Intelligent routing across multiple LLM providers with fallback and cost tracking

const https = require('https');
const http = require('http');

// ===== PRICING TABLE (per 1M tokens) =====
const PRICING = {
  'grok-3-mini-fast':    { input: 0.10,  output: 0.25 },
  'grok-3':              { input: 0.30,  output: 1.00 },
  'gemini-2.0-flash':    { input: 0.00,  output: 0.00 },  // free tier
  'gemini-2.5-pro':      { input: 1.25,  output: 5.00 },
  'gpt-4o-mini':         { input: 0.15,  output: 0.60 },
  'gpt-4o':              { input: 2.50,  output: 10.00 },
  'claude-haiku-4-5':    { input: 0.80,  output: 4.00 },
  'claude-sonnet-4-6':   { input: 3.00,  output: 15.00 },
  'ollama':              { input: 0.00,  output: 0.00 },
};

// ===== PROVIDER CONFIGS =====
const PROVIDERS = {
  ollama: {
    name: 'Ollama',
    models: ['ollama'],
    defaultModel: 'ollama',
    buildRequest: (messages, model, env) => ({
      protocol: 'http',
      hostname: new URL(env.OLLAMA_URL || 'http://localhost:11434').hostname,
      port: parseInt(new URL(env.OLLAMA_URL || 'http://localhost:11434').port) || 11434,
      path: '/api/chat',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.OLLAMA_MODEL || 'dolphin-mistral:7b',
        messages,
        stream: false
      }),
      parseResponse: (data) => {
        const parsed = JSON.parse(data);
        return {
          content: parsed.message?.content || '',
          usage: {
            input_tokens: parsed.prompt_eval_count || 0,
            output_tokens: parsed.eval_count || 0
          }
        };
      }
    })
  },

  grok: {
    name: 'Grok',
    models: ['grok-3-mini-fast', 'grok-3'],
    defaultModel: 'grok-3-mini-fast',
    buildRequest: (messages, model, env) => ({
      protocol: 'https',
      hostname: 'api.x.ai',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.GROK_API_KEY}`
      },
      body: JSON.stringify({
        model: model || 'grok-3-mini-fast',
        messages,
        temperature: 0.9,
        max_tokens: 1000
      }),
      parseResponse: parseOpenAIResponse
    })
  },

  gemini: {
    name: 'Gemini',
    models: ['gemini-2.0-flash', 'gemini-2.5-pro'],
    defaultModel: 'gemini-2.0-flash',
    buildRequest: (messages, model, env) => {
      const geminiModel = model || 'gemini-2.0-flash';
      // Convert OpenAI-style messages to Gemini format
      const systemInstruction = messages.find(m => m.role === 'system');
      const contents = messages
        .filter(m => m.role !== 'system')
        .map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        }));

      const payload = { contents };
      if (systemInstruction) {
        payload.systemInstruction = { parts: [{ text: systemInstruction.content }] };
      }
      payload.generationConfig = { temperature: 0.9, maxOutputTokens: 1000 };

      return {
        protocol: 'https',
        hostname: 'generativelanguage.googleapis.com',
        port: 443,
        path: `/v1beta/models/${geminiModel}:generateContent?key=${env.GEMINI_API_KEY}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        parseResponse: (data) => {
          const parsed = JSON.parse(data);
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
          const usage = parsed.usageMetadata || {};
          return {
            content: text,
            usage: {
              input_tokens: usage.promptTokenCount || 0,
              output_tokens: usage.candidatesTokenCount || 0
            }
          };
        }
      };
    }
  },

  openai: {
    name: 'OpenAI',
    models: ['gpt-4o-mini', 'gpt-4o'],
    defaultModel: 'gpt-4o-mini',
    buildRequest: (messages, model, env) => ({
      protocol: 'https',
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages,
        temperature: 0.9,
        max_tokens: 1000
      }),
      parseResponse: parseOpenAIResponse
    })
  },

  claude: {
    name: 'Claude',
    models: ['claude-haiku-4-5', 'claude-sonnet-4-6'],
    defaultModel: 'claude-haiku-4-5',
    buildRequest: (messages, model, env) => {
      // Anthropic uses a different format: system is separate
      const systemMsg = messages.find(m => m.role === 'system');
      const chatMsgs = messages.filter(m => m.role !== 'system');

      const payload = {
        model: model || 'claude-haiku-4-5',
        max_tokens: 1000,
        messages: chatMsgs
      };
      if (systemMsg) payload.system = systemMsg.content;

      return {
        protocol: 'https',
        hostname: 'api.anthropic.com',
        port: 443,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(payload),
        parseResponse: (data) => {
          const parsed = JSON.parse(data);
          const text = parsed.content?.[0]?.text || '';
          return {
            content: text,
            usage: {
              input_tokens: parsed.usage?.input_tokens || 0,
              output_tokens: parsed.usage?.output_tokens || 0
            }
          };
        }
      };
    }
  }
};

// Common OpenAI-compatible response parser (Grok, OpenAI)
function parseOpenAIResponse(data) {
  const parsed = JSON.parse(data);
  return {
    content: parsed.choices?.[0]?.message?.content || '',
    usage: {
      input_tokens: parsed.usage?.prompt_tokens || 0,
      output_tokens: parsed.usage?.completion_tokens || 0
    }
  };
}

// ===== COMPLEXITY CLASSIFIER =====
function classifyComplexity(messages) {
  const lastMsg = messages[messages.length - 1]?.content || '';
  const wordCount = lastMsg.split(/\s+/).length;
  const hasCode = /```|function\s|const\s|let\s|var\s|import\s|class\s|def\s|async\s/.test(lastMsg);
  const isGreeting = /^(oi|olá|ola|bom dia|boa tarde|boa noite|e ai|fala|hey|hi|hello|obrigado|valeu|blz)\b/i.test(lastMsg.trim());
  const isSimple = wordCount < 10 && !hasCode;
  const isComplex = wordCount > 100 || /analis|pesquis|estratégia|estrategia|relatório|relatorio|compar|explicar detalhadamente|código completo|codigo completo/i.test(lastMsg);
  const isCritical = /contrato|jurídico|juridico|financeiro|investimento|decisão|decisao|compliance|legal/i.test(lastMsg);

  if (isGreeting || isSimple) return 'simple';
  if (isCritical) return 'critical';
  if (isComplex || hasCode) return 'complex';
  return 'medium';
}

// ===== ROUTING TABLE =====
// complexity → [preferred provider+model, ...fallbacks]
const ROUTING = {
  simple: [
    { provider: 'ollama', model: 'ollama' },
    { provider: 'grok', model: 'grok-3-mini-fast' },
    { provider: 'gemini', model: 'gemini-2.0-flash' }
  ],
  medium: [
    { provider: 'grok', model: 'grok-3-mini-fast' },
    { provider: 'gemini', model: 'gemini-2.0-flash' },
    { provider: 'openai', model: 'gpt-4o-mini' }
  ],
  complex: [
    { provider: 'gemini', model: 'gemini-2.5-pro' },
    { provider: 'openai', model: 'gpt-4o' },
    { provider: 'grok', model: 'grok-3' },
    { provider: 'claude', model: 'claude-sonnet-4-6' }
  ],
  critical: [
    { provider: 'openai', model: 'gpt-4o' },
    { provider: 'claude', model: 'claude-sonnet-4-6' },
    { provider: 'gemini', model: 'gemini-2.5-pro' },
    { provider: 'grok', model: 'grok-3' }
  ]
};

// ===== PROVIDER HEALTH =====
const providerHealth = {};

function isProviderAvailable(providerName, env) {
  // Check if API key exists
  switch (providerName) {
    case 'ollama': return !!(env.OLLAMA_URL || env.OLLAMA_ENABLED);
    case 'grok': return !!env.GROK_API_KEY;
    case 'gemini': return !!env.GEMINI_API_KEY;
    case 'openai': return !!env.OPENAI_API_KEY;
    case 'claude': return !!env.ANTHROPIC_API_KEY;
    default: return false;
  }
}

function markProviderDown(providerName) {
  providerHealth[providerName] = { down: true, at: Date.now() };
  console.log(`[ROUTER] Provider ${providerName} marked DOWN`);
}

function isProviderHealthy(providerName) {
  const health = providerHealth[providerName];
  if (!health || !health.down) return true;
  // Retry after 60 seconds
  if (Date.now() - health.at > 60000) {
    delete providerHealth[providerName];
    return true;
  }
  return false;
}

// ===== MAKE REQUEST =====
function makeRequest(config) {
  return new Promise((resolve, reject) => {
    const transport = config.protocol === 'https' ? https : http;
    const reqOptions = {
      hostname: config.hostname,
      port: config.port,
      path: config.path,
      method: config.method,
      headers: {
        ...config.headers,
        'Content-Length': Buffer.byteLength(config.body)
      }
    };

    const req = transport.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        try {
          const result = config.parseResponse(data);
          resolve(result);
        } catch (err) {
          reject(new Error(`Parse error: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout (30s)'));
    });
    req.write(config.body);
    req.end();
  });
}

// ===== ESTIMATE COST =====
function estimateCost(model, inputTokens, outputTokens) {
  const pricing = PRICING[model] || { input: 0, output: 0 };
  return (inputTokens * pricing.input / 1_000_000) + (outputTokens * pricing.output / 1_000_000);
}

// ===== MAIN ROUTER =====
async function routeMessage(messages, env, options = {}) {
  const { forceProvider, forceModel } = options;

  // Determine route
  let route;
  if (forceProvider) {
    const provider = PROVIDERS[forceProvider];
    if (!provider) throw new Error(`Unknown provider: ${forceProvider}`);
    const model = forceModel || provider.defaultModel;
    route = [{ provider: forceProvider, model }];
  } else {
    const complexity = classifyComplexity(messages);
    route = ROUTING[complexity].filter(r =>
      isProviderAvailable(r.provider, env) && isProviderHealthy(r.provider)
    );
    if (route.length === 0) {
      throw new Error('No LLM providers available. Check API keys in .env');
    }
  }

  // Try each provider in order
  let lastError;
  for (const { provider: provName, model } of route) {
    const provider = PROVIDERS[provName];
    try {
      console.log(`[ROUTER] Trying ${provName}/${model}...`);
      const config = provider.buildRequest(messages, model, env);
      const result = await makeRequest(config);
      const cost = estimateCost(model, result.usage.input_tokens, result.usage.output_tokens);

      console.log(`[ROUTER] Success: ${provName}/${model} — ${result.usage.input_tokens}+${result.usage.output_tokens} tokens — $${cost.toFixed(6)}`);

      return {
        content: result.content,
        provider: provName,
        model,
        usage: result.usage,
        cost,
        complexity: classifyComplexity(messages)
      };
    } catch (err) {
      console.error(`[ROUTER] ${provName}/${model} failed:`, err.message);
      markProviderDown(provName);
      lastError = err;
    }
  }

  throw new Error(`All providers failed. Last error: ${lastError?.message}`);
}

// ===== PREFIX PARSER =====
// Extracts /provider prefix from user message
function parsePrefix(text) {
  const match = text.match(/^\/(\w+)\s+/);
  if (!match) return { text, forceProvider: null, forceModel: null };

  const prefix = match[1].toLowerCase();
  const cleanText = text.slice(match[0].length);

  const prefixMap = {
    grok: { provider: 'grok', model: 'grok-3-mini-fast' },
    gemini: { provider: 'gemini', model: 'gemini-2.0-flash' },
    gpt: { provider: 'openai', model: 'gpt-4o-mini' },
    gpt4: { provider: 'openai', model: 'gpt-4o' },
    claude: { provider: 'claude', model: 'claude-haiku-4-5' },
    ollama: { provider: 'ollama', model: 'ollama' },
    turbo: { provider: 'openai', model: 'gpt-4o' },  // most powerful
  };

  if (prefixMap[prefix]) {
    return { text: cleanText, forceProvider: prefixMap[prefix].provider, forceModel: prefixMap[prefix].model };
  }

  return { text, forceProvider: null, forceModel: null };
}

module.exports = {
  routeMessage,
  parsePrefix,
  classifyComplexity,
  estimateCost,
  PRICING,
  PROVIDERS,
  ROUTING
};
