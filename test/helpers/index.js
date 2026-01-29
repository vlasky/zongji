import mysql from 'mysql2';

import settings from '../settings/mysql.js';
import querySequence from './querySequence.js';

export const SCHEMA_NAME = settings.connection.database;

export function init(done) {
  const connObj = {...settings.connection};
  // database doesn't exist at this time
  delete connObj.database;
  const conn = mysql.createConnection(connObj);

  // First get the version to determine correct reset command
  querySequence(conn, ['SELECT VERSION() AS version'], (err, results) => {
    if (err) {
      conn.destroy();
      return done(err);
    }

    const ver = results[results.length - 1][0]
      .version.split('-')[0]
      .split('.')
      .map(part => parseInt(part, 10));

    // MySQL 8.4+ uses RESET BINARY LOGS AND GTIDS instead of RESET MASTER
    const resetCommand = (ver[0] > 8 || (ver[0] === 8 && ver[1] >= 4))
      ? 'RESET BINARY LOGS AND GTIDS'
      : 'RESET MASTER';

    querySequence(
      conn,
      [
        'SET GLOBAL sql_mode = \'' + settings.sessionSqlMode + '\'',
        `DROP DATABASE IF EXISTS ${SCHEMA_NAME}`,
        `CREATE DATABASE ${SCHEMA_NAME}`,
        `USE ${SCHEMA_NAME}`,
        resetCommand,
      ],
      error => {
        conn.destroy();
        done(error);
      }
    );
  });
}

// Promise-based version of init
export function initAsync() {
  return new Promise((resolve, reject) => {
    init(err => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function execute(queries, done) {
  const conn = mysql.createConnection(settings.connection);
  querySequence(
    conn,
    queries,
    (error, result) => {
      conn.destroy();
      done(error, result);
    }
  );
}

// Promise-based version of execute
export function executeAsync(queries) {
  return new Promise((resolve, reject) => {
    execute(queries, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

const checkVersion = function(expected, actual) {
  const parts = expected.split('.').map(part => parseInt(part, 10));
  for (let i = 0; i < parts.length; i++) {
    if (actual[i] == parts[i]) {
      continue;
    }
    return actual[i] > parts[i];
  }
  return true;
};

export function requireVersion(expected, done) {
  const connObj = {...settings.connection};
  // database doesn't exist at this time
  delete connObj.database;
  const conn = mysql.createConnection(connObj);
  querySequence(conn, ['SELECT VERSION() AS version'], (err, results) => {
    conn.destroy();

    if (err) {
      throw err;
    }

    let ver = results[results.length - 1][0]
      .version.split('-')[0]
      .split('.')
      .map(part => parseInt(part, 10));

    if (checkVersion(expected, ver)) {
      done();
    }
  });
}

let id = 100;
export function serverId() {
  id ++;
  return id;
}

export function strRepeat(pattern, count) {
  if (count < 1) return '';
  let result = '';
  let pos = 0;
  while (pos < count) {
    result += pattern.replace(/##/g, pos);
    pos++;
  }
  return result;
}
