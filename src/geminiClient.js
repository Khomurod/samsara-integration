// services/geminiClient.js — shared Gemini generateContent with model fallback
require('dotenv').config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_GENERATE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const DEFAULT_GEMINI_TEXT_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-3.1-flash',
  'gemini-2.0-flash',
];

const DISPATCH_GEMINI_MODELS_EXTRA = [
  'gemma-3-12b-it',
  'gemma-3-4b-it',
  'gemma-3-1b-it',
];

const GEMINI_TEXT_MODELS = parseGeminiModelList(
  process.env.GEMINI_TEXT_MODELS,
  DEFAULT_GEMINI_TEXT_MODELS
);

const GEMINI_DISPATCH_MODELS = uniqueGeminiModels([
  ...GEMINI_TEXT_MODELS,
  ...DISPATCH_GEMINI_MODELS_EXTRA,
]);

const GEMINI_MAX_ATTEMPTS_PER_MODEL = 2;
const DEFAULT_MAX_RETRY_WAIT_MS = 35_000;

function parseGeminiModelList(envValue, fallbackList) {
  const fromEnv = String(envValue || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : [...fallbackList];
}

function uniqueGeminiModels(models) {
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

function resolveGeminiModels(opts = {}) {
  if (Array.isArray(opts.models) && opts.models.length > 0) {
    return uniqueGeminiModels(opts.models);
  }
  return [...GEMINI_TEXT_MODELS];
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function stripJsonFences(text) {
  return String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function safeParseJsonObject(text) {
  const raw = stripJsonFences(text);
  try {
    const direct = JSON.parse(raw);
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;
  } catch {
    // continue
  }
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const slice = JSON.parse(raw.slice(firstBrace, lastBrace + 1));
      if (slice && typeof slice === 'object' && !Array.isArray(slice)) return slice;
    } catch {
      return null;
    }
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseGeminiRetryAfterMs(response, errorMessage) {
  const header = response?.headers?.get?.('retry-after');
  if (header) {
    const seconds = Number.parseFloat(header);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.ceil(seconds * 1000);
    }
  }
  const bodyMatch = String(errorMessage || '').match(/retry in\s+([\d.]+)\s*s/i);
  if (bodyMatch) {
    const seconds = Number.parseFloat(bodyMatch[1]);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.ceil(seconds * 1000);
    }
  }
  return 0;
}

function isGeminiQuotaExhaustedError(status, message) {
  const normalized = String(message || '').toLowerCase();
  return status === 429 && (
    normalized.includes('quota')
    || normalized.includes('resource_exhausted')
    || normalized.includes('limit')
    || normalized.includes('daily')
    || normalized.includes('exceeded')
  );
}

function isGeminiTransientError(status, message) {
  const normalized = String(message || '').toLowerCase();
  return status === 429
    || status === 503
    || status >= 500
    || normalized.includes('high demand')
    || normalized.includes('try again')
    || normalized.includes('temporarily unavailable');
}

function extractGeminiText(payload) {
  return (payload?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part?.text || '')
    .join('')
    .trim();
}

/**
 * Low-level Gemini call with model chain.
 * @returns {{ text, model, payload }}
 */
async function callGeminiGenerateContent(opts = {}) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const models = resolveGeminiModels(opts);
  const maxRetryWaitMs = opts.maxRetryWaitMs ?? DEFAULT_MAX_RETRY_WAIT_MS;
  const maxAttemptsPerModel = opts.maxAttemptsPerModel ?? GEMINI_MAX_ATTEMPTS_PER_MODEL;
  const attemptErrors = [];

  for (const model of models) {
    for (let attempt = 0; attempt < maxAttemptsPerModel; attempt += 1) {
      try {
        const generationConfig = { ...(opts.generationConfig || {}) };
        if (generationConfig.temperature == null && !/^gemini-3/i.test(model)) {
          generationConfig.temperature = 0.1;
        }

        const body = {
          contents: opts.contents,
          generationConfig,
        };
        if (opts.systemInstruction) {
          body.system_instruction = opts.systemInstruction;
        }

        const response = await fetch(
          `${GEMINI_GENERATE_URL}/${encodeURIComponent(model)}:generateContent`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': GEMINI_API_KEY,
            },
            body: JSON.stringify(body),
          }
        );

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          const apiMessage = payload?.error?.message || `Gemini request failed with status ${response.status}`;
          const err = new Error(apiMessage);
          err.status = response.status;
          err.retryAfterMs = parseGeminiRetryAfterMs(response, apiMessage);

          if (isGeminiQuotaExhaustedError(response.status, apiMessage)) {
            attemptErrors.push({ model, status: response.status, message: apiMessage });
            break;
          }

          if (attempt + 1 < maxAttemptsPerModel && isGeminiTransientError(response.status, apiMessage)) {
            const waitMs = Math.min(err.retryAfterMs || 750, maxRetryWaitMs);
            if (waitMs > 0) await sleep(waitMs);
            continue;
          }

          attemptErrors.push({ model, status: response.status, message: apiMessage });
          break;
        }

        const text = extractGeminiText(payload);
        if (!text) {
          const finishReason = payload?.candidates?.[0]?.finishReason || 'UNKNOWN';
          attemptErrors.push({
            model,
            status: null,
            message: `Gemini returned empty response (${finishReason})`,
          });
          break;
        }

        if (typeof opts.validateResult === 'function') {
          const validation = opts.validateResult(text, payload);
          if (validation !== true) {
            attemptErrors.push({
              model,
              status: null,
              message: validation?.message || 'Gemini response validation failed',
            });
            break;
          }
        }

        return { text, model, payload };
      } catch (err) {
        attemptErrors.push({ model, status: err.status || null, message: err.message });
        break;
      }
    }
  }

  const details = attemptErrors.map((e) => `${e.model}: ${e.message}`).join('; ');
  const failure = new Error(details || 'All Gemini models failed');
  failure.attemptErrors = attemptErrors;
  throw failure;
}

async function callGeminiText(opts = {}) {
  const systemText = opts.systemText ? String(opts.systemText) : '';
  const userText = opts.userText != null ? String(opts.userText) : String(opts.promptText || '');
  const parts = [{ text: userText }];
  if (opts.extraParts?.length) {
    parts.push(...opts.extraParts);
  }

  const contents = [{ parts }];
  const generationConfig = {
    maxOutputTokens: opts.maxOutputTokens ?? 800,
    responseMimeType: opts.responseMimeType || 'text/plain',
    ...(opts.generationConfig || {}),
  };

  const requestOpts = {
    models: opts.models,
    contents,
    generationConfig,
    maxRetryWaitMs: opts.maxRetryWaitMs,
    validateResult: opts.validateResult,
  };

  if (systemText) {
    requestOpts.systemInstruction = { parts: [{ text: systemText }] };
  }

  return callGeminiGenerateContent(requestOpts);
}

async function callGeminiJson(opts = {}) {
  const userValidateParsed = opts.validateParsed;
  const result = await callGeminiText({
    ...opts,
    responseMimeType: opts.responseMimeType || 'application/json',
    validateResult: (text) => {
      const parsed = safeParseJsonObject(text);
      if (!parsed) {
        return { message: 'Gemini returned non-JSON output' };
      }
      if (typeof userValidateParsed === 'function' && userValidateParsed(parsed) !== true) {
        return { message: 'Gemini JSON failed validation' };
      }
      return true;
    },
  });
  const parsed = safeParseJsonObject(result.text);
  return { parsed, text: result.text, model: result.model, payload: result.payload };
}

function getPinnedContextGeminiModels() {
  const fromEnv = parseGeminiModelList(process.env.GEMINI_PINNED_CONTEXT_MODELS, []);
  return fromEnv.length ? fromEnv : [...GEMINI_TEXT_MODELS];
}

module.exports = {
  GEMINI_API_KEY,
  GEMINI_TEXT_MODELS,
  GEMINI_DISPATCH_MODELS,
  GEMINI_MAX_ATTEMPTS_PER_MODEL,
  parseGeminiModelList,
  getPinnedContextGeminiModels,
  safeParseJsonObject,
  stripJsonFences,
  isGeminiQuotaExhaustedError,
  isGeminiTransientError,
  parseGeminiRetryAfterMs,
  extractGeminiText,
  callGeminiGenerateContent,
  callGeminiText,
  callGeminiJson,
};
