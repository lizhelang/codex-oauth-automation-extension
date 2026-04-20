const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('background.js', 'utf8');

function extractFunction(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers
    .map((marker) => source.indexOf(marker))
    .find((index) => index >= 0);
  if (start < 0) {
    throw new Error(`missing function ${name}`);
  }

  let parenDepth = 0;
  let signatureEnded = false;
  let braceStart = -1;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        signatureEnded = true;
      }
    } else if (ch === '{' && signatureEnded) {
      braceStart = i;
      break;
    }
  }
  if (braceStart < 0) {
    throw new Error(`missing body for function ${name}`);
  }

  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end += 1) {
    const ch = source[end];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }

  return source.slice(start, end);
}

function createHarness(overrides = {}) {
  const bundle = [
    extractFunction('normalizeHotmailLocalBaseUrl'),
    extractFunction('normalizeAccountRunHistoryHelperBaseUrl'),
    extractFunction('buildHotmailLocalEndpoint'),
    extractFunction('createIcloudNativeHostRequestId'),
    extractFunction('getIcloudNativeHostClientVersion'),
    extractFunction('sendNativeHostMessage'),
    extractFunction('getIcloudNativeHostTransportErrorMessage'),
    extractFunction('getIcloudNativeHostResponseErrorMessage'),
    extractFunction('createAccountRunHistoryNativeHostError'),
    extractFunction('syncAccountRunHistorySnapshotViaNativeHost'),
    extractFunction('syncAccountRunHistorySnapshotViaLocalHelper'),
    extractFunction('syncAccountRunHistorySnapshotToLocalSink'),
  ].join('\n');

  return new Function('overrides', `
const ICLOUD_NATIVE_MESSAGING_HOST_NAME = 'com.qlhazycoder.codex_oauth_automation_extension';
const ICLOUD_NATIVE_MESSAGING_PROTOCOL_VERSION = 1;
const ICLOUD_LOCAL_HELPER_TIMEOUT_MS = overrides.timeoutMs || 20;
const DEFAULT_HOTMAIL_LOCAL_BASE_URL = 'http://127.0.0.1:17373';
const DEFAULT_ACCOUNT_RUN_HISTORY_HELPER_BASE_URL = DEFAULT_HOTMAIL_LOCAL_BASE_URL;
const LOG_PREFIX = '[test]';
globalThis.crypto = { randomUUID: () => 'test-request-id' };
const calls = {
  nativeMessages: [],
  fetches: [],
  warns: [],
};
const runtime = {
  lastError: null,
  getManifest: () => ({ version_name: 'Pro2.4', version: '2.4' }),
  sendNativeMessage: (hostName, payload, callback) => {
    calls.nativeMessages.push({ hostName, payload });
    if (typeof overrides.sendNativeMessageImpl === 'function') {
      return overrides.sendNativeMessageImpl({ runtime, hostName, payload, callback, calls });
    }
    callback({
      requestId: payload.requestId,
      ok: true,
      protocolVersion: 1,
      hostVersion: 'Pro2.4',
      result: { filePath: '/tmp/account-run-history.json' },
    });
  },
};
const chrome = overrides.chrome || { runtime };
const console = {
  warn: (...args) => calls.warns.push(args.map((item) => String(item)).join(' ')),
};
function getErrorMessage(error) {
  return error?.message || String(error || '');
}
global.fetch = async (url, options = {}) => {
  calls.fetches.push({ url, options });
  if (typeof overrides.fetchImpl === 'function') {
    return overrides.fetchImpl({ url, options, calls });
  }
  return {
    ok: true,
    json: async () => ({
      ok: true,
      filePath: '/tmp/account-run-history.json',
    }),
  };
};
${bundle}
return {
  calls,
  syncAccountRunHistorySnapshotToLocalSink,
};
`)(overrides);
}

test('account run history snapshot prefers Native Messaging host when available', async () => {
  const harness = createHarness();

  const filePath = await harness.syncAccountRunHistorySnapshotToLocalSink({
    generatedAt: '2026-04-20T00:00:00.000Z',
    summary: { total: 1, success: 1, failed: 0, stopped: 0, retryTotal: 0 },
    records: [{ email: 'user@example.com', password: 'secret', finalStatus: 'success', finishedAt: '2026-04-20T00:00:00.000Z' }],
  }, {
    accountRunHistoryHelperBaseUrl: 'http://127.0.0.1:17373',
  });

  assert.equal(filePath, '/tmp/account-run-history.json');
  assert.equal(harness.calls.nativeMessages.length, 1);
  assert.equal(harness.calls.nativeMessages[0].hostName, 'com.qlhazycoder.codex_oauth_automation_extension');
  assert.equal(harness.calls.nativeMessages[0].payload.type, 'accountRunHistory.syncSnapshot');
  assert.equal(harness.calls.fetches.length, 0);
});

test('account run history snapshot falls back to localhost helper when native host is unavailable', async () => {
  const harness = createHarness({
    sendNativeMessageImpl: ({ runtime, callback }) => {
      runtime.lastError = { message: 'Specified native messaging host not found.' };
      callback(undefined);
      runtime.lastError = null;
    },
  });

  const filePath = await harness.syncAccountRunHistorySnapshotToLocalSink({
    generatedAt: '2026-04-20T00:00:00.000Z',
    summary: { total: 0, success: 0, failed: 0, stopped: 0, retryTotal: 0 },
    records: [],
  }, {
    accountRunHistoryHelperBaseUrl: 'http://127.0.0.1:17373',
  });

  assert.equal(filePath, '/tmp/account-run-history.json');
  assert.equal(harness.calls.nativeMessages.length, 1);
  assert.equal(harness.calls.fetches.length, 1);
  assert.equal(harness.calls.fetches[0].url, 'http://127.0.0.1:17373/sync-account-run-records');
  assert.deepStrictEqual(JSON.parse(harness.calls.fetches[0].options.body), {
    generatedAt: '2026-04-20T00:00:00.000Z',
    summary: { total: 0, success: 0, failed: 0, stopped: 0, retryTotal: 0 },
    records: [],
  });
  assert.equal(harness.calls.warns.length, 1);
  assert.match(harness.calls.warns[0], /falling back to local helper/);
});
