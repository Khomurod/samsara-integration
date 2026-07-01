// services/groqClient.js
//
// Shared Groq chat-completions client used by:
//   - aiAnalysisService.js   (legacy company / driver reports)
//   - aiAnnotationService.js (per-message classifier)
//   - aiInsightsService.js   (narrative generation)
//   - aiAskService.js        ("Ask the Data" plan + narrative)
//   - datUiInspectorService.js (DAT layout inspector)
//   - dispatchPinnedContextService.js / dispatchParserService.js
//
require('dotenv').config();

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_AI_MODEL = process.env.GROQ_AI_MODEL || 'llama-3.3-70b-versatile';
const GROQ_AI_FAST_MODEL = process.env.GROQ_AI_FAST_MODEL || 'llama-3.1-8b-instant';

const DEFAULT_GROQ_FALLBACK_CHAIN = [
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'openai/gpt-oss-20b',
];

const GROQ_AI_FALLBACK_MODELS = parseModelList(
  process.env.GROQ_AI_FALLBACK_MODELS,
  DEFAULT_GROQ_FALLBACK_CHAIN
);

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRY_WAIT_MS = 35_000;
const INTERACTIVE_MAX_RETRY_WAIT_MS = 8_000;

function parseModelList(envValue, fallbackList) {
  const fromEnv = String(envValue || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : [...fallbackList];
}

function uniqueModels(models) {
  const seen = new Set();
  const out = [];
  for (const m of models) {
    const key = String(m || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function resolveModelChain(opts = {}) {
  if (Array.isArray(opts.models) && opts.models.length > 0) {
    return uniqueModels(opts.models);
  }
  const primary = opts.model || GROQ_AI_MODEL;
  return uniqueModels([primary, ...GROQ_AI_FALLBACK_MODELS]);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isAuthOrConfigError(message) {
  const m = String(message || '').toLowerCase();
  return (
    m.includes('not configured')
    || m.includes('401')
    || m.includes('403')
    || m.includes('invalid api key')
    || m.includes('unauthorized')
  );
}

function isGroqRateLimitError(status, message) {
  return status === 429
    || status === 503
    || status >= 500
    || /rate limit/i.test(message || '')
    || /too many requests/i.test(message || '')
    || /service unavailable/i.test(message || '')
    || /try again/i.test(message || '');
}

function parseRetryAfterMs(response, errorMessage) {
  const header = response?.headers?.get?.('retry-after');
  if (header) {
    const seconds = Number.parseFloat(header);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.ceil(seconds * 1000);
    }
  }
  const bodyMatch = String(errorMessage || '').match(/try again in\s+([\d.]+)\s*s/i);
  if (bodyMatch) {
    const seconds = Number.parseFloat(bodyMatch[1]);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.ceil(seconds * 1000);
    }
  }
  return 0;
}

function buildGroqRequestBody(opts, model) {
  let messages;
  if (Array.isArray(opts.messages) && opts.messages.length > 0) {
    messages = opts.messages;
  } else {
    messages = [];
    if (opts.systemText) messages.push({ role: 'system', content: String(opts.systemText) });
    messages.push({ role: 'user', content: String(opts.promptText ?? '') });
  }

  const body = {
    model,
    messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 2000,
  };

  if (opts.responseFormat) {
    body.response_format = opts.responseFormat;
  }
  if (opts.seed != null) {
    body.seed = opts.seed;
  }
  if (opts.maxCompletionTokens != null) {
    body.max_completion_tokens = opts.maxCompletionTokens;
    delete body.max_tokens;
  }

  return JSON.stringify(body);
}

async function callGroqOnce(model, opts) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: buildGroqRequestBody(opts, model),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const rawText = await response.text().catch(() => '');
    let payload = {};
    try {
      payload = rawText ? JSON.parse(rawText) : {};
    } catch (_) {
      payload = {};
    }
    const apiMessage = payload?.error?.message || rawText.slice(0, 400);

    if (response.status === 401 || response.status === 403) {
      const err = new Error(`Groq API ${response.status}: ${apiMessage}`);
      err.status = response.status;
      err.model = model;
      throw err;
    }

    if (!response.ok) {
      const err = new Error(`Groq API ${response.status}: ${apiMessage}`);
      err.status = response.status;
      err.model = model;
      err.retryAfterMs = parseRetryAfterMs(response, apiMessage);
      throw err;
    }

    const text = String(payload?.choices?.[0]?.message?.content || '').trim();
    return { text, model, response, payload };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      const timeoutErr = new Error(`Groq API timeout after ${timeoutMs}ms`);
      timeoutErr.model = model;
      throw timeoutErr;
    }
    throw err;
  }
}

/**
 * Try models in order; on 429/5xx wait (respecting retry-after) then try next model.
 * Returns { text, model }.
 */
async function callGroqWithFallback(promptText, opts = {}) {
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not configured');
  }

  const models = resolveModelChain(opts);
  if (!models.length) {
    throw new Error('No Groq models configured');
  }

  const maxRetryWaitMs = opts.maxRetryWaitMs ?? DEFAULT_MAX_RETRY_WAIT_MS;
  const requestOpts = { ...opts, promptText };
  const attemptErrors = [];

  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    try {
      const result = await callGroqOnce(model, requestOpts);
      if (typeof opts.validateResult === 'function') {
        const validation = opts.validateResult(result.text, result.payload);
        if (validation !== true) {
          const message = validation?.message || 'Response validation failed';
          attemptErrors.push({ model, status: null, message });
          continue;
        }
      }
      return { text: result.text, model: result.model };
    } catch (err) {
      const status = err.status || null;
      const message = err.message || String(err);
      attemptErrors.push({ model, status, message });

      if (isAuthOrConfigError(message)) {
        const authErr = new Error(message);
        authErr.attemptErrors = attemptErrors;
        throw authErr;
      }

      const isLast = i === models.length - 1;
      if (!isLast && isGroqRateLimitError(status, message)) {
        const waitMs = Math.min(err.retryAfterMs || 750, maxRetryWaitMs);
        if (waitMs > 0) {
          await sleep(waitMs);
        }
        continue;
      }

      if (!isLast && status >= 500) {
        await sleep(Math.min(1000, maxRetryWaitMs));
        continue;
      }
    }
  }

  const details = attemptErrors.map((e) => `${e.model}: ${e.message}`).join('; ');
  const failure = new Error(details || 'All Groq models failed');
  failure.attemptErrors = attemptErrors;
  failure.allRateLimited = attemptErrors.length > 0
    && attemptErrors.every((e) => isGroqRateLimitError(e.status, e.message));
  throw failure;
}

/** Backward-compatible: returns text only, uses full fallback chain from opts.model or GROQ_AI_MODEL. */
async function callGroqRaw(promptText, opts = {}) {
  const { text } = await callGroqWithFallback(promptText, opts);
  return text;
}

module.exports = {
  callGroqRaw,
  callGroqWithFallback,
  callGroqOnce,
  isAuthOrConfigError,
  isGroqRateLimitError,
  parseRetryAfterMs,
  parseModelList,
  resolveModelChain,
  uniqueModels,
  GROQ_API_URL,
  GROQ_API_KEY,
  GROQ_AI_MODEL,
  GROQ_AI_FAST_MODEL,
  GROQ_AI_FALLBACK_MODELS,
  DEFAULT_MAX_RETRY_WAIT_MS,
  INTERACTIVE_MAX_RETRY_WAIT_MS,
};
