const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFile } = require('node:fs/promises');

const projectRoot = path.resolve(__dirname, '..');
const swiftScriptPath = path.join(projectRoot, 'scripts', 'create_hide_my_email_ax.swift');

async function readSwiftScript() {
  return readFile(swiftScriptPath, 'utf8');
}

test('iCloud Swift helper launches System Settings before opening the iCloud pane', async () => {
  const source = await readSwiftScript();

  assert.notEqual(
    source.indexOf('ensureSystemSettingsWindow()\nactivateSystemSettings()\nensureICloudPane()'),
    -1,
    'script should explicitly launch and activate System Settings before navigating to the iCloud pane',
  );
});

test('iCloud Swift helper quits System Settings after alias creation instead of dismissing nested dialogs', async () => {
  const source = await readSwiftScript();

  assert.notEqual(
    source.indexOf('terminateSystemSettingsIfRunning()\n\nprint(relayEmail)'),
    -1,
    'script should quit System Settings after the create-address sheet closes',
  );
  assert.equal(
    source.includes('dismissHideMyEmailManager('),
    false,
    'legacy nested-dialog dismissal flow should be removed',
  );
});
