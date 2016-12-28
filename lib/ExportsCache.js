import path from 'path';

import sqlite3 from 'sqlite3';

import lastUpdate from './lastUpdate';

const MAX_CHUNK_SIZE = 100;

function normalizedExportName(string) {
  return string.toLowerCase().replace(/[-_]/g, '');
}

function inParam(sql, values) {
  // https://github.com/mapbox/node-sqlite3/issues/721
  return sql.replace('?#', values.map(() => '?').join(','));
}

function arrayToChunks(array, chunkSize) {
  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

export default class ExportsCache {
  constructor(workingDirectory) {
    this.workingDirectory = workingDirectory;
  }

  init(dbFilename) {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(
        dbFilename || path.join(this.workingDirectory, '.importjs.db'));
      this.db.run(`
        CREATE TABLE IF NOT EXISTS exports (
          key VARCHAR(100),
          name VARCHAR(100),
          path TEXT
        )
      `, (err) => {
        if (err) {
          reject(err);
          return;
        }

        this.db.run(`
          CREATE TABLE IF NOT EXISTS mtimes (
            path TEXT,
            mtime NUMERIC
          )
        `, (err) => {
          if (err) {
            reject(err);
            return;
          }

          resolve();
        });
      });
    });
  }

  close() {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  needsUpdate(files) {
    if (files.length > MAX_CHUNK_SIZE) {
      // sqlite has a max number for arguments passed. We need to execute in
      // chunks if we exceed the max.
      const promises = arrayToChunks(files, MAX_CHUNK_SIZE).map((chunk) =>
        this.needsUpdate(chunk));
      return Promise.all(promises)
        .then((chunks) => chunks.reduce((a, b) => a.concat(b))); // flatten
    }
    return new Promise((resolve, reject) => {
      Promise.all(files.map(lastUpdate)).then((updates) => {
        this.db.all(inParam(`
          SELECT path, mtime FROM mtimes
          WHERE (path IN (?#))
        `, files), files, (err, items) => {
          if (err) {
            reject(err);
            return;
          }
          const mtimes = {};
          items.forEach(({ path: pathToFile, mtime }) => {
            mtimes[pathToFile] = mtime;
          });
          const filtered = updates.filter(({ pathToFile, mtime }) =>
            mtime !== mtimes[pathToFile]);
          resolve(filtered.map(f => f.pathToFile));
        });
      });
    });
  }

  updateMtime(pathToFile) {
    return new Promise((resolve, reject) => {
      lastUpdate(pathToFile).then(({ mtime }) => {
        this.db.get('SELECT mtime FROM mtimes WHERE (path = ?)',
          pathToFile, (err, item) => {
            if (err) {
              reject(err);
              return;
            }
            if (item) {
              this.db.run('UPDATE mtimes SET mtime = ? WHERE (path = ?)',
                pathToFile, (err) => {
                  if (err) {
                    reject(err);
                    return;
                  }
                  resolve();
                });
            } else {
              this.db.run('INSERT INTO mtimes (mtime, path) VALUES (?, ?)',
                mtime, pathToFile, (err) => {
                  if (err) {
                    reject(err);
                    return;
                  }
                  resolve();
                });
            }
          });
      });
    });
  }

  add(name, pathToFile, isDefault) {
    return new Promise((resolve, reject) => {
      const key = normalizedExportName(name);
      const exportName = isDefault ? 'default' : name;

      this.updateMtime(pathToFile).then(() => {
        this.db.get('SELECT key FROM exports WHERE (key = ? AND path = ?)',
          key, pathToFile, (err, item) => {
            if (err) {
              reject(err);
              return;
            }
            if (item) {
              this.db.run('UPDATE exports SET name = ? WHERE (key = ? AND path = ?)',
                exportName, key, pathToFile, (err) => {
                  if (err) {
                    reject(err);
                    return;
                  }
                  resolve();
                });
            } else {
              this.db.run('INSERT INTO exports (key, name, path) VALUES (?, ?, ?)',
                key, exportName, pathToFile, (err) => {
                  if (err) {
                    reject(err);
                    return;
                  }
                  resolve();
                });
            }
          });
      });
    });
  }

  remove(pathToFile) {
    return new Promise((resolve, reject) => {
      this.db.run('DELETE FROM exports WHERE (path = ?)', pathToFile, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  get(variableName) {
    return new Promise((resolve, reject) => {
      this.db.all('SELECT name, path FROM exports WHERE (key = ?)',
        normalizedExportName(variableName), (err, rows) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(rows);
        });
    });
  }
}