const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

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
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const DIR = __dirname;
const SERVER_START_TIME = new Date().toISOString();

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
  // API Proxy: /api/grok
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

  // API Proxy: /api/tts
  if (req.url === '/api/tts' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      const postData = JSON.stringify(parsed);

      proxyRequest({
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: `/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Length': Buffer.byteLength(postData)
        }
      }, postData, res);
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
});
