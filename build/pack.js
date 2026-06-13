// build/pack.js — package 多吉.app (@electron/packager, programmatic).
//
// Why a script and not a one-line CLI: the wake-word feature adds a native
// module (sherpa-onnx-node + its .dylibs) and the KWS model files, all of which
// must live OUTSIDE the asar archive on the real filesystem — the native C-API
// reader can't see into app.asar. We unpack them, copy the (reliably working)
// icon, and verify the unpacked layout so a broken bundle fails the build
// instead of shipping.

const path = require('path');
const fs = require('fs');
const { packager } = require('@electron/packager');

const ROOT = path.join(__dirname, '..');

(async () => {
  const appPaths = await packager({
    dir: ROOT,
    name: '多吉',
    platform: 'darwin',
    arch: 'arm64',
    out: path.join(ROOT, 'dist'),
    overwrite: true,
    appBundleId: 'com.simin.duoji',
    extendInfo: path.join(ROOT, 'build', 'extend.plist'),
    asar: {
      // Native binaries (.node + onnxruntime/sherpa .dylib) must be on disk and
      // STAY SIBLINGS so the .node's @loader_path rpath resolves them; the KWS
      // model dir is read by the native file I/O, so it can't be in the asar.
      unpack: '**/*.{node,dylib}',
      unpackDir: 'assets/kws',
    },
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
      /^\/_/, // scratch dirs incl. _kws_spike
    ],
  });

  const appBundle = path.join(appPaths[0], '多吉.app');
  const resources = path.join(appBundle, 'Contents', 'Resources');

  // packager's --icon silently fails for us; overwriting electron.icns is the
  // reliable path (matches the prior working pack step).
  fs.copyFileSync(
    path.join(ROOT, 'build', 'icon.icns'),
    path.join(resources, 'electron.icns')
  );

  // Verify the bits that MUST be unpacked actually are — fail the build loudly
  // if the asar globs didn't catch them.
  const unpacked = path.join(resources, 'app.asar.unpacked');
  const mustExist = [
    'node_modules/sherpa-onnx-darwin-arm64/sherpa-onnx.node',
    'node_modules/sherpa-onnx-darwin-arm64/libonnxruntime.1.24.4.dylib',
    'node_modules/sherpa-onnx-darwin-arm64/libsherpa-onnx-c-api.dylib',
    'assets/kws/encoder.int8.onnx',
    'assets/kws/tokens.txt',
    'assets/kws/keywords.txt',
  ];
  const missing = mustExist.filter((f) => !fs.existsSync(path.join(unpacked, f)));
  if (missing.length) {
    throw new Error('NOT unpacked (wake word would break):\n  ' + missing.join('\n  '));
  }

  // Refresh the bundle mtime so Finder/Dock pick up the icon.
  const now = new Date();
  fs.utimesSync(appBundle, now, now);
  console.log('packaged + verified OK → ' + appBundle);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
