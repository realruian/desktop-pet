const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_NAME = 'HemaDesktopPet';
const APP_BUNDLE_ID = 'com.tianruian.hemadesktoppet';
const BUILD_DIR = path.join(ROOT, 'dist');
const APP_DIR = path.join(BUILD_DIR, `${APP_NAME}-darwin-arm64`, `${APP_NAME}.app`);
const ICON_PATH = path.join(ROOT, 'assets', 'app-icon.icns');
const ICON_STEM = path.join(ROOT, 'assets', 'app-icon');
const RESOURCE_ICON_PATH = path.join(APP_DIR, 'Contents', 'Resources', 'electron.icns');

const PACKAGER_IGNORE = [
  /^\/dist($|\/)/,
  /^\/\.git($|\/)/,
  /^\/config\.json$/,
  /^\/\.env(\..*)?$/,
  /\.(pem|key)$/,
  /^\/scripts($|\/)/,
  /^\/tests($|\/)/,
  /^\/COURSE_OPERATION_GUIDE\.md$/,
  /^\/SPEC2?\.md$/,
];

module.exports = {
  ROOT,
  APP_NAME,
  APP_BUNDLE_ID,
  BUILD_DIR,
  APP_DIR,
  ICON_PATH,
  ICON_STEM,
  RESOURCE_ICON_PATH,
  PACKAGER_IGNORE,
};
