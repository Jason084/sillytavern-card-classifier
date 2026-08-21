import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  ModelBudgetExceededError, createRequestBudget, modelSettingsFromEnv, requestModelJson, summarizeRequestEvents,
} from '../src/lib/model-client.mjs';

async function withServer(handler, work) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await work(`http://127.0.0.1:${server.address().port}/v1/chat/completions`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function settings(url, overrides = {}) {
  return { url, apiKey: '', model: 'mock', maxAttempts: 3, maxOutputTokens: 321, ...overrides };
}

test('403 额度或认证错误立即停止，不重试', async () => {
  let requests = 0; const events = [];
  await withServer((_request, response) => {
    requests += 1; response.writeHead(403, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'insufficient_user_quota' } }));
  }, async (url) => {
    await assert.rejects(
      requestModelJson(settings(url), [{ role: 'user', content: 'x' }], { onEvent: (event) => events.push(event) }),
      (error) => error.status === 403 && error.fatal === true,
    );
  });
  assert.equal(requests, 1); assert.equal(events.filter((event) => event.event === 'request_reserved').length, 1);
  assert.equal(events.filter((event) => event.event === 'request_completed').length, 1);
});

test('非 JSON 输出只做有限重试，并记录 usage 与输出上限', async () => {
  let requests = 0; let receivedMaxTokens = null; const events = [];
  await withServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    receivedMaxTokens = JSON.parse(raw).max_tokens; requests += 1;
    const content = requests === 1 ? 'not-json' : JSON.stringify({ ok: true });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
  }, async (url) => {
    const result = await requestModelJson(settings(url, { maxAttempts: 2 }), [{ role: 'user', content: 'x' }], { onEvent: (event) => events.push(event) });
    assert.deepEqual(result, { ok: true });
  });
  assert.equal(requests, 2); assert.equal(receivedMaxTokens, 321);
  assert.equal(events.filter((event) => event.event === 'request_reserved').length, 2);
  const completions = events.filter((event) => event.event === 'request_completed');
  assert.equal(completions.length, 2); assert.equal(completions[0].usage.total_tokens, 12); assert.equal(completions[1].usage.total_tokens, 12);
  assert.deepEqual(summarizeRequestEvents(events), { requests: 2, inputBytes: events[0].request_bytes * 2 });
});

test('HTTP 请求预算在重试前硬熔断', async () => {
  let requests = 0;
  await withServer((_request, response) => {
    requests += 1; response.writeHead(503, { 'content-type': 'text/plain' }); response.end('busy');
  }, async (url) => {
    const budget = createRequestBudget(1);
    await assert.rejects(
      requestModelJson(settings(url), [{ role: 'user', content: 'x' }], { budget }),
      (error) => error instanceof ModelBudgetExceededError,
    );
    assert.equal(budget.used, 1);
  });
  assert.equal(requests, 1);
});

test('累计输入字节预算在发送前硬熔断', async () => {
  let requests = 0;
  await withServer((_request, response) => {
    requests += 1; response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}');
  }, async (url) => {
    const budget = createRequestBudget(10, 1);
    await assert.rejects(
      requestModelJson(settings(url), [{ role: 'user', content: 'payload' }], { budget }),
      (error) => error instanceof ModelBudgetExceededError && error.message.includes('输入字节'),
    );
    assert.equal(budget.used, 0); assert.equal(budget.inputBytes, 0);
  });
  assert.equal(requests, 0);
});

test('请求完成日志写入失败时停止，预留记录仍先于付费请求', async () => {
  let requests = 0; const persisted = [];
  await withServer((_request, response) => {
    requests += 1; response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }] }));
  }, async (url) => {
    await assert.rejects(
      requestModelJson(settings(url), [{ role: 'user', content: 'x' }], { onEvent: (event) => {
        if (event.event === 'request_completed') throw new Error('disk full');
        persisted.push(event);
      } }),
      (error) => error.fatal === true && error.message.includes('用量日志'),
    );
  });
  assert.equal(requests, 1); assert.equal(persisted.length, 1); assert.equal(persisted[0].event, 'request_reserved');
});

test('阶段默认模型配置可由通用环境变量覆盖，密钥优先读取 CHEESE_API_KEY', () => {
  const names = ['MODEL_API_BASE_URL', 'MODEL_NAME', 'MODEL_BATCH_SIZE', 'MODEL_MAX_OUTPUT_TOKENS', 'MODEL_API_KEY', 'CHEESE_API_KEY'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.CHEESE_API_KEY = 'cheese-secret';
    const defaults = modelSettingsFromEnv({
      baseUrl: 'https://cheese.example/v1', model: 'default-model', batchSize: 30,
      maxOutputTokens: 4_096, requireApiKeyForDefault: true,
    });
    assert.equal(defaults.url, 'https://cheese.example/v1/chat/completions');
    assert.equal(defaults.model, 'default-model'); assert.equal(defaults.batchSize, 30);
    assert.equal(defaults.maxOutputTokens, 4_096); assert.equal(defaults.apiKey, 'cheese-secret');

    process.env.MODEL_API_BASE_URL = 'http://127.0.0.1:1234/v1'; process.env.MODEL_NAME = 'override-model';
    process.env.MODEL_BATCH_SIZE = '7'; process.env.MODEL_MAX_OUTPUT_TOKENS = '999'; process.env.MODEL_API_KEY = 'legacy-secret';
    const overridden = modelSettingsFromEnv({ baseUrl: 'https://unused.example/v1', model: 'unused', batchSize: 20 });
    assert.equal(overridden.baseUrl, 'http://127.0.0.1:1234/v1'); assert.equal(overridden.model, 'override-model');
    assert.equal(overridden.batchSize, 7); assert.equal(overridden.maxOutputTokens, 999);
    assert.equal(overridden.apiKey, 'cheese-secret');
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  }
});
