import { createHash } from 'node:crypto';

export const DEFAULT_MODEL_BATCH_SIZE = 10;
export const DEFAULT_MODEL_CONCURRENCY = 2;
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;
export const DEFAULT_MODEL_MAX_ATTEMPTS = 2;
export const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 2_048;

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

function boundedPositiveInteger(name, fallback, maximum) {
  const value = positiveInteger(name, fallback);
  if (value > maximum) throw new Error(`${name} 不能大于 ${maximum}`);
  return value;
}

function configuredText(name, fallback = '') {
  const configured = String(process.env[name] ?? '').trim();
  return configured || String(fallback ?? '').trim();
}

export function modelSettingsFromEnv(defaults = {}) {
  const configuredBaseUrl = String(process.env.MODEL_API_BASE_URL ?? '').trim();
  const baseUrl = configuredText('MODEL_API_BASE_URL', defaults.baseUrl).replace(/\/$/, '');
  const model = configuredText('MODEL_NAME', defaults.model);
  if (!baseUrl || !model) throw new Error('必须设置 MODEL_API_BASE_URL 和 MODEL_NAME，或由当前阶段提供默认值');
  const confidenceThreshold = Number.parseFloat(process.env.MODEL_CONFIDENCE_THRESHOLD ?? String(DEFAULT_CONFIDENCE_THRESHOLD));
  if (!(confidenceThreshold >= 0 && confidenceThreshold <= 1)) throw new Error('MODEL_CONFIDENCE_THRESHOLD 必须介于 0 与 1 之间');
  const apiKey = configuredText('CHEESE_API_KEY') || configuredText('MODEL_API_KEY') || String(defaults.apiKey ?? '');
  const usingDefaultBaseUrl = !configuredBaseUrl;
  if (defaults.requireApiKeyForDefault && usingDefaultBaseUrl && !apiKey) {
    throw new Error('使用当前阶段默认起司 API 时必须设置 CHEESE_API_KEY（兼容 MODEL_API_KEY）');
  }
  return {
    baseUrl,
    url: baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`,
    apiKey,
    model,
    batchSize: positiveInteger('MODEL_BATCH_SIZE', defaults.batchSize ?? DEFAULT_MODEL_BATCH_SIZE),
    concurrency: boundedPositiveInteger('MODEL_CONCURRENCY', defaults.concurrency ?? DEFAULT_MODEL_CONCURRENCY, 10),
    maxAttempts: boundedPositiveInteger('MODEL_MAX_ATTEMPTS', defaults.maxAttempts ?? DEFAULT_MODEL_MAX_ATTEMPTS, 3),
    maxOutputTokens: positiveInteger('MODEL_MAX_OUTPUT_TOKENS', defaults.maxOutputTokens ?? DEFAULT_MODEL_MAX_OUTPUT_TOKENS),
    confidenceThreshold,
    usingDefaultBaseUrl,
  };
}

export function parseModelJson(text) {
  const cleaned = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ModelRequestError extends Error {
  constructor(message, { status = null, retryable = false, fatal = false, splittable = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ModelRequestError';
    this.status = status;
    this.retryable = retryable;
    this.fatal = fatal;
    this.splittable = splittable;
  }
}

export class ModelBudgetExceededError extends Error {
  constructor(limit, metric = 'HTTP 请求') {
    super(`已达到本次运行的${metric}硬上限 ${limit}，为避免继续产生费用而停止`);
    this.name = 'ModelBudgetExceededError';
    this.fatal = true;
  }
}

export function isFatalModelError(error) {
  return error?.fatal === true || error instanceof ModelBudgetExceededError;
}

export function summarizeRequestEvents(events) {
  let requests = 0; let inputBytes = 0;
  for (const event of events) {
    const reserved = event?.event === 'request_reserved';
    const legacyAttempt = !event?.event && ['success', 'error'].includes(event?.outcome);
    if (!reserved && !legacyAttempt) continue;
    requests += 1;
    const bytes = Number(event?.request_bytes ?? 0);
    if (Number.isFinite(bytes) && bytes > 0) inputBytes += bytes;
  }
  return { requests, inputBytes };
}

export function createRequestBudget(limit, maxInputBytes = null, initial = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('HTTP 请求上限必须是正整数');
  if (maxInputBytes !== null && (!Number.isInteger(maxInputBytes) || maxInputBytes < 1)) throw new Error('输入字节上限必须是正整数');
  const initialUsed = Number(initial.used ?? 0); const initialInputBytes = Number(initial.inputBytes ?? 0);
  if (!Number.isInteger(initialUsed) || initialUsed < 0) throw new Error('历史 HTTP 请求数必须是非负整数');
  if (!Number.isInteger(initialInputBytes) || initialInputBytes < 0) throw new Error('历史输入字节数必须是非负整数');
  let used = initialUsed; let inputBytes = initialInputBytes;
  return {
    limit, maxInputBytes, initialUsed, initialInputBytes,
    get used() { return used; },
    get usedThisProcess() { return used - initialUsed; },
    get inputBytes() { return inputBytes; },
    get inputBytesThisProcess() { return inputBytes - initialInputBytes; },
    get remaining() { return Math.max(0, limit - used); },
    take(requestBytes = 0) {
      if (used >= limit) throw new ModelBudgetExceededError(limit);
      if (maxInputBytes !== null && inputBytes + requestBytes > maxInputBytes) throw new ModelBudgetExceededError(maxInputBytes, '累计输入字节');
      used += 1;
      inputBytes += requestBytes;
      return used;
    },
  };
}

function httpError(status, text) {
  const retryable = status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  const fatal = [400, 401, 402, 403, 404, 405, 422].includes(status);
  return new ModelRequestError(`HTTP ${status}: ${compact(text, 300)}`, { status, retryable, fatal, splittable: status === 413 });
}

async function reportEvent(onEvent, event) {
  if (typeof onEvent !== 'function') return;
  try { await onEvent({ timestamp: new Date().toISOString(), ...event }); }
  catch (error) {
    throw new ModelRequestError(`无法写入 API 用量日志：${compact(error?.message ?? error, 200)}`, { fatal: true, cause: error });
  }
}

export async function requestModelJson(settings, messages, options = {}) {
  const {
    budget = null, onEvent = null, phase = 'model', requestId = null,
  } = options;
  const maxAttempts = settings.maxAttempts ?? DEFAULT_MODEL_MAX_ATTEMPTS;
  const bodyText = JSON.stringify({
    model: settings.model,
    temperature: 0,
    max_tokens: settings.maxOutputTokens ?? DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
    messages,
  });
  const requestBytes = Buffer.byteLength(bodyText);
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const sequence = budget?.take(requestBytes) ?? null;
    const attemptId = `${phase}:${requestId ?? 'request'}:${sequence ?? attempt}`;
    await reportEvent(onEvent, {
      event: 'request_reserved', phase, request_id: requestId, attempt_id: attemptId, sequence, attempt,
      outcome: 'reserved', request_bytes: requestBytes,
    });
    let response; let responseBytes = null; let responseUsage = null;
    try {
      const headers = { 'content-type': 'application/json' };
      if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;
      response = await fetch(settings.url, {
        method: 'POST',
        headers,
        body: bodyText,
      });
      const responseText = await response.text();
      responseBytes = Buffer.byteLength(responseText);
      if (!response.ok) throw httpError(response.status, responseText);
      let payload;
      try {
        payload = JSON.parse(responseText);
      } catch (error) {
        throw new ModelRequestError(`API 响应不是有效 JSON：${compact(error.message, 200)}`, { retryable: true, cause: error });
      }
      responseUsage = payload.usage ?? null;
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new ModelRequestError('模型响应缺少 choices[0].message.content', { retryable: true, splittable: true });
      let parsed;
      try {
        parsed = parseModelJson(content);
      } catch (error) {
        throw new ModelRequestError(`模型输出不是有效 JSON：${compact(error.message, 200)}`, { retryable: true, splittable: true, cause: error });
      }
      await reportEvent(onEvent, {
        event: 'request_completed', phase, request_id: requestId, attempt_id: attemptId,
        sequence, attempt, outcome: 'success', status: response.status,
        request_bytes: requestBytes, response_bytes: responseBytes, usage: responseUsage,
      });
      return parsed;
    } catch (error) {
      lastError = error instanceof ModelRequestError || error instanceof ModelBudgetExceededError
        ? error
        : new ModelRequestError(compact(error?.message ?? error, 300), { retryable: true, cause: error });
      await reportEvent(onEvent, {
        event: 'request_completed', phase, request_id: requestId, attempt_id: attemptId,
        sequence, attempt, outcome: 'error', status: response?.status ?? lastError.status ?? null,
        request_bytes: requestBytes, response_bytes: responseBytes, usage: responseUsage, error: compact(lastError.message, 300),
      });
      if (isFatalModelError(lastError) || !lastError.retryable || attempt >= maxAttempts) break;
      await delay(500 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

export async function runWorkers(items, concurrency, worker) {
  let next = 0; let firstError = null;
  const run = async () => {
    while (!firstError && next < items.length) {
      const index = next;
      next += 1;
      try { await worker(items[index], index); }
      catch (error) { firstError ??= error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  if (firstError) throw firstError;
}
