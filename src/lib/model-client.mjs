import { createHash } from 'node:crypto';

export const DEFAULT_MODEL_BATCH_SIZE = 10;
export const DEFAULT_MODEL_CONCURRENCY = 2;
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;

export function compact(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function cardModelInput(card, id) {
  return {
    id,
    name: compact(card.name, 160),
    creator: compact(card.creator, 120),
    tags: (Array.isArray(card.tags) ? card.tags : []).slice(0, 30).map((tag) => compact(tag, 80)),
    description: compact(card.description, 1_000),
    personality: compact(card.personality, 650),
    scenario: compact(card.scenario, 650),
    creator_notes: compact(card.creator_notes, 350),
    first_mes: compact(card.first_mes, 750),
  };
}

export function hasSemanticContent(input) {
  return Boolean(input.name || input.creator || input.tags.length || input.description || input.personality
    || input.scenario || input.creator_notes || input.first_mes);
}

export function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

function positiveInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} 必须是正整数`);
  return value;
}

export function modelSettingsFromEnv() {
  const baseUrl = String(process.env.MODEL_API_BASE_URL ?? '').replace(/\/$/, '');
  const model = String(process.env.MODEL_NAME ?? '').trim();
  if (!baseUrl || !model) throw new Error('必须设置 MODEL_API_BASE_URL 和 MODEL_NAME');
  const confidenceThreshold = Number.parseFloat(process.env.MODEL_CONFIDENCE_THRESHOLD ?? String(DEFAULT_CONFIDENCE_THRESHOLD));
  if (!(confidenceThreshold >= 0 && confidenceThreshold <= 1)) throw new Error('MODEL_CONFIDENCE_THRESHOLD 必须介于 0 与 1 之间');
  return {
    url: baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`,
    apiKey: process.env.MODEL_API_KEY ?? '',
    model,
    batchSize: positiveInteger('MODEL_BATCH_SIZE', DEFAULT_MODEL_BATCH_SIZE),
    concurrency: positiveInteger('MODEL_CONCURRENCY', DEFAULT_MODEL_CONCURRENCY),
    confidenceThreshold,
  };
}

export function parseModelJson(text) {
  const cleaned = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function requestModelJson(settings, messages) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const headers = { 'content-type': 'application/json' };
      if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;
      const response = await fetch(settings.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: settings.model, temperature: 0, messages }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${compact(await response.text(), 300)}`);
      const payload = await response.json();
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('模型响应缺少 choices[0].message.content');
      return parseModelJson(content);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(250 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

export async function runWorkers(items, concurrency, worker) {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}
