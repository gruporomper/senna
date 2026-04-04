// ===== SENNA Memory Engine =====
// Fact-based memory system with extraction, dedup, decay, and contextual retrieval

const https = require('https');
const crypto = require('crypto');

// ===== CONFIG =====
const CONFIDENCE_THRESHOLD = 0.50;
const MAX_FACTS_PER_EXTRACTION = 5;
const MAX_CONTEXT_CHARS = 8000;
const SIMILARITY_IDENTICAL = 0.90;
const SIMILARITY_EVOLUTION = 0.75;
const QUEUE_FLUSH_INTERVAL = 2000;
const QUEUE_BATCH_SIZE = 10;
const MAX_RETRIES = 3;

// ===== HASH =====
function hashNormalized(text) {
  const normalized = text.toLowerCase().trim()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 16);
}

// ===== SUPABASE CLIENT (server-side, uses service key via anon) =====
function supabaseRequest(env, method, path, body = null) {
  const url = new URL(`${env.SUPABASE_URL}${path}`);
  const headers = {
    'apikey': env.SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
  };

  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : '';
    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method,
      headers: {
        ...headers,
        ...(body ? { 'Content-Length': Buffer.byteLength(postData) } : {})
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Supabase ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        try {
          resolve(data ? JSON.parse(data) : null);
        } catch {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Supabase timeout')); });
    if (body) req.write(postData);
    req.end();
  });
}

// ===== EMBEDDING GENERATION =====
// Uses a lightweight approach: hash-based pseudo-embeddings for Fase 1
// Will be replaced with real embeddings (all-MiniLM or OpenAI) in Fase 2
function generatePseudoEmbedding(text) {
  // Simple TF-based 384-dim vector using character trigrams
  // Good enough for basic similarity, replaced with real model later
  const normalized = text.toLowerCase().trim();
  const dims = 384;
  const vec = new Array(dims).fill(0);

  for (let i = 0; i < normalized.length - 2; i++) {
    const trigram = normalized.substring(i, i + 3);
    const hash = crypto.createHash('md5').update(trigram).digest();
    for (let d = 0; d < Math.min(16, dims); d++) {
      vec[(hash[d % hash.length] * 17 + d) % dims] += 1;
    }
  }

  // Normalize to unit vector
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map(v => v / magnitude);
}

// ===== FACT EXTRACTOR =====
const EXTRACTION_PROMPT = `You are a fact extraction engine for the SENNA AI system. Extract ONLY new, useful, persistent facts from this conversation.

RULES:
- Return a JSON array of facts. If no facts worth saving, return []
- Each fact: { "type": "profile|preference|operational|relationship|constraint|behavioral", "key": "snake_case_key", "content": "fact in natural language PT-BR", "structured_data": {}, "confidence": 0.5-1.0, "privacy_level": "internal|sensitive" }
- Do NOT extract: greetings, thanks, confirmations, questions, small talk, opinions without substance
- Do NOT extract what the assistant said — only facts FROM or ABOUT the user
- Maximum 5 facts per extraction
- confidence: 0.95 = user explicitly stated, 0.85 = clearly implied, 0.70 = inferred
- key must be unique and descriptive (e.g. "nome_completo", "empresa_principal", "horario_preferido")
- If user corrects a previous fact, include the correction with high confidence
- Minimum content length: 15 characters`;

async function extractFacts(messages, env) {
  // Filter recent messages, skip very short conversations
  const recent = messages.filter(m => m.role !== 'system').slice(-10);
  if (recent.length < 2) return [];

  // Skip if last user message is too short (greeting, etc)
  const lastUser = [...recent].reverse().find(m => m.role === 'user');
  if (!lastUser || lastUser.content.trim().length < 15) return [];

  const messagesText = recent
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n');

  const extractionMessages = [
    { role: 'system', content: EXTRACTION_PROMPT },
    { role: 'user', content: messagesText }
  ];

  try {
    // Use the existing router to call a cheap LLM
    const { routeMessage } = require('./llm-router');
    const result = await routeMessage(extractionMessages, env, {
      forceProvider: 'grok',
      forceModel: 'grok-3-mini-fast'
    });

    const raw = result.content || '[]';
    const parsed = JSON.parse(
      raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    );

    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(f => f && f.content && f.content.length >= 15 && f.confidence >= CONFIDENCE_THRESHOLD)
      .slice(0, MAX_FACTS_PER_EXTRACTION);
  } catch (err) {
    console.error('[MEMORY] Extraction failed:', err.message);
    return [];
  }
}

// ===== DECISION ENGINE =====
async function resolveMemoryAction(fact, scope, env) {
  if (fact.confidence < CONFIDENCE_THRESHOLD) {
    return { action: 'NOOP', fact, reason: 'confidence_too_low' };
  }

  const hash = hashNormalized(fact.content);
  const supaUrl = env.SUPABASE_URL;
  const supaKey = env.SUPABASE_ANON_KEY;
  if (!supaUrl || !supaKey) return { action: 'ADD', fact, reason: 'no_supabase' };

  try {
    // 1. Check exact hash duplicate
    const hashPath = `/rest/v1/senna_memories?content_hash=eq.${hash}&status=eq.active&limit=1`;
    if (scope.user_id) {
      const existing = await supabaseRequest(env, 'GET',
        `${hashPath}&user_id=eq.${scope.user_id}`);
      if (existing && existing.length > 0) {
        // Update last_accessed_at
        await supabaseRequest(env, 'PATCH',
          `/rest/v1/senna_memories?id=eq.${existing[0].id}`,
          { last_accessed_at: new Date().toISOString() });
        return { action: 'NOOP', fact, existingId: existing[0].id, reason: 'exact_duplicate' };
      }
    }

    // 2. Check same key in same scope
    if (fact.key && scope.user_id) {
      const keyPath = `/rest/v1/senna_memories?key=eq.${encodeURIComponent(fact.key)}&memory_type=eq.${fact.type}&status=eq.active&user_id=eq.${scope.user_id}&limit=1`;
      const keyMatch = await supabaseRequest(env, 'GET', keyPath);
      if (keyMatch && keyMatch.length > 0) {
        return { action: 'UPDATE', fact, existingId: keyMatch[0].id, reason: 'same_key_updated' };
      }
    }

    // 3. No match — new fact
    return { action: 'ADD', fact, reason: 'new_fact' };
  } catch (err) {
    console.error('[MEMORY] Decision engine error:', err.message);
    return { action: 'ADD', fact, reason: 'decision_error_fallback' };
  }
}

// ===== WRITE QUEUE =====
class MemoryWriteQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.env = null;
    this.pendingWrites = new Map();
    this.interval = setInterval(() => this.flush(), QUEUE_FLUSH_INTERVAL);
  }

  setEnv(env) {
    this.env = env;
  }

  enqueue(item) {
    const key = `${item.scope.user_id || ''}:${item.fact.type}:${hashNormalized(item.fact.content)}`;
    if (this.queue.some(q => q.idempotencyKey === key)) return;
    item.idempotencyKey = key;
    item.enqueuedAt = Date.now();
    item.retryCount = 0;
    this.queue.push(item);
    this.pendingWrites.set(key, item.fact);
  }

  getPendingForUser(userId) {
    return [...this.pendingWrites.values()].filter((_, key) => {
      const k = [...this.pendingWrites.keys()][key] || '';
      return k.startsWith(userId + ':');
    });
  }

  async flush() {
    if (this.processing || this.queue.length === 0 || !this.env) return;
    this.processing = true;

    const batch = this.queue.splice(0, QUEUE_BATCH_SIZE);
    for (const item of batch) {
      try {
        await this.processItem(item);
        this.pendingWrites.delete(item.idempotencyKey);
      } catch (err) {
        console.error('[MEMORY_QUEUE] Write failed:', err.message);
        if (item.retryCount < MAX_RETRIES) {
          item.retryCount++;
          this.queue.push(item);
        } else {
          console.error('[MEMORY_QUEUE] Dropped after retries:', item.idempotencyKey);
          this.pendingWrites.delete(item.idempotencyKey);
          try {
            await supabaseRequest(this.env, 'POST', '/rest/v1/senna_memory_audit', {
              action: 'write_failed',
              actor: 'system',
              new_value: { fact: item.fact, error: err.message },
              reason: 'max_retries_exceeded'
            });
          } catch { /* ignore audit failure */ }
        }
      }
    }
    this.processing = false;
  }

  async processItem(item) {
    const { fact, scope, decision } = item;

    switch (decision.action) {
      case 'ADD': {
        const hash = hashNormalized(fact.content);
        const embedding = generatePseudoEmbedding(fact.content);
        const embeddingStr = `[${embedding.join(',')}]`;

        const memory = {
          user_id: scope.user_id || null,
          agent_id: scope.agent_id || null,
          session_id: scope.session_id || null,
          memory_type: fact.type,
          key: fact.key || null,
          content: fact.content,
          structured_data: fact.structured_data || null,
          source: scope.source || 'conversation',
          source_type: scope.source_type || 'message',
          source_ref: scope.source_ref || null,
          confidence: fact.confidence || 0.80,
          privacy_level: fact.privacy_level || 'internal',
          content_hash: hash,
          last_accessed_at: new Date().toISOString()
        };

        const result = await supabaseRequest(this.env, 'POST', '/rest/v1/senna_memories', memory);
        const memoryId = result?.[0]?.id;

        if (memoryId) {
          // Insert embedding
          await supabaseRequest(this.env, 'POST', '/rest/v1/senna_memory_embeddings', {
            memory_id: memoryId,
            embedding: embeddingStr
          });

          // Audit log
          await supabaseRequest(this.env, 'POST', '/rest/v1/senna_memory_audit', {
            memory_id: memoryId,
            action: 'add',
            actor: 'llm_extractor',
            new_value: memory,
            reason: decision.reason
          });

          console.log(`[MEMORY] ADD: [${fact.type}] ${fact.key || ''} — "${fact.content.substring(0, 60)}..."`);
        }
        break;
      }

      case 'UPDATE': {
        const hash = hashNormalized(fact.content);
        const embedding = generatePseudoEmbedding(fact.content);
        const embeddingStr = `[${embedding.join(',')}]`;

        const updates = {
          content: fact.content,
          structured_data: fact.structured_data || null,
          confidence: Math.max(fact.confidence || 0.80, 0),
          content_hash: hash,
          updated_at: new Date().toISOString(),
          last_accessed_at: new Date().toISOString()
        };

        await supabaseRequest(this.env, 'PATCH',
          `/rest/v1/senna_memories?id=eq.${decision.existingId}`, updates);

        // Update embedding
        await supabaseRequest(this.env, 'DELETE',
          `/rest/v1/senna_memory_embeddings?memory_id=eq.${decision.existingId}`);
        await supabaseRequest(this.env, 'POST', '/rest/v1/senna_memory_embeddings', {
          memory_id: decision.existingId,
          embedding: embeddingStr
        });

        // Audit log
        await supabaseRequest(this.env, 'POST', '/rest/v1/senna_memory_audit', {
          memory_id: decision.existingId,
          action: 'update',
          actor: 'llm_extractor',
          new_value: updates,
          reason: decision.reason
        });

        console.log(`[MEMORY] UPDATE: [${fact.type}] ${fact.key || ''} — "${fact.content.substring(0, 60)}..."`);
        break;
      }

      case 'DELETE': {
        await supabaseRequest(this.env, 'PATCH',
          `/rest/v1/senna_memories?id=eq.${decision.existingId}`,
          { status: 'archived', updated_at: new Date().toISOString() });

        await supabaseRequest(this.env, 'POST', '/rest/v1/senna_memory_audit', {
          memory_id: decision.existingId,
          action: 'archive',
          actor: 'llm_extractor',
          reason: decision.reason
        });

        console.log(`[MEMORY] ARCHIVE: ${decision.existingId}`);
        break;
      }
    }
  }
}

// Singleton queue
const memoryQueue = new MemoryWriteQueue();

// ===== MAIN FLOWS =====

/**
 * Process conversation for memory extraction (called after each response)
 */
async function processConversationMemory(messages, scope, env) {
  memoryQueue.setEnv(env);

  const facts = await extractFacts(messages, env);
  if (facts.length === 0) return { processed: 0, decisions: [] };

  const decisions = [];
  for (const fact of facts) {
    const decision = await resolveMemoryAction(fact, scope, env);
    decisions.push(decision);

    if (decision.action !== 'NOOP') {
      memoryQueue.enqueue({ fact, scope, decision });
    }
  }

  console.log(`[MEMORY] Extracted ${facts.length} facts, ${decisions.filter(d => d.action !== 'NOOP').length} actions queued`);
  return { processed: facts.length, decisions };
}

/**
 * Ingest a business event as memory (deterministic, no LLM needed)
 */
async function ingestBusinessEvent(event, env) {
  memoryQueue.setEnv(env);

  const fact = {
    type: event.memory_type || 'operational',
    key: event.key || `${event.event_type}_${event.entity_id || Date.now()}`,
    content: event.content,
    structured_data: event.data || {},
    confidence: 1.00,
    privacy_level: event.privacy_level || 'internal'
  };

  const scope = {
    user_id: event.user_id || null,
    agent_id: event.agent_id || null,
    source: 'business_event',
    source_type: event.source_type || 'webhook',
    source_ref: event.source_ref || event.entity_id || null
  };

  const decision = await resolveMemoryAction(fact, scope, env);
  if (decision.action !== 'NOOP') {
    memoryQueue.enqueue({ fact, scope, decision });
  }

  return { action: decision.action, reason: decision.reason };
}

/**
 * Retrieve relevant context for a query (called before each LLM response)
 */
async function retrieveContext(query, scope, env, options = {}) {
  const maxResults = options.maxResults || 10;
  const supaUrl = env.SUPABASE_URL;
  const supaKey = env.SUPABASE_ANON_KEY;
  if (!supaUrl || !supaKey || !scope.user_id) return { context: '', memoriesUsed: 0 };

  const allMemories = [];

  try {
    // 1. KV: Always include profile + constraints (always relevant)
    const fixedPath = `/rest/v1/senna_memories?user_id=eq.${scope.user_id}&status=eq.active&memory_type=in.(profile,constraint,preference)&order=memory_type.asc&limit=20`;
    const fixed = await supabaseRequest(env, 'GET', fixedPath);
    if (fixed) {
      fixed.forEach(m => allMemories.push({
        content: m.content, type: m.memory_type, score: 1.0, source: 'kv'
      }));
    }

    // 2. Vector: semantic search for query-relevant memories
    // For now, use key/content text matching since pseudo-embeddings have limited quality
    // Real vector search will use match_senna_memories() with real embeddings in Fase 2
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 5);
    if (words.length > 0) {
      const searchTerms = words.map(w => `content.ilike.*${encodeURIComponent(w)}*`).join('&');
      // Use OR logic: find memories containing any of the key words
      for (const word of words.slice(0, 3)) {
        const searchPath = `/rest/v1/senna_memories?user_id=eq.${scope.user_id}&status=eq.active&memory_type=not.in.(ephemeral)&content=ilike.*${encodeURIComponent(word)}*&limit=5`;
        try {
          const results = await supabaseRequest(env, 'GET', searchPath);
          if (results) {
            results.forEach(m => {
              if (!allMemories.some(am => am.content === m.content)) {
                allMemories.push({
                  content: m.content, type: m.memory_type,
                  score: 0.75, source: 'search'
                });
              }
            });
          }
        } catch { /* ignore individual search errors */ }
      }
    }

    // 3. Recent operational memories
    const recentPath = `/rest/v1/senna_memories?user_id=eq.${scope.user_id}&status=eq.active&memory_type=in.(operational,relationship)&order=updated_at.desc&limit=5`;
    const recent = await supabaseRequest(env, 'GET', recentPath);
    if (recent) {
      recent.forEach(m => {
        if (!allMemories.some(am => am.content === m.content)) {
          allMemories.push({
            content: m.content, type: m.memory_type, score: 0.60, source: 'recent'
          });
        }
      });
    }

    // 4. Session context
    if (scope.session_id) {
      const sessPath = `/rest/v1/senna_memories?session_id=eq.${scope.session_id}&status=eq.active&order=created_at.desc&limit=3`;
      const sess = await supabaseRequest(env, 'GET', sessPath);
      if (sess) {
        sess.forEach(m => allMemories.push({
          content: m.content, type: 'session', score: 0.90, source: 'session'
        }));
      }
    }

    // Update last_accessed_at for retrieved memories (async, non-blocking)
    // (skipped in Fase 1 for simplicity)

  } catch (err) {
    console.error('[MEMORY] Retrieval error:', err.message);
  }

  // Deduplicate and sort by score
  const unique = [];
  const seen = new Set();
  for (const m of allMemories.sort((a, b) => b.score - a.score)) {
    const key = m.content.substring(0, 80);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(m);
    }
  }

  // Format for prompt injection
  const limited = unique.slice(0, maxResults);
  if (limited.length === 0) return { context: '', memoriesUsed: 0 };

  let context = limited
    .map(m => `- [${m.type}] ${m.content}`)
    .join('\n');

  if (context.length > MAX_CONTEXT_CHARS) {
    context = context.substring(0, MAX_CONTEXT_CHARS) + '\n[...]';
  }

  return {
    context: `\nMEMORIA DO SENNA SOBRE ESTE USUARIO:\n${context}`,
    memoriesUsed: limited.length,
    sources: [...new Set(limited.map(m => m.type))]
  };
}

/**
 * Add a memory directly (manual or from API)
 */
async function addMemory(memory, env) {
  memoryQueue.setEnv(env);

  const fact = {
    type: memory.memory_type,
    key: memory.key || null,
    content: memory.content,
    structured_data: memory.structured_data || null,
    confidence: memory.confidence || 0.90,
    privacy_level: memory.privacy_level || 'internal'
  };

  const scope = {
    user_id: memory.user_id || null,
    agent_id: memory.agent_id || null,
    session_id: memory.session_id || null,
    source: memory.source || 'manual',
    source_type: memory.source_type || 'api'
  };

  const decision = await resolveMemoryAction(fact, scope, env);
  if (decision.action !== 'NOOP') {
    memoryQueue.enqueue({ fact, scope, decision });
  }

  return { action: decision.action, reason: decision.reason };
}

/**
 * Search memories by text query
 */
async function searchMemories(userId, query, env, options = {}) {
  const supaUrl = env.SUPABASE_URL;
  if (!supaUrl || !userId) return [];

  let path = `/rest/v1/senna_memories?user_id=eq.${userId}&status=eq.active&order=updated_at.desc`;

  if (options.memory_type) {
    path += `&memory_type=eq.${options.memory_type}`;
  }
  if (query) {
    path += `&content=ilike.*${encodeURIComponent(query)}*`;
  }
  path += `&limit=${options.limit || 20}`;

  try {
    return await supabaseRequest(env, 'GET', path);
  } catch (err) {
    console.error('[MEMORY] Search error:', err.message);
    return [];
  }
}

/**
 * Update a specific memory
 */
async function updateMemory(memoryId, updates, env, actor = 'api') {
  const allowed = ['content', 'structured_data', 'confidence', 'status',
    'privacy_level', 'key', 'memory_type', 'expires_at'];
  const filtered = {};
  for (const key of allowed) {
    if (updates[key] !== undefined) filtered[key] = updates[key];
  }
  filtered.updated_at = new Date().toISOString();

  await supabaseRequest(env, 'PATCH',
    `/rest/v1/senna_memories?id=eq.${memoryId}`, filtered);

  // Audit
  await supabaseRequest(env, 'POST', '/rest/v1/senna_memory_audit', {
    memory_id: memoryId,
    action: 'update',
    actor,
    new_value: filtered,
    reason: 'manual_update'
  });

  // Update embedding if content changed
  if (filtered.content) {
    const embedding = generatePseudoEmbedding(filtered.content);
    const embeddingStr = `[${embedding.join(',')}]`;
    await supabaseRequest(env, 'DELETE',
      `/rest/v1/senna_memory_embeddings?memory_id=eq.${memoryId}`);
    await supabaseRequest(env, 'POST', '/rest/v1/senna_memory_embeddings', {
      memory_id: memoryId, embedding: embeddingStr
    });
    // Update hash
    await supabaseRequest(env, 'PATCH',
      `/rest/v1/senna_memories?id=eq.${memoryId}`,
      { content_hash: hashNormalized(filtered.content) });
  }

  return { updated: true };
}

/**
 * Delete (archive) a memory
 */
async function deleteMemory(memoryId, env, actor = 'api') {
  await supabaseRequest(env, 'PATCH',
    `/rest/v1/senna_memories?id=eq.${memoryId}`,
    { status: 'archived', updated_at: new Date().toISOString() });

  await supabaseRequest(env, 'POST', '/rest/v1/senna_memory_audit', {
    memory_id: memoryId,
    action: 'archive',
    actor,
    reason: 'manual_delete'
  });

  return { archived: true };
}

/**
 * Get memory history (audit trail)
 */
async function getMemoryHistory(memoryId, env) {
  return supabaseRequest(env, 'GET',
    `/rest/v1/senna_memory_audit?memory_id=eq.${memoryId}&order=created_at.desc&limit=50`);
}

/**
 * Export all user memories (LGPD)
 */
async function exportUserMemories(userId, env) {
  return supabaseRequest(env, 'GET',
    `/rest/v1/senna_memories?user_id=eq.${userId}&order=created_at.desc`);
}

/**
 * Purge all user memories (LGPD right to be forgotten)
 */
async function purgeUserMemories(userId, env, actor = 'admin') {
  // Mark all as blocked (not physical delete — keep 90 days for audit)
  await supabaseRequest(env, 'PATCH',
    `/rest/v1/senna_memories?user_id=eq.${userId}&status=neq.blocked`,
    { status: 'blocked', updated_at: new Date().toISOString() });

  await supabaseRequest(env, 'POST', '/rest/v1/senna_memory_audit', {
    action: 'purge_user',
    actor,
    new_value: { user_id: userId },
    reason: 'lgpd_right_to_be_forgotten'
  });

  return { purged: true };
}

/**
 * Memory health stats
 */
async function getMemoryHealth(env) {
  try {
    const all = await supabaseRequest(env, 'GET',
      '/rest/v1/senna_memories?select=status,memory_type,confidence&limit=10000');

    if (!all) return {};

    const byStatus = {};
    const byType = {};
    let lowConfidence = 0;

    all.forEach(m => {
      byStatus[m.status] = (byStatus[m.status] || 0) + 1;
      byType[m.memory_type] = (byType[m.memory_type] || 0) + 1;
      if (parseFloat(m.confidence) < 0.50) lowConfidence++;
    });

    return {
      total: all.length,
      byStatus,
      byType,
      lowConfidence,
      queueSize: memoryQueue.queue.length
    };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = {
  processConversationMemory,
  ingestBusinessEvent,
  retrieveContext,
  addMemory,
  searchMemories,
  updateMemory,
  deleteMemory,
  getMemoryHistory,
  exportUserMemories,
  purgeUserMemories,
  getMemoryHealth,
  extractFacts,
  resolveMemoryAction,
  memoryQueue
};
