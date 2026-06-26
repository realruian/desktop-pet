// build/pack.js — package 河马.app (@electron/packager, programmatic).
//
// Why a script and not a one-line CLI: packager's --icon silently fails for us,
// so we overwrite electron.icns directly and refresh the bundle mtime afterward
// so Finder/Dock pick up the icon. No native modules anymore (the wake-word
// engine was removed), so a plain asar bundle is all we need.

const path = require('path');
const fs = require('fs');
const { packager } = require('@electron/packager');

const ROOT = path.join(__dirname, '..');
// Build for whatever Mac is running the pack (Apple Silicon → arm64, Intel → x64).
const ARCH = process.arch === 'x64' ? 'x64' : 'arm64';

(async () => {
  const appPaths = await packager({
    dir: ROOT,
    name: '河马',
    platform: 'darwin',
    arch: ARCH,
    out: path.join(ROOT, 'dist'),
    overwrite: true,
    appBundleId: 'com.simin.hema',
    extendInfo: path.join(ROOT, 'build', 'extend.plist'),
    asar: true,
    ignore: [
      /^\/像素狗狗动作帧/,
      /^\/dist/,
      /^\/build/,
      /^\/SPEC/,
      /^\/\.claude/,
      /\.py$/,
      /^\/主图/,
      /^\/README/,
      /_run/,
      /^\/config\.json$/,
      /^\/\.gitignore/,
      /^\/_/, // scratch dirs
    ],
  });

  const appBundle = path.join(appPaths[0], '河马.app');
  const resources = path.join(appBundle, 'Contents', 'Resources');

  // packager's --icon silently fails for us; overwriting electron.icns is the
  // reliable path (matches the prior working pack step).
  fs.copyFileSync(
    path.join(ROOT, 'build', 'icon.icns'),
    path.join(resources, 'electron.icns')
  );

  // Refresh the bundle mtime so Finder/Dock pick up the icon.
  const now = new Date();
  fs.utimesSync(appBundle, now, now);
  console.log('packaged OK → ' + appBundle);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
