const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const os = require('node:os');
const path = require('node:path');
const { chmod, mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(__dirname, '..');
const helperPath = path.join(projectRoot, 'scripts', 'hotmail_helper.py');

async function makeExecutable(dir, name, contents) {
  const filePath = path.join(dir, name);
  await writeFile(filePath, contents, 'utf8');
  await chmod(filePath, 0o755);
  return filePath;
}

async function runCreateAlias(env) {
  const pythonSnippet = `
import importlib.util
import json

helper_path = ${JSON.stringify(helperPath)}
spec = importlib.util.spec_from_file_location("hotmail_helper_test", helper_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
result = module.create_icloud_hide_my_email_alias(label="Test Alias", apple_id_password="")
print(json.dumps(result, ensure_ascii=False))
`;

  const { stdout } = await execFileAsync('python3', ['-c', pythonSnippet], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...env,
    },
  });
  return JSON.parse(stdout);
}

test('hotmail helper resolves Apple ID password from Keychain for local iCloud alias creation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'icloud-keychain-'));

  try {
    const fakeSwiftScript = path.join(dir, 'create_hide_my_email_ax.swift');
    await writeFile(fakeSwiftScript, '// stub swift file for tests\n', 'utf8');
    await makeExecutable(
      dir,
      'swift',
      `#!/usr/bin/env bash
if [ "$HIDDEN_MAIL_APPLE_ID_PASSWORD" != "from-mock-keychain" ]; then
  echo "expected keychain password, got: $HIDDEN_MAIL_APPLE_ID_PASSWORD" >&2
  exit 1
fi
printf '%s\\n' 'relay@example.com'
`,
    );
    await makeExecutable(
      dir,
      'security',
      `#!/usr/bin/env bash
if [ "$1" = "find-generic-password" ] && [ "$2" = "-a" ] && [ "$3" = "apple-id" ] && [ "$4" = "-s" ] && [ "$5" = "hidden-mail.apple-id-password" ] && [ "$6" = "-w" ]; then
  printf '%s' 'from-mock-keychain'
  exit 0
fi
echo "unexpected security invocation: $*" >&2
exit 1
`,
    );

    const payload = await runCreateAlias({
      PATH: `${dir}:${process.env.PATH}`,
      MULTIPAGE_ICLOUD_CREATE_SWIFT_SCRIPT: fakeSwiftScript,
      HIDDEN_MAIL_APPLE_ID_PASSWORD: '',
    });

    assert.equal(payload.email, 'relay@example.com');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('hotmail helper falls back to the local secret file when Keychain lookup is unavailable', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'icloud-secret-file-'));

  try {
    const homeDir = path.join(dir, 'home');
    const secretDir = path.join(homeDir, '.hidden-mail');
    const fakeSwiftScript = path.join(dir, 'create_hide_my_email_ax.swift');
    await mkdir(secretDir, { recursive: true });
    await writeFile(fakeSwiftScript, '// stub swift file for tests\n', 'utf8');
    await writeFile(path.join(secretDir, 'apple-id-password'), 'from-secret-file\n', 'utf8');
    await makeExecutable(
      dir,
      'swift',
      `#!/usr/bin/env bash
if [ "$HIDDEN_MAIL_APPLE_ID_PASSWORD" != "from-secret-file" ]; then
  echo "expected secret-file password, got: $HIDDEN_MAIL_APPLE_ID_PASSWORD" >&2
  exit 1
fi
printf '%s\\n' 'relay@example.com'
`,
    );
    await makeExecutable(
      dir,
      'security',
      `#!/usr/bin/env bash
exit 1
`,
    );

    const payload = await runCreateAlias({
      HOME: homeDir,
      PATH: `${dir}:${process.env.PATH}`,
      MULTIPAGE_ICLOUD_CREATE_SWIFT_SCRIPT: fakeSwiftScript,
      HIDDEN_MAIL_APPLE_ID_PASSWORD: '',
    });

    assert.equal(payload.email, 'relay@example.com');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
