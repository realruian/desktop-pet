const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHARACTERS_DIR = path.join(ROOT, 'assets', 'characters');
const CLIPS = { walk: 8, scratch: 6, wave: 4, roll: 6, cheer: 5 };
const EXPRESSIONS = ['tearful.png', 'tearful-2.png', 'tearful-3.png', 'tearful-4.png'];

function checkAssets() {
  const problems = [];
  for (const id of fs.readdirSync(CHARACTERS_DIR)) {
    const dir = path.join(CHARACTERS_DIR, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    } catch (_) {
      problems.push(`${id}: missing/bad meta.json`);
    }
    if (meta.id && meta.id !== id) problems.push(`${id}: meta id mismatch ${meta.id}`);
    for (const [clip, count] of Object.entries(CLIPS)) {
      for (let i = 1; i <= count; i++) {
        const file = path.join(dir, clip, String(i).padStart(2, '0') + '.png');
        if (!fs.existsSync(file)) problems.push(`${id}: missing ${clip}/${String(i).padStart(2, '0')}.png`);
      }
    }
    for (const file of EXPRESSIONS) {
      if (!fs.existsSync(path.join(dir, 'expressions', file))) {
        problems.push(`${id}: missing expressions/${file}`);
      }
    }
  }
  return problems;
}

if (require.main === module) {
  const problems = checkAssets();
  if (problems.length) {
    problems.forEach((p) => console.error(p));
    process.exit(1);
  }
  console.log('asset_check_bad=0');
}

module.exports = { checkAssets };
