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

function createAction(text, overrides = {}) {
  return {
    tagName: overrides.tagName || 'BUTTON',
    textContent: overrides.textContent ?? text,
    value: overrides.value || '',
    disabled: Boolean(overrides.disabled),
    hidden: Boolean(overrides.hidden),
    getBoundingClientRect() {
      if (overrides.hidden) {
        return { width: 0, height: 0 };
      }
      return {
        width: overrides.width ?? 120,
        height: overrides.height ?? 40,
      };
    },
    getAttribute(name) {
      if (name === 'type') return overrides.type || '';
      if (name === 'aria-disabled') return overrides.ariaDisabled ? 'true' : '';
      return overrides.attributes?.[name] || '';
    },
  };
}

function createInspectApi({
  actionCandidates = [],
  emailInput = null,
  passwordInput = null,
  isPasswordPage = false,
  pageText = '',
} = {}) {
  return new Function('actionCandidates', 'emailInput', 'passwordInput', 'isPasswordPage', 'pageText', `
const SIGNUP_ENTRY_ACTION_SELECTOR = 'a, button, [role="button"], [role="link"], input[type="button"], input[type="submit"]';
const SIGNUP_ENTRY_TRIGGER_PATTERN = /免费注册|立即注册|注册|sign\\s*up|register|create\\s*account|create\\s+account/i;
const SIGNUP_EMAIL_GATE_KEYWORD_PATTERN = /电子邮件(?:地址)?|邮箱|email(?:\\s+address)?/i;
const SIGNUP_EMAIL_GATE_ACTION_PATTERN = /继续|使用|登录|登入|continue(?:\\s+with)?|use|login|log\\s*in|sign\\s*in/i;
const location = { href: 'https://chatgpt.com/' };
const document = {
  querySelectorAll(selector) {
    return selector === SIGNUP_ENTRY_ACTION_SELECTOR ? actionCandidates : [];
  },
  body: {
    innerText: pageText,
    textContent: pageText,
  },
};

function isVisibleElement(el) {
  if (!el || el.hidden) return false;
  const rect = typeof el.getBoundingClientRect === 'function'
    ? el.getBoundingClientRect()
    : { width: 1, height: 1 };
  return rect.width > 0 && rect.height > 0;
}

function isActionEnabled(el) {
  return Boolean(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
}

function getActionText(el) {
  return [el?.textContent, el?.value, el?.getAttribute?.('aria-label'), el?.getAttribute?.('title')]
    .filter(Boolean)
    .join(' ')
    .replace(/\\s+/g, ' ')
    .trim();
}

function getSignupPasswordInput() {
  return passwordInput;
}

function isSignupPasswordPage() {
  return isPasswordPage;
}

function getSignupPasswordSubmitButton() {
  return { textContent: 'Continue' };
}

function getSignupPasswordDisplayedEmail() {
  return 'user@example.com';
}

function getSignupEmailInput() {
  return emailInput;
}

function getSignupEmailContinueButton() {
  return { textContent: 'Continue' };
}

${extractFunction('getSignupEntryActionCandidates')}
${extractFunction('isSignupEmailGateActionText')}
${extractFunction('findSignupEmailGateTrigger')}
${extractFunction('findSignupEntryTrigger')}
${extractFunction('inspectSignupEntryState')}

return {
  inspectSignupEntryState,
  isSignupEmailGateActionText,
};
`)(actionCandidates, emailInput, passwordInput, isPasswordPage, pageText);
}

function createWaitApi(snapshots) {
  return new Function('snapshots', `
const logs = [];
const clicks = [];
let index = 0;
let now = 0;
const Date = {
  now() {
    now += 600;
    return now;
  },
};

function inspectSignupEntryState() {
  const pointer = Math.min(index, snapshots.length - 1);
  index += 1;
  return snapshots[pointer];
}

function throwIfStopped() {}

function log(message) {
  logs.push(message);
}

async function humanPause() {}
async function sleep() {}

function simulateClick(target) {
  clicks.push(target.textContent || target.value || 'button');
}

${extractFunction('getSignupEntryVariantLabel')}
${extractFunction('waitForSignupEntryState')}

return {
  async run(options) {
    return waitForSignupEntryState(options);
  },
  snapshot() {
    return { logs, clicks };
  },
};
`)(snapshots);
}

function createEnsureReadyApi(snapshot) {
  return new Function('snapshot', `
const logs = [];
const location = { href: snapshot.url || 'https://chatgpt.com/' };

async function waitForSignupEntryState() {
  return snapshot;
}

function getSignupEntryDiagnostics() {
  return { preferredEntryVariant: snapshot.entryVariant || '' };
}

function log(message, level = 'info') {
  logs.push({ message, level });
}

${extractFunction('ensureSignupEntryReady')}

return {
  async run(timeout) {
    return ensureSignupEntryReady(timeout);
  },
  snapshot() {
    return logs;
  },
};
`)(snapshot);
}

test('inspectSignupEntryState keeps direct email entry flow unchanged', () => {
  const emailInput = { value: '', hidden: false };
  const api = createInspectApi({
    emailInput,
    actionCandidates: [
      createAction('Continue with email'),
      createAction('Sign up'),
    ],
  });

  const result = api.inspectSignupEntryState();

  assert.equal(result.state, 'email_entry');
  assert.equal(result.emailInput, emailInput);
  assert.equal(result.url, 'https://chatgpt.com/');
});

test('inspectSignupEntryState classifies a pre-email entry as email_gate', () => {
  const emailGateTrigger = createAction('Continue with email address');
  const api = createInspectApi({
    actionCandidates: [emailGateTrigger],
  });

  const result = api.inspectSignupEntryState();

  assert.equal(result.state, 'entry_home');
  assert.equal(result.entryVariant, 'email_gate');
  assert.equal(result.signupTrigger, emailGateTrigger);
  assert.match(result.signupTriggerText, /email/i);
});

test('inspectSignupEntryState prefers email_gate over a generic signup trigger', () => {
  const genericTrigger = createAction('Sign up');
  const emailGateTrigger = createAction('Continue with email');
  const api = createInspectApi({
    actionCandidates: [genericTrigger, emailGateTrigger],
  });

  const result = api.inspectSignupEntryState();

  assert.equal(result.state, 'entry_home');
  assert.equal(result.entryVariant, 'email_gate');
  assert.equal(result.signupTrigger, emailGateTrigger);
});

test('waitForSignupEntryState auto-opens the email gate before continuing', async () => {
  const emailGateTrigger = { textContent: 'Continue with email' };
  const api = createWaitApi([
    {
      state: 'entry_home',
      entryVariant: 'email_gate',
      signupTrigger: emailGateTrigger,
      url: 'https://chatgpt.com/',
    },
    {
      state: 'email_entry',
      emailInput: { value: '' },
      continueButton: { textContent: 'Continue' },
      url: 'https://auth.openai.com/u/login/identifier',
    },
  ]);

  const result = await api.run({
    timeout: 5000,
    autoOpenEntry: true,
  });
  const snapshot = api.snapshot();

  assert.equal(result.state, 'email_entry');
  assert.deepStrictEqual(snapshot.clicks, ['Continue with email']);
  assert.match(snapshot.logs[0], /邮箱登录入口/);
});

test('ensureSignupEntryReady treats email_gate as a valid pre-email ready state', async () => {
  const api = createEnsureReadyApi({
    state: 'entry_home',
    entryVariant: 'email_gate',
    url: 'https://chatgpt.com/',
  });

  const result = await api.run(3000);

  assert.deepStrictEqual(result, {
    ready: true,
    state: 'entry_home',
    entryVariant: 'email_gate',
    url: 'https://chatgpt.com/',
  });
});

test('non-target email buttons are not classified as an email_gate entry', () => {
  const api = createInspectApi({
    actionCandidates: [createAction('Email support')],
  });

  assert.equal(api.isSignupEmailGateActionText('Email support'), false);
  assert.equal(api.inspectSignupEntryState().state, 'unknown');
});
