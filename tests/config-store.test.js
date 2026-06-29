const assert = require('assert');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createConfigStore } = require('../lib/config-store');

function fakeApp(userData, isPackaged) {
  return {
    isPackaged,
    getPath(name) {
      assert.equal(name, 'userData');
      return userData;
    },
  };
}

test('dev config paths include repo fallback', () => {
  const userData = path.join(os.tmpdir(), 'pet-user-data');
  const store = createConfigStore({
    app: fakeApp(userData, false),
    baseDir: '/repo',
  });
  assert.deepEqual(store.paths, [
    path.join(userData, 'config.json'),
    path.join('/repo', 'config.json'),
  ]);
});

test('packaged config paths exclude bundled config fallback', () => {
  const userData = path.join(os.tmpdir(), 'pet-user-data');
  const store = createConfigStore({
    app: fakeApp(userData, true),
    baseDir: '/repo',
  });
  assert.deepEqual(store.paths, [path.join(userData, 'config.json')]);
});
