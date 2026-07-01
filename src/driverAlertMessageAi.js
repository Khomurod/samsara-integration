/**
 * Friendly driver-group captions for Samsara safety alerts (Groq → Gemini → standard text).
 */
const { callGroqWithFallback, isAuthOrConfigError } = require('./groqClient');
const { callGeminiText, GEMINI_API_KEY } = require('./geminiClient');

const SYSTEM_TEXT =
  'You write short Telegram messages to truck drivers at Wenze Investments LLC. '
  + 'Return only the message body as Telegram HTML. No markdown fences or JSON. '
  + 'Use only <b> and <i> tags for formatting. '
  + 'Tone: warm, respectful, lightly humorous — never shaming, scary, sarcastic, or mocking. '
  + 'Do not include hashtags, severity tables, or copy the full ops alert format.';

function extractFirstName(driverName) {
  const raw = String(driverName || '').trim();
  if (!raw || /^unknown/i.test(raw)) return null;
  const withoutHash = raw.replace(/^#+/, '').trim();
  const parts = withoutHash.split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const first = parts[0];
  if (/^\d+$/.test(first) && parts.length > 1) return parts[1];
  return first;
}

function extractUnitNumber(vehicleName) {
  const raw = String(vehicleName || '').trim();
  const match = raw.match(/^(\d+)/);
  return match ? match[1] : null;
}

function shouldUseFriendlyCaption(alertData, matchReason) {
  if (!alertData || alertData.isCrash) return false;
  if (String(matchReason || '').startsWith('fallback')) return false;
  return true;
}

function buildDriverAlertPrompt(alertData) {
  const eventLabel = String(alertData.eventLabel || 'Safety event').trim();
  const firstName = extractFirstName(alertData.driverName);
  const unit = extractUnitNumber(alertData.vehicleName);
  const greeting = firstName ? `Address the driver as ${firstName}.` : 'Use a friendly generic greeting.';

  return (
    `${greeting}\n\n`
    + `Event type: ${eventLabel}\n`
    + (unit ? `Unit number: ${unit}\n` : '')
    + '\nWrite a message for the driver about this safety event:\n'
    + '- 2–4 short sentences with kind, light humor (appropriate to the event).\n'
    + '- End with one clear line asking them to stay careful on the road.\n'
    + '- Do not list severity, intensity, or technical ops details.\n'
    + '- Do not threaten discipline or sound angry.\n'
    + '- Return the message only, no preamble.'
  );
}

function parseDriverMessageResponse(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fence = raw.match(/```(?:html|text)?\s*([\s\S]*?)```/i);
  const candidate = (fence ? fence[1] : raw).trim();
  if (!candidate || candidate.length < 40) return null;
  if (candidate.length > 900) return candidate.slice(0, 900);
  return candidate;
}

async function generateViaGroq(prompt) {
  const { text, model } = await callGroqWithFallback(prompt, {
    systemText: SYSTEM_TEXT,
    temperature: 0.85,
    maxTokens: 400,
    models: [
      process.env.GROQ_AI_FAST_MODEL || 'llama-3.1-8b-instant',
      process.env.GROQ_AI_MODEL || 'llama-3.3-70b-versatile',
    ],
  });
  const message = parseDriverMessageResponse(text);
  return message ? { message, provider: 'groq', model } : null;
}

async function generateViaGemini(prompt) {
  const { text, model } = await callGeminiText({
    systemText: SYSTEM_TEXT,
    userText: prompt,
    maxOutputTokens: 400,
    generationConfig: { temperature: 0.85 },
  });
  const message = parseDriverMessageResponse(text);
  return message ? { message, provider: 'gemini', model } : null;
}

async function generateFriendlyMessage(alertData) {
  const prompt = buildDriverAlertPrompt(alertData);

  try {
    const groq = await generateViaGroq(prompt);
    if (groq?.message) return groq.message;
    if (GEMINI_API_KEY) {
      const gemini = await generateViaGemini(prompt);
      if (gemini?.message) return gemini.message;
    }
  } catch (groqErr) {
    if (GEMINI_API_KEY && !isAuthOrConfigError(groqErr.message)) {
      console.warn('[SAMSARA-DRIVER-AI] Groq failed, trying Gemini:', groqErr.message.slice(0, 200));
      try {
        const gemini = await generateViaGemini(prompt);
        if (gemini?.message) return gemini.message;
      } catch (geminiErr) {
        console.error('[SAMSARA-DRIVER-AI] Gemini failed:', geminiErr.message.slice(0, 200));
      }
    } else {
      console.warn('[SAMSARA-DRIVER-AI] Groq failed:', groqErr.message.slice(0, 200));
    }
  }

  return null;
}

async function resolveDriverCaption(alertData, standardText) {
  if (!alertData || alertData.isCrash) return standardText;
  const generated = await generateFriendlyMessage(alertData);
  return generated || standardText;
}

module.exports = {
  shouldUseFriendlyCaption,
  buildDriverAlertPrompt,
  parseDriverMessageResponse,
  extractFirstName,
  extractUnitNumber,
  resolveDriverCaption,
};
