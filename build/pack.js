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
// Build for whatever Mac is running the pack (Apple Silicon → arm64, Intel →
// x64). npm already installed the matching sherpa-onnx prebuilt as an optional
// dep, so a friend on either chip can just `npm run pack`.
const ARCH = process.arch === 'x64' ? 'x64' : 'arm64';

(async () => {
  const appPaths = await packager({
    dir: ROOT,
    name: '多吉',
    platform: 'darwin',
    arch: ARCH,
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
  // if the asar globs didn't catch them (version-agnostic so a newer
  // sherpa-onnx / either arch still passes).
  const unpacked = path.join(resources, 'app.asar.unpacked');
  const nativeDir = path.join(
    unpacked,
    'node_modules',
    'sherpa-onnx-darwin-' + ARCH
  );
  const problems = [];
  let nativeFiles = [];
  try {
    nativeFiles = fs.readdirSync(nativeDir);
  } catch (_) {
    problems.push('native module dir missing: ' + nativeDir);
  }
  if (!nativeFiles.includes('sherpa-onnx.node')) problems.push('sherpa-onnx.node not unpacked');
  if (!nativeFiles.some((f) => /^libonnxruntime.*\.dylib$/.test(f)))
    problems.push('libonnxruntime*.dylib not unpacked');
  if (!nativeFiles.includes('libsherpa-onnx-c-api.dylib'))
    problems.push('libsherpa-onnx-c-api.dylib not unpacked');
  for (const f of ['encoder.int8.onnx', 'tokens.txt', 'keywords.txt']) {
    if (!fs.existsSync(path.join(unpacked, 'assets', 'kws', f)))
      problems.push('assets/kws/' + f + ' not unpacked');
  }
  if (problems.length) {
    throw new Error('NOT unpacked (wake word would break):\n  ' + problems.join('\n  '));
  }

  // Refresh the bundle mtime so Finder/Dock pick up the icon.
  const now = new Date();
  fs.utimesSync(appBundle, now, now);
  console.log('packaged + verified OK → ' + appBundle);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
