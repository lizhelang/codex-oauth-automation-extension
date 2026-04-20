const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('background/tab-runtime.js', 'utf8');
const globalScope = {};
const api = new Function('self', `${source}; return self.MultiPageBackgroundTabRuntime;`)(globalScope);

function cloneState(state) {
  return {
    ...state,
    tabRegistry: { ...(state.tabRegistry || {}) },
    sourceLastUrls: { ...(state.sourceLastUrls || {}) },
    retainedTabOwnership: { ...(state.retainedTabOwnership || {}) },
  };
}

function createHarness(options = {}) {
  const initialState = options.state || {};
  let currentState = cloneState({
    tabRegistry: {},
    sourceLastUrls: {},
    retainedTabOwnership: {},
    ...initialState,
  });

  const logs = [];
  const createCalls = [];
  const executeScriptCalls = [];
  const updateCalls = [];
  const reloadCalls = [];
  const removedTabIds = [];
  const tabs = new Map();
  const updateListeners = new Set();

  const initialTabs = Array.isArray(options.tabs) ? options.tabs : [];
  let nextTabId = 1;
  for (const tab of initialTabs) {
    const normalized = {
      id: tab.id,
      url: tab.url || 'https://example.com',
      status: tab.status || 'complete',
      active: Boolean(tab.active),
    };
    tabs.set(normalized.id, normalized);
    nextTabId = Math.max(nextTabId, normalized.id + 1);
  }

  function emitTabComplete(tabId) {
    setTimeout(() => {
      for (const listener of updateListeners) {
        listener(tabId, { status: 'complete' });
      }
    }, 0);
  }

  const executeScriptImpl = typeof options.executeScript === 'function'
    ? options.executeScript
    : async () => {};

  const runtime = api.createTabRuntime({
    LOG_PREFIX: '[test]',
    addLog: async (message, level = 'info') => {
      logs.push({ message, level });
    },
    chrome: {
      tabs: {
        get: async (tabId) => {
          const tab = tabs.get(tabId);
          if (!tab) {
            throw new Error(`No tab ${tabId}`);
          }
          return { ...tab };
        },
        query: async () => Array.from(tabs.values()).map((tab) => ({ ...tab })),
        create: async ({ url, active }) => {
          const tab = {
            id: nextTabId,
            url,
            status: 'complete',
            active: Boolean(active),
          };
          nextTabId += 1;
          tabs.set(tab.id, tab);
          createCalls.push({ url, active: Boolean(active), tabId: tab.id });
          emitTabComplete(tab.id);
          return { ...tab };
        },
        remove: async (tabIds) => {
          for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
            removedTabIds.push(tabId);
            tabs.delete(tabId);
          }
        },
        update: async (tabId, updates = {}) => {
          const existing = tabs.get(tabId);
          if (!existing) {
            throw new Error(`No tab ${tabId}`);
          }
          const next = { ...existing, ...updates };
          if (Object.prototype.hasOwnProperty.call(updates, 'url')) {
            next.status = 'complete';
            emitTabComplete(tabId);
          }
          tabs.set(tabId, next);
          updateCalls.push({ tabId, updates: { ...updates } });
          return { ...next };
        },
        reload: async (tabId) => {
          const existing = tabs.get(tabId);
          if (!existing) {
            throw new Error(`No tab ${tabId}`);
          }
          tabs.set(tabId, { ...existing, status: 'complete' });
          reloadCalls.push(tabId);
          emitTabComplete(tabId);
        },
        sendMessage: async () => ({ ok: true }),
        onUpdated: {
          addListener(listener) {
            updateListeners.add(listener);
          },
          removeListener(listener) {
            updateListeners.delete(listener);
          },
        },
      },
      scripting: {
        executeScript: async (request) => {
          executeScriptCalls.push(request);
          return executeScriptImpl(request);
        },
      },
    },
    getSourceLabel: (sourceName) => sourceName || 'unknown',
    getState: async () => cloneState(currentState),
    isLocalhostOAuthCallbackUrl: () => false,
    isRetryableContentScriptTransportError: () => false,
    matchesSourceUrlFamily: (sourceName, candidateUrl, referenceUrl) => {
      if (sourceName !== 'icloud-mail') return false;
      return new URL(candidateUrl).hostname === new URL(referenceUrl).hostname;
    },
    setState: async (updates = {}) => {
      currentState = cloneState({
        ...currentState,
        ...updates,
        tabRegistry: Object.prototype.hasOwnProperty.call(updates, 'tabRegistry')
          ? updates.tabRegistry
          : currentState.tabRegistry,
        sourceLastUrls: Object.prototype.hasOwnProperty.call(updates, 'sourceLastUrls')
          ? updates.sourceLastUrls
          : currentState.sourceLastUrls,
        retainedTabOwnership: Object.prototype.hasOwnProperty.call(updates, 'retainedTabOwnership')
          ? updates.retainedTabOwnership
          : currentState.retainedTabOwnership,
      });
    },
    sleepWithStop: async () => {},
    STOP_ERROR_MESSAGE: 'Flow stopped.',
    throwIfStopped: () => {},
  });

  return {
    runtime,
    logs,
    createCalls,
    executeScriptCalls,
    updateCalls,
    reloadCalls,
    removedTabIds,
    tabs,
    snapshot: () => cloneState(currentState),
  };
}

function countRecoveryAttempts(harness, tabId, url) {
  return harness.reloadCalls.filter((value) => value === tabId).length
    + harness.updateCalls.filter(({ tabId: updatedTabId, updates }) => (
      updatedTabId === tabId && updates?.url === url
    )).length;
}

test('background imports tab runtime module', () => {
  const backgroundSource = fs.readFileSync('background.js', 'utf8');
  assert.match(backgroundSource, /background\/tab-runtime\.js/);
});

test('tab runtime module exposes a factory', () => {
  assert.equal(typeof api?.createTabRuntime, 'function');
});

test('tab runtime waitForTabComplete waits until tab status becomes complete', async () => {
  let getCalls = 0;
  const runtime = api.createTabRuntime({
    LOG_PREFIX: '[test]',
    addLog: async () => {},
    chrome: {
      tabs: {
        get: async () => {
          getCalls += 1;
          return {
            id: 9,
            url: 'https://example.com',
            status: getCalls >= 3 ? 'complete' : 'loading',
          };
        },
        query: async () => [],
      },
    },
    getSourceLabel: (sourceName) => sourceName || 'unknown',
    getState: async () => ({ tabRegistry: {}, sourceLastUrls: {}, retainedTabOwnership: {} }),
    matchesSourceUrlFamily: () => false,
    setState: async () => {},
    throwIfStopped: () => {},
  });

  const result = await runtime.waitForTabComplete(9, {
    timeoutMs: 2000,
    retryDelayMs: 1,
  });

  assert.equal(result?.status, 'complete');
  assert.equal(getCalls, 3);
});

test('tab runtime waitForTabComplete aborts promptly when stop is requested', async () => {
  let throwCalls = 0;
  const runtime = api.createTabRuntime({
    LOG_PREFIX: '[test]',
    addLog: async () => {},
    chrome: {
      tabs: {
        get: async () => ({
          id: 9,
          url: 'https://example.com',
          status: 'loading',
        }),
        query: async () => [],
      },
    },
    getSourceLabel: (sourceName) => sourceName || 'unknown',
    getState: async () => ({ tabRegistry: {}, sourceLastUrls: {}, retainedTabOwnership: {} }),
    matchesSourceUrlFamily: () => false,
    setState: async () => {},
    throwIfStopped: () => {
      throwCalls += 1;
      if (throwCalls >= 2) {
        throw new Error('Flow stopped.');
      }
    },
  });

  await assert.rejects(
    runtime.waitForTabComplete(9, {
      timeoutMs: 2000,
      retryDelayMs: 1,
    }),
    /Flow stopped\./
  );
});

test('iCloud ownership-missing path creates a dedicated owned tab without adopting user tab', async () => {
  const harness = createHarness({
    tabs: [
      { id: 9, url: 'https://www.icloud.com/mail/' },
    ],
  });

  const tabId = await harness.runtime.reuseOrCreateTab('icloud-mail', 'https://www.icloud.com/mail/');
  const snapshot = harness.snapshot();

  assert.notEqual(tabId, 9, 'runtime must not adopt a user-opened iCloud tab');
  assert.equal(harness.createCalls.length, 1, 'runtime should create exactly one automation-owned tab');
  assert.deepEqual(harness.removedTabIds, [], 'runtime must not close the user-opened iCloud tab');
  assert.ok(harness.tabs.has(9), 'user-opened iCloud tab should remain open');
  assert.equal(snapshot.retainedTabOwnership['icloud-mail']?.tabId, tabId, 'owned tab should be retained outside generic registry state');
  assert.deepEqual(snapshot.tabRegistry['icloud-mail'], { tabId, ready: true }, 'owned tab should be mirrored into active registry state');
  assert.deepEqual(
    harness.logs.map((entry) => entry.message),
    [
      'icloud-mail ownership-missing-create-new',
      'icloud-mail create-owned-tab',
      'icloud-mail mirror-owned-tab-into-registry',
    ],
  );
});

test('closeConflictingTabsForSource never closes iCloud tabs without ownership', async () => {
  const harness = createHarness({
    state: {
      sourceLastUrls: {
        'icloud-mail': 'https://www.icloud.com/mail/',
      },
    },
    tabs: [
      { id: 9, url: 'https://www.icloud.com/mail/' },
    ],
  });

  await harness.runtime.closeConflictingTabsForSource('icloud-mail', 'https://www.icloud.com/mail/');

  assert.deepEqual(harness.removedTabIds, []);
  assert.ok(harness.tabs.has(9));
});

test('iCloud retained ownership survives registry reset and reuses the same owned tab', async () => {
  const harness = createHarness({
    state: {
      retainedTabOwnership: {
        'icloud-mail': { tabId: 21, url: 'https://www.icloud.com/mail/' },
      },
    },
    tabs: [
      { id: 21, url: 'https://www.icloud.com/mail/' },
    ],
  });

  const tabId = await harness.runtime.reuseOrCreateTab('icloud-mail', 'https://www.icloud.com/mail/');
  const snapshot = harness.snapshot();

  assert.equal(tabId, 21, 'runtime should reuse the retained owned tab');
  assert.equal(harness.createCalls.length, 0, 'reusing retained ownership must not create a new tab');
  assert.deepEqual(snapshot.tabRegistry['icloud-mail'], { tabId: 21, ready: true }, 'retained owned tab should be mirrored back into registry');
  assert.deepEqual(
    harness.logs.map((entry) => entry.message),
    [
      'icloud-mail mirror-owned-tab-into-registry',
      'icloud-mail reuse-owned-tab',
    ],
  );
});

test('iCloud retained ownership recovers by navigation instead of creating a second tab', async () => {
  const harness = createHarness({
    state: {
      retainedTabOwnership: {
        'icloud-mail': { tabId: 21, url: 'https://www.icloud.com/' },
      },
    },
    tabs: [
      { id: 21, url: 'https://www.icloud.com/' },
    ],
  });

  const tabId = await harness.runtime.reuseOrCreateTab('icloud-mail', 'https://www.icloud.com/mail/');
  const snapshot = harness.snapshot();

  assert.equal(tabId, 21);
  assert.equal(harness.createCalls.length, 0, 'navigation recovery should not create a replacement tab');
  assert.deepEqual(harness.updateCalls, [
    { tabId: 21, updates: { active: true } },
    { tabId: 21, updates: { url: 'https://www.icloud.com/mail/', active: true } },
  ]);
  assert.equal(snapshot.retainedTabOwnership['icloud-mail']?.url, 'https://www.icloud.com/mail/');
  assert.deepEqual(
    harness.logs.map((entry) => entry.message),
    [
      'icloud-mail mirror-owned-tab-into-registry',
      'icloud-mail recover-owned-tab-via-navigation',
    ],
  );
});

test('manually closed owned iCloud tab is replaced exactly once and then reused', async () => {
  const harness = createHarness({
    state: {
      retainedTabOwnership: {
        'icloud-mail': { tabId: 77, url: 'https://www.icloud.com/mail/' },
      },
    },
  });

  const replacementTabId = await harness.runtime.reuseOrCreateTab('icloud-mail', 'https://www.icloud.com/mail/');
  const reusedReplacementTabId = await harness.runtime.reuseOrCreateTab('icloud-mail', 'https://www.icloud.com/mail/');

  assert.equal(harness.createCalls.length, 1, 'manual close should produce exactly one replacement tab');
  assert.equal(replacementTabId, reusedReplacementTabId, 'later runs should reuse the replacement tab');
  assert.equal(harness.snapshot().retainedTabOwnership['icloud-mail']?.tabId, replacementTabId);
  assert.deepEqual(
    harness.logs.map((entry) => entry.message),
    [
      'icloud-mail create-owned-tab',
      'icloud-mail mirror-owned-tab-into-registry',
      'icloud-mail mirror-owned-tab-into-registry',
      'icloud-mail reuse-owned-tab',
    ],
  );
});

test('runtime logs iCloud manual-inspection preservation only when an owned tab is still open', async () => {
  const harness = createHarness({
    state: {
      retainedTabOwnership: {
        'icloud-mail': { tabId: 42, url: 'https://www.icloud.com/mail/' },
      },
    },
    tabs: [
      { id: 42, url: 'https://www.icloud.com/mail/' },
    ],
  });

  const preserved = await harness.runtime.logOwnedTabPreserved('icloud-mail');

  assert.equal(preserved, true);
  assert.deepEqual(harness.logs.map((entry) => entry.message), [
    'icloud-mail preserve-for-manual-inspection',
  ]);
});

test('reuseOrCreateTab recovers create-path injection from an explicit browser error page failure', async () => {
  const url = 'https://chatgpt.com/';
  let fileInjectionAttempts = 0;
  const harness = createHarness({
    executeScript: async (request) => {
      if (request.files) {
        fileInjectionAttempts += 1;
        if (fileInjectionAttempts === 1) {
          throw new Error('Frame with ID 0 is showing error page');
        }
      }
    },
  });

  const tabId = await harness.runtime.reuseOrCreateTab('signup-page', url, {
    inject: ['content/signup-page.js'],
    injectSource: 'signup-page',
  });

  assert.equal(tabId, harness.createCalls[0]?.tabId);
  assert.equal(harness.createCalls.length, 1, 'create-path recovery should reuse the original created tab');
  assert.equal(fileInjectionAttempts, 2, 'error-page injection should be retried once recovery succeeds');
  assert.ok(
    countRecoveryAttempts(harness, tabId, url) >= 1,
    'error-page recovery should actively reload or re-navigate the failed tab',
  );
  assert.equal(harness.snapshot().sourceLastUrls['signup-page'], url);
});

test('reuseOrCreateTab recovers same-url reuse injection from an explicit browser error page failure', async () => {
  const url = 'https://chatgpt.com/';
  let fileInjectionAttempts = 0;
  const harness = createHarness({
    state: {
      tabRegistry: {
        'signup-page': { tabId: 9, ready: true },
      },
      sourceLastUrls: {
        'signup-page': url,
      },
    },
    tabs: [
      { id: 9, url },
    ],
    executeScript: async (request) => {
      if (request.files) {
        fileInjectionAttempts += 1;
        if (fileInjectionAttempts === 1) {
          throw new Error('Frame with ID 0 is showing error page');
        }
      }
    },
  });

  const tabId = await harness.runtime.reuseOrCreateTab('signup-page', url, {
    inject: ['content/signup-page.js'],
    injectSource: 'signup-page',
  });

  assert.equal(tabId, 9);
  assert.equal(harness.createCalls.length, 0, 'reuse-path recovery must not create a replacement tab');
  assert.equal(fileInjectionAttempts, 2, 'reuse-path error-page injection should retry after recovery');
  assert.ok(
    countRecoveryAttempts(harness, tabId, url) >= 1,
    'reuse-path recovery should actively reload or re-navigate the failed tab',
  );
});

test('reuseOrCreateTab surfaces a product-readable final error after repeated browser error page failures', async () => {
  const url = 'https://chatgpt.com/';
  let fileInjectionAttempts = 0;
  const harness = createHarness({
    executeScript: async (request) => {
      if (request.files) {
        fileInjectionAttempts += 1;
        throw new Error('Frame with ID 0 is showing error page');
      }
    },
  });

  await assert.rejects(
    harness.runtime.reuseOrCreateTab('signup-page', url, {
      inject: ['content/signup-page.js'],
      injectSource: 'signup-page',
    }),
    (error) => {
      assert.match(error.message, /浏览器错误页|error page/i);
      assert.match(error.message, /重试|retry/i);
      assert.match(error.message, /\d+/);
      assert.doesNotMatch(error.message, /Frame with ID 0 is showing error page/);
      return true;
    },
  );
  assert.ok(fileInjectionAttempts >= 2, 'final failure should only happen after bounded recovery attempts');
});

test('reuseOrCreateTab does not treat non-error-page injection failures as recoverable', async () => {
  const url = 'https://chatgpt.com/';
  let fileInjectionAttempts = 0;
  const harness = createHarness({
    state: {
      tabRegistry: {
        'signup-page': { tabId: 9, ready: true },
      },
      sourceLastUrls: {
        'signup-page': url,
      },
    },
    tabs: [
      { id: 9, url },
    ],
    executeScript: async (request) => {
      if (request.files) {
        fileInjectionAttempts += 1;
        throw new Error('按钮不存在');
      }
    },
  });

  await assert.rejects(
    harness.runtime.reuseOrCreateTab('signup-page', url, {
      inject: ['content/signup-page.js'],
      injectSource: 'signup-page',
    }),
    /按钮不存在/,
  );

  assert.equal(fileInjectionAttempts, 1, 'business errors should fail immediately without retrying injection');
  assert.equal(countRecoveryAttempts(harness, 9, url), 0, 'business errors must not trigger error-page recovery');
  assert.equal(harness.createCalls.length, 0);
});
