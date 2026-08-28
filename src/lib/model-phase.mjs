import { compact, isFatalModelError } from './model-client.mjs';

export function chunks(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

export function positiveIntegerFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} 必须是正整数`);
  return value;
}

export function requestLimitFromEnv() {
  const configured = String(process.env.MODEL_MAX_HTTP_REQUESTS ?? '').trim();
  if (!configured) return { limit: Number.MAX_SAFE_INTEGER, configured: false };
  const limit = Number.parseInt(configured, 10);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('MODEL_MAX_HTTP_REQUESTS 必须是正安全整数');
  return { limit, configured: true };
}

export function modelErrorRecord(error) {
  return {
    error_type: String(error?.name ?? 'Error'),
    status: Number.isInteger(error?.status) ? error.status : null,
    retryable: error?.retryable === true,
    fatal: isFatalModelError(error),
    error: compact(error?.message ?? error, 500),
  };
}

export async function resolveSplittableBatch(items, options, batchId) {
  let unresolved = items;
  let lastError = null;
  let splitOnFailure = false;
  for (let round = 1; round <= options.maxRounds && unresolved.length; round += 1) {
    try {
      const response = await options.request(unresolved, round, batchId);
      const outcome = await options.accept(response, unresolved, round, batchId);
      unresolved = outcome.unresolved;
      splitOnFailure = outcome.splitOnFailure === true;
      lastError = outcome.error ?? (unresolved.length ? lastError : null);
    } catch (error) {
      if (isFatalModelError(error)) throw error;
      lastError = error;
      splitOnFailure = error?.splittable === true;
      break;
    }
  }
  if (splitOnFailure && unresolved.length > 1) {
    const middle = Math.ceil(unresolved.length / 2);
    const left = await resolveSplittableBatch(unresolved.slice(0, middle), options, `${batchId}-left`);
    const right = await resolveSplittableBatch(unresolved.slice(middle), options, `${batchId}-right`);
    return [...left, ...right];
  }
  return unresolved.map((item) => ({ item, error: lastError }));
}
