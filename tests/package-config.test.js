const assert = require('assert');
const test = require('node:test');
const { PACKAGER_IGNORE } = require('../scripts/package-config');

function kept(file) {
  return !PACKAGER_IGNORE.some((regex) => file.match(regex));
}

test('package ignore excludes local secrets and docs', () => {
  assert.equal(kept('/config.json'), false);
  assert.equal(kept('/.env'), false);
  assert.equal(kept('/.env.local'), false);
  assert.equal(kept('/secret.pem'), false);
  assert.equal(kept('/secret.key'), false);
  assert.equal(kept('/scripts/build.js'), false);
  assert.equal(kept('/tests/key-utils.test.js'), false);
  assert.equal(kept('/COURSE_OPERATION_GUIDE.md'), false);
});

test('package ignore keeps runtime app files', () => {
  assert.equal(kept('/main.js'), true);
  assert.equal(kept('/lib/config-store.js'), true);
  assert.equal(kept('/shared/key-utils.js'), true);
  assert.equal(kept('/config.example.json'), true);
  assert.equal(kept('/assets/app-icon.icns'), true);
});
