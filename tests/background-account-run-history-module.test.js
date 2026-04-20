const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('background imports account run history module', () => {
  const source = fs.readFileSync('background.js', 'utf8');
  assert.match(source, /background\/account-run-history\.js/);
});

test('account run history module exposes a factory', () => {
  const source = fs.readFileSync('background/account-run-history.js', 'utf8');
  const globalScope = {};

  const api = new Function('self', `${source}; return self.MultiPageBackgroundAccountRunHistory;`)(globalScope);

  assert.equal(typeof api?.createAccountRunHistoryHelpers, 'function');
});

test('account run history helper upgrades old records, keeps stopped items and stores normalized failed snapshot records', async () => {
  const source = fs.readFileSync('background/account-run-history.js', 'utf8');
  const globalScope = {};
  const api = new Function('self', `${source}; return self.MultiPageBackgroundAccountRunHistory;`)(globalScope);

  let storedHistory = [
    { email: 'old@example.com', password: 'old-pass', status: 'success', recordedAt: '2026-04-17T00:00:00.000Z' },
    { email: 'stop@example.com', password: 'stop-pass', status: 'stopped', recordedAt: '2026-04-17T00:10:00.000Z' },
  ];
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error('should not call fetch');
  };

  const helpers = api.createAccountRunHistoryHelpers({
    ACCOUNT_RUN_HISTORY_STORAGE_KEY: 'accountRunHistory',
    addLog: async () => {},
    buildLocalHelperEndpoint: (baseUrl, path) => `${baseUrl}${path}`,
    chrome: {
      storage: {
        local: {
          get: async () => ({ accountRunHistory: storedHistory }),
          set: async (payload) => {
            storedHistory = payload.accountRunHistory;
          },
        },
      },
    },
    getErrorMessage: (error) => error?.message || String(error || ''),
    getState: async () => ({
      email: ' latest@example.com ',
      password: ' secret ',
      autoRunning: true,
      autoRunCurrentRun: 2,
      autoRunTotalRuns: 10,
      autoRunAttemptRun: 3,
      accountRunHistoryTextEnabled: false,
      accountRunHistoryHelperBaseUrl: '',
    }),
    normalizeAccountRunHistoryHelperBaseUrl: (value) => String(value || '').trim(),
  });

  const record = helpers.buildAccountRunHistoryRecord(
    {
      email: ' latest@example.com ',
      password: ' secret ',
      autoRunning: true,
      autoRunCurrentRun: 2,
      autoRunTotalRuns: 10,
      autoRunAttemptRun: 3,
    },
    'step8_failed',
    '步骤 8：认证页进入了手机号页面，当前不是 OAuth 同意页，无法继续自动授权。'
  );
  assert.deepStrictEqual(record, {
    recordId: 'latest@example.com',
    email: 'latest@example.com',
    password: 'secret',
    finalStatus: 'failed',
    finishedAt: record.finishedAt,
    retryCount: 2,
    failureLabel: '出现手机号验证',
    failureDetail: '步骤 8：认证页进入了手机号页面，当前不是 OAuth 同意页，无法继续自动授权。',
    failedStep: 8,
    source: 'auto',
    autoRunContext: {
      currentRun: 2,
      totalRuns: 10,
      attemptRun: 3,
    },
  });

  const appended = await helpers.appendAccountRunRecord('step8_failed', null, '步骤 8：认证页进入了手机号页面，当前不是 OAuth 同意页，无法继续自动授权。');
  assert.equal(appended.email, 'latest@example.com');
  assert.equal(appended.finalStatus, 'failed');
  assert.equal(appended.failureLabel, '出现手机号验证');
  assert.equal(storedHistory.length, 3, '旧的 stopped 记录应在新结构中保留');
  assert.equal(storedHistory.some((item) => item.email === 'stop@example.com' && item.finalStatus === 'stopped'), true);
  assert.equal(storedHistory.some((item) => item.email === 'latest@example.com' && item.retryCount === 2), true);
  assert.equal(storedHistory.some((item) => item.email === 'old@example.com'), true);
  assert.equal(fetchCalled, false);
  assert.equal(helpers.shouldAppendAccountRunTextFile({ accountRunHistoryTextEnabled: false, accountRunHistoryHelperBaseUrl: 'http://127.0.0.1:17373' }), false);
  assert.equal(helpers.shouldAppendAccountRunTextFile({ accountRunHistoryTextEnabled: true, accountRunHistoryHelperBaseUrl: 'http://127.0.0.1:17373' }), true);
  const stoppedRecord = helpers.buildAccountRunHistoryRecord(
    { email: 'a@b.com', password: 'x' },
    'step7_stopped',
    '步骤 7 已被用户停止'
  );
  assert.equal(stoppedRecord.recordId, 'a@b.com');
  assert.equal(stoppedRecord.email, 'a@b.com');
  assert.equal(stoppedRecord.password, 'x');
  assert.equal(stoppedRecord.finalStatus, 'stopped');
  assert.equal(stoppedRecord.retryCount, 0);
  assert.equal(stoppedRecord.failureLabel, '步骤 7 停止');
  assert.equal(stoppedRecord.failureDetail, '步骤 7 已被用户停止');
  assert.equal(stoppedRecord.failedStep, 7);
  assert.equal(stoppedRecord.source, 'manual');
  assert.equal(stoppedRecord.autoRunContext, null);
  assert.ok(stoppedRecord.finishedAt);

  const genericStoppedRecord = helpers.buildAccountRunHistoryRecord({ email: 'stop@b.com', password: 'y' }, 'stopped', 'stop');
  assert.equal(genericStoppedRecord.failureLabel, '流程已停止');
  assert.equal(genericStoppedRecord.failedStep, null);

  const normalizedStoppedRecord = helpers.normalizeAccountRunHistoryRecord({
    recordId: 'legacy-stop@example.com',
    email: 'legacy-stop@example.com',
    password: 'secret',
    finalStatus: 'stopped',
    finishedAt: '2026-04-17T00:12:00.000Z',
    retryCount: 0,
    failureLabel: '流程已停止',
    failureDetail: '步骤 7 已被用户停止。',
    failedStep: 7,
    source: 'manual',
    autoRunContext: null,
  });
  assert.equal(normalizedStoppedRecord.failureLabel, '步骤 7 停止');
  assert.equal(normalizedStoppedRecord.failedStep, 7);
});

test('account run history helper clears persisted records and syncs full snapshot payload to local helper', async () => {
  const source = fs.readFileSync('background/account-run-history.js', 'utf8');
  const globalScope = {};
  const api = new Function('self', `${source}; return self.MultiPageBackgroundAccountRunHistory;`)(globalScope);

  let storedHistory = [{
    recordId: 'user@example.com',
    email: 'user@example.com',
    password: 'secret',
    finalStatus: 'failed',
    finishedAt: '2026-04-17T01:00:00.000Z',
    retryCount: 1,
    failureLabel: '步骤 6 失败',
    failureDetail: '步骤 6：判断失败后已重试 2 次，仍未成功。',
    failedStep: 6,
    source: 'auto',
    autoRunContext: {
      currentRun: 1,
      totalRuns: 5,
      attemptRun: 2,
    },
  }];
  const fetchCalls = [];
  global.fetch = async (url, options = {}) => {
    fetchCalls.push({
      url,
      options,
    });
    return {
      ok: true,
      json: async () => ({
        ok: true,
        filePath: 'C:/tmp/account-run-history.json',
      }),
    };
  };

  const logs = [];
  const helpers = api.createAccountRunHistoryHelpers({
    ACCOUNT_RUN_HISTORY_STORAGE_KEY: 'accountRunHistory',
    addLog: async (message, level) => {
      logs.push({ message, level });
    },
    buildLocalHelperEndpoint: (baseUrl, path) => `${baseUrl}${path}`,
    chrome: {
      storage: {
        local: {
          get: async () => ({ accountRunHistory: storedHistory }),
          set: async (payload) => {
            storedHistory = payload.accountRunHistory;
          },
        },
      },
    },
    getErrorMessage: (error) => error?.message || String(error || ''),
    getState: async () => ({
      accountRunHistoryTextEnabled: true,
      accountRunHistoryHelperBaseUrl: 'http://127.0.0.1:17373',
    }),
    normalizeAccountRunHistoryHelperBaseUrl: (value) => String(value || '').trim(),
  });

  const payload = helpers.buildAccountRunHistorySnapshotPayload(storedHistory);
  assert.deepStrictEqual(payload.summary, {
    total: 1,
    success: 0,
    failed: 1,
    stopped: 0,
    retryTotal: 1,
  });

  const clearResult = await helpers.clearAccountRunHistory();
  assert.deepStrictEqual(clearResult, { clearedCount: 1 });
  assert.deepStrictEqual(storedHistory, []);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'http://127.0.0.1:17373/sync-account-run-records');
  assert.deepStrictEqual(JSON.parse(fetchCalls[0].options.body), {
    generatedAt: JSON.parse(fetchCalls[0].options.body).generatedAt,
    summary: {
      total: 0,
      success: 0,
      failed: 0,
      stopped: 0,
      retryTotal: 0,
    },
    records: [],
  });
  assert.equal(logs[0].message, '账号记录快照已同步到本地：C:/tmp/account-run-history.json');
});

test('account run history helper deletes selected records and syncs remaining snapshot payload', async () => {
  const source = fs.readFileSync('background/account-run-history.js', 'utf8');
  const globalScope = {};
  const api = new Function('self', `${source}; return self.MultiPageBackgroundAccountRunHistory;`)(globalScope);

  let storedHistory = [
    {
      recordId: 'keep@example.com',
      email: 'keep@example.com',
      password: 'secret',
      finalStatus: 'success',
      finishedAt: '2026-04-17T01:10:00.000Z',
      retryCount: 0,
      failureLabel: '流程完成',
      failureDetail: '',
      failedStep: null,
      source: 'manual',
      autoRunContext: null,
    },
    {
      recordId: 'remove@example.com',
      email: 'remove@example.com',
      password: 'secret',
      finalStatus: 'failed',
      finishedAt: '2026-04-17T01:00:00.000Z',
      retryCount: 2,
      failureLabel: '步骤 8 失败',
      failureDetail: '步骤 8：认证页异常',
      failedStep: 8,
      source: 'auto',
      autoRunContext: {
        currentRun: 1,
        totalRuns: 5,
        attemptRun: 3,
      },
    },
  ];
  const fetchCalls = [];
  global.fetch = async (url, options = {}) => {
    fetchCalls.push({
      url,
      options,
    });
    return {
      ok: true,
      json: async () => ({
        ok: true,
        filePath: 'C:/tmp/account-run-history.json',
      }),
    };
  };

  const logs = [];
  const helpers = api.createAccountRunHistoryHelpers({
    ACCOUNT_RUN_HISTORY_STORAGE_KEY: 'accountRunHistory',
    addLog: async (message, level) => {
      logs.push({ message, level });
    },
    buildLocalHelperEndpoint: (baseUrl, path) => `${baseUrl}${path}`,
    chrome: {
      storage: {
        local: {
          get: async () => ({ accountRunHistory: storedHistory }),
          set: async (payload) => {
            storedHistory = payload.accountRunHistory;
          },
        },
      },
    },
    getErrorMessage: (error) => error?.message || String(error || ''),
    getState: async () => ({
      accountRunHistoryTextEnabled: true,
      accountRunHistoryHelperBaseUrl: 'http://127.0.0.1:17373',
    }),
    normalizeAccountRunHistoryHelperBaseUrl: (value) => String(value || '').trim(),
  });

  const result = await helpers.deleteAccountRunHistoryRecords(['remove@example.com']);
  assert.deepStrictEqual(result, {
    deletedCount: 1,
    remainingCount: 1,
  });
  assert.equal(storedHistory.length, 1);
  assert.equal(storedHistory[0].email, 'keep@example.com');
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'http://127.0.0.1:17373/sync-account-run-records');
  assert.deepStrictEqual(JSON.parse(fetchCalls[0].options.body), {
    generatedAt: JSON.parse(fetchCalls[0].options.body).generatedAt,
    summary: {
      total: 1,
      success: 1,
      failed: 0,
      stopped: 0,
      retryTotal: 0,
    },
    records: storedHistory,
  });
  assert.equal(logs[0].message, '账号记录快照已同步到本地：C:/tmp/account-run-history.json');
});

test('account run history helper uses injected local sink bridge before raw helper fetch logic', async () => {
  const source = fs.readFileSync('background/account-run-history.js', 'utf8');
  const globalScope = {};
  const api = new Function('self', `${source}; return self.MultiPageBackgroundAccountRunHistory;`)(globalScope);

  let storedHistory = [{
    recordId: 'user@example.com',
    email: 'user@example.com',
    password: 'secret',
    finalStatus: 'success',
    finishedAt: '2026-04-17T01:00:00.000Z',
    retryCount: 0,
    failureLabel: '流程完成',
    failureDetail: '',
    failedStep: null,
    source: 'manual',
    autoRunContext: null,
  }];
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error('should not call fetch');
  };

  const bridgeCalls = [];
  const helpers = api.createAccountRunHistoryHelpers({
    ACCOUNT_RUN_HISTORY_STORAGE_KEY: 'accountRunHistory',
    addLog: async () => {},
    buildLocalHelperEndpoint: (baseUrl, path) => `${baseUrl}${path}`,
    chrome: {
      storage: {
        local: {
          get: async () => ({ accountRunHistory: storedHistory }),
          set: async (payload) => {
            storedHistory = payload.accountRunHistory;
          },
        },
      },
    },
    getErrorMessage: (error) => error?.message || String(error || ''),
    getState: async () => ({
      accountRunHistoryTextEnabled: true,
      accountRunHistoryHelperBaseUrl: 'http://127.0.0.1:17373',
    }),
    normalizeAccountRunHistoryHelperBaseUrl: (value) => String(value || '').trim(),
    syncAccountRunHistorySnapshotToLocalSink: async (payload, state) => {
      bridgeCalls.push({ payload, state });
      return '/tmp/account-run-history.json';
    },
  });

  const result = await helpers.clearAccountRunHistory();
  assert.deepStrictEqual(result, { clearedCount: 1 });
  assert.deepStrictEqual(storedHistory, []);
  assert.equal(fetchCalled, false);
  assert.equal(bridgeCalls.length, 1);
  assert.deepStrictEqual(bridgeCalls[0].payload.records, []);
  assert.deepStrictEqual(bridgeCalls[0].payload.summary, {
    total: 0,
    success: 0,
    failed: 0,
    stopped: 0,
    retryTotal: 0,
  });
  assert.equal(bridgeCalls[0].state.accountRunHistoryHelperBaseUrl, 'http://127.0.0.1:17373');
});
