const fs = require('fs');
const path = require('path');

function createConfigStore({ app, baseDir }) {
  const dir = app.getPath('userData');
  const paths = [
    path.join(dir, 'config.json'),
    ...(app.isPackaged ? [] : [path.join(baseDir, 'config.json')]),
  ];

  function read() {
    for (const p of paths) {
      try {
        return {
          data: JSON.parse(fs.readFileSync(p, 'utf8')) || {},
          path: p,
        };
      } catch (_) {
        /* try the next path */
      }
    }
    return { data: {}, path: null };
  }

  function preferredPath() {
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
    return app.isPackaged ? paths[0] : path.join(baseDir, 'config.json');
  }

  function write(data, target = preferredPath()) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(data || {}, null, 2));
    return target;
  }

  function patch(section, partial) {
    const { data } = read();
    data[section] = Object.assign({}, data[section], partial);
    return write(data, paths[0]);
  }

  return { dir, paths, read, preferredPath, write, patch };
}

module.exports = { createConfigStore };
