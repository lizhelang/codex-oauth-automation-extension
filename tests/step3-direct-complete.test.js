const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('content/signup-page.js', 'utf8');

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

test('step 3 reports completion before deferred submit click', async () => {
  const api = new Function(`
const logs = [];
const completions = [];
const clicks = [];
const scheduled = [];

const snapshot = {
  state: 'password_page',
  passwordInput: { value: '', hidden: false },
  submitButton: { textContent: 'Continue', hidden: false },
  displayedEmail: 'user@example.com',
};

const window = {
  setTimeout(fn) {
    scheduled.push(fn);
    return scheduled.length;
  },
};

const location = {
  href: 'https://auth.openai.com/create-account/password',
};

function inspectSignupEntryState() {
  return snapshot;
}

async function ensureSignupPasswordPageReady() {
  return { ready: true };
}

function getSignupPasswordSubmitButton() {
  return snapshot.submitButton;
}

async function waitForElementByText() {
  return null;
}

function fillInput(input, value) {
  input.value = value;
}

async function humanPause() {}
async function sleep() {}
function throwIfStopped() {}
function isStopError() {
  return false;
}

function log(message, level = 'info') {
  logs.push({ message, level });
}

function reportComplete(step, payload) {
  completions.push({ step, payload });
}

function simulateClick(target) {
  clicks.push(target.textContent || 'button');
}

${extractFunction('step3_fillEmailPassword')}

return {
  async run(payload) {
    return step3_fillEmailPassword(payload);
  },
  async flushDeferredSubmit() {
    if (!scheduled.length) {
      throw new Error('missing deferred submit');
    }
    await scheduled[0]();
  },
  snapshot() {
    return {
      logs,
      completions,
      clicks,
      passwordValue: snapshot.passwordInput.value,
      scheduledCount: scheduled.length,
    };
  },
};
`)();

  const result = await api.run({
    email: 'user@example.com',
    password: 'Secret123!',
  });

  const beforeSubmit = api.snapshot();
  assert.equal(beforeSubmit.passwordValue, 'Secret123!');
  assert.equal(beforeSubmit.scheduledCount, 1);
  assert.deepStrictEqual(beforeSubmit.clicks, []);
  assert.equal(beforeSubmit.completions.length, 1);
  assert.equal(beforeSubmit.completions[0].step, 3);
  assert.deepStrictEqual(result, beforeSubmit.completions[0].payload);
  assert.equal(result.email, 'user@example.com');
  assert.equal(result.deferredSubmit, true);
  assert.equal(typeof result.signupVerificationRequestedAt, 'number');

  await api.flushDeferredSubmit();

  const afterSubmit = api.snapshot();
  assert.deepStrictEqual(afterSubmit.clicks, ['Continue']);
});

test('step 3 blocks when still on a pre-email entry variant page', async () => {
  const api = new Function(`
const location = {
  href: 'https://chatgpt.com/',
};

function inspectSignupEntryState() {
  return {
    state: 'entry_home',
    entryVariant: 'email_gate',
    signupTrigger: { textContent: '继续使用电子邮件地址登录' },
  };
}

async function ensureSignupPasswordPageReady() {
  throw new Error('should not reach password readiness');
}

function getSignupPasswordSubmitButton() {
  return null;
}

async function waitForElementByText() {
  return null;
}

function fillInput() {}
async function humanPause() {}
async function sleep() {}
function throwIfStopped() {}
function isStopError() {
  return false;
}
function log() {}
function reportComplete() {}
function simulateClick() {}

${extractFunction('step3_fillEmailPassword')}

return {
  async run(payload) {
    return step3_fillEmailPassword(payload);
  },
};
`)();

  await assert.rejects(
    () => api.run({
      email: 'user@example.com',
      password: 'Secret123!',
    }),
    /当前仍停留在注册入口页，请先完成步骤 2。/
  );
});
