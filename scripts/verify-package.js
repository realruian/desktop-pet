const fs = require('fs');
const path = require('path');
const { APP_DIR } = require('./package-config');

const SECRET_RE = /(^|\/)(config\.json|\.env(\..*)?|[^/]+\.(pem|key))$/;

function scanForSensitiveFiles(root = APP_DIR) {
  const hits = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else {
        const rel = p.slice(root.length).replace(/\\/g, '/');
        if (SECRET_RE.test(rel)) hits.push(p);
      }
    }
  }
  walk(root);
  return hits;
}

if (require.main === module) {
  const hits = scanForSensitiveFiles(process.argv[2] || APP_DIR);
  if (hits.length) {
    console.error('Sensitive files found in app bundle:');
    hits.forEach((p) => console.error('  ' + p));
    process.exit(1);
  }
  console.log('No sensitive files found in app bundle.');
}

module.exports = { scanForSensitiveFiles };
