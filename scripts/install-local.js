const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { build } = require('./build');
const { APP_DIR, APP_NAME } = require('./package-config');
const { scanForSensitiveFiles } = require('./verify-package');

const TARGET = process.env.PET_INSTALL_TARGET || `/Applications/${APP_NAME}.app`;

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit' });
}

async function installLocal() {
  const builtApp = await build();
  const hits = scanForSensitiveFiles(builtApp);
  if (hits.length) {
    throw new Error('Refusing to install bundle with sensitive files:\n' + hits.join('\n'));
  }

  try {
    run('osascript', ['-e', `tell application "${APP_NAME}" to quit`]);
  } catch (_) {
    /* app may not be running or may not be registered yet */
  }

  const tmp = path.join(path.dirname(TARGET), `.${APP_NAME}.app.tmp.${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  run('ditto', ['--rsrc', '--extattr', builtApp, tmp]);
  fs.rmSync(TARGET, { recursive: true, force: true });
  fs.renameSync(tmp, TARGET);
  try {
    run('xattr', ['-dr', 'com.apple.quarantine', TARGET]);
  } catch (_) {
    /* no quarantine xattr */
  }
  const now = new Date();
  fs.utimesSync(TARGET, now, now);
  console.log(`Installed ${TARGET}`);
}

if (require.main === module) {
  installLocal().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { installLocal, TARGET };
