const fs = require('fs');
const path = require('path');
const {
  ROOT,
  APP_NAME,
  APP_BUNDLE_ID,
  BUILD_DIR,
  APP_DIR,
  ICON_PATH,
  ICON_STEM,
  RESOURCE_ICON_PATH,
  PACKAGER_IGNORE,
} = require('./package-config');

async function build() {
  const { packager } = await import('@electron/packager');
  await packager({
    dir: ROOT,
    name: APP_NAME,
    platform: 'darwin',
    arch: 'arm64',
    icon: ICON_STEM,
    out: BUILD_DIR,
    overwrite: true,
    appBundleId: APP_BUNDLE_ID,
    ignore: PACKAGER_IGNORE,
  });

  fs.mkdirSync(path.dirname(RESOURCE_ICON_PATH), { recursive: true });
  fs.copyFileSync(ICON_PATH, RESOURCE_ICON_PATH);
  const now = new Date();
  fs.utimesSync(APP_DIR, now, now);
  return APP_DIR;
}

if (require.main === module) {
  build()
    .then((appDir) => {
      console.log(`Built ${appDir}`);
    })
    .catch((err) => {
      console.error(err && err.stack ? err.stack : err);
      process.exit(1);
    });
}

module.exports = { build };
