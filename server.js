import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

async function loadDotEnv() {
  try {
    const contents = await fs.readFile(path.join(root, '.env'), 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Could not read .env:', error.message);
    }
  }
}

await loadDotEnv();

const port = Number(process.env.PORT || 3000);
const textModel = process.env.GROQ_TEXT_MODEL || 'qwen/qwen3.8-27b';
const visionModel = process.env.GROQ_VISION_MODEL || '';
const maxBodyBytes = 7 * 1024 * 1024;
const rateWindowMs = 60_000;
const rateLimit = 30;
const requestCounts = new Map();
let modelCatalog = null;
let modelCatalogCheckedAt = 0;
let providerState = 'not_checked';
let chatVerified = false;

function isPlaceholderKey(key) {
  return !key || /^(your[_-].*|replace[_-].*|gsk_placeholder)$/i.test(key.trim());
}

function providerReady() {
  return Boolean(process.env.GROQ_API_KEY && !isPlaceholderKey(process.env.GROQ_API_KEY));
}

function providerErrorState(status) {
  if (status === 401 || status === 403) return 'provider_auth_failed';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  return 'model_unavailable';
}

async function getModelCatalog() {
  if (!providerReady()) {
    providerState = 'credential_missing';
    return null;
  }
  if (modelCatalog && Date.now() - modelCatalogCheckedAt < 30_000) return modelCatalog;
  try {
    const response = await fetch('https://api.groq.com/openai/v1/models', {
      headers: {Authorization: `Bearer ${process.env.GROQ_API_KEY}`},
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) {
      providerState = providerErrorState(response.status);
      modelCatalog = null;
      return null;
    }
    const body = await response.json();
    modelCatalog = Array.isArray(body.data) ? body.data : [];
    modelCatalogCheckedAt = Date.now();
    providerState = 'provider_reachable';
    return modelCatalog;
  } catch {
    providerState = 'provider_unavailable';
    modelCatalog = null;
    return null;
  }
}

function modelIsAvailable(catalog, model) {
  return Boolean(model && catalog?.some(item => item.id === model && item.active !== false));
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(body));
}

function hasImage(messages) {
  return messages.some(message =>
    Array.isArray(message.content) &&
    message.content.some(part => part?.type === 'image_url' && part.image_url?.url)
  );
}

function validMessages(messages) {
  return messages.every(message => {
    if (!message || !['user', 'assistant', 'system'].includes(message.role)) return false;
    if (typeof message.content === 'string') return message.content.length > 0 && message.content.length <= 200_000;
    return Array.isArray(message.content) && message.content.length > 0 &&
      message.content.every(part =>
        part?.type === 'text' && typeof part.text === 'string' && part.text.length <= 200_000 ||
        part?.type === 'image_url' &&
        typeof part.image_url?.url === 'string' &&
        /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(part.image_url.url)
      );
  });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error('Request too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html')) {
    try {
      const html = await fs.readFile(path.join(root, 'public', 'index.html'));
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(html);
    } catch {
      sendJson(res, 500, { error: { message: 'Frontend is unavailable' } });
    }
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/health') {
    const catalog = await getModelCatalog();
    const textAvailable = modelIsAvailable(catalog, textModel);
    const visionAvailable = modelIsAvailable(catalog, visionModel);
    const status = !providerReady() ? 'credential_missing' :
      !catalog ? providerState :
      !textAvailable ? 'model_unavailable' :
      chatVerified ? 'connected' : 'provider_reachable';
    sendJson(res, 200, {
      status: 'ok',
      configured: providerReady(),
      environmentLoaded: true,
      credentialPlaceholder: isPlaceholderKey(process.env.GROQ_API_KEY),
      providerReady: status === 'connected' || status === 'provider_reachable',
      providerStatus: status,
      chatVerified,
      models: {
        text: {id: textModel, available: textAvailable},
        vision: {id: visionModel || null, available: visionAvailable}
      }
    });
    return;
  }

  if (req.method !== 'POST' || requestUrl.pathname !== '/api/chat') {
    sendJson(res, 404, { error: { message: 'Not found' } });
    return;
  }
  const clientAddress = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recentRequests = (requestCounts.get(clientAddress) || []).filter(time => now - time < rateWindowMs);
  if (recentRequests.length >= rateLimit) {
    sendJson(res, 429, { error: { message: 'Too many requests. Please try again shortly.' } });
    return;
  }
  recentRequests.push(now);
  requestCounts.set(clientAddress, recentRequests);

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (error) {
    sendJson(res, error.statusCode || 400, {
      error: { message: error.statusCode === 413 ? error.message : 'Invalid JSON' }
    });
    return;
  }

  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 100 ||
      !validMessages(body.messages)) {
    sendJson(res, 400, { error: { message: 'Invalid message history' } });
    return;
  }
  if (!providerReady()) {
    sendJson(res, 503, { error: { message: 'Groq API key is not configured. Add a real GROQ_API_KEY to .env and restart the server.' } });
    return;
  }

  const catalog = await getModelCatalog();
  const imageRequest = hasImage(body.messages);
  const model = imageRequest ? visionModel : textModel;
  if (!catalog || !modelIsAvailable(catalog, model)) {
    providerState = 'model_unavailable';
    sendJson(res, 503, {
      error: {
        message: imageRequest
          ? 'No accessible vision model is configured for this Groq account.'
          : `Configured text model "${textModel}" is not available to this Groq account.`
      }
    });
    return;
  }
  try {
    const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model, messages: body.messages, stream: false }),
      signal: AbortSignal.timeout(60_000)
    });
    const result = await upstream.text();
    if (!upstream.ok) {
      providerState = providerErrorState(upstream.status);
      res.writeHead(upstream.status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(result);
      return;
    }
    const responseBody = JSON.parse(result);
    if (!responseBody.choices?.[0]?.message?.content) {
      providerState = 'provider_unavailable';
      sendJson(res, 502, {error: {message: 'Groq returned an empty assistant response.'}});
      return;
    }
    chatVerified = true;
    providerState = 'connected';
    res.writeHead(upstream.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(result);
  } catch (error) {
    sendJson(res, error.name === 'TimeoutError' ? 504 : 502, {
      error: { message: error.name === 'TimeoutError' ? 'AI request timed out' : 'Could not reach Groq API' }
    });
  }
});

server.listen(port, () => console.log(`Kyro AI running at http://localhost:${port}`));
