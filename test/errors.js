import tap from 'tap';
import { execFile } from 'child_process';

import ZongJi from '../index.js';
import settings from './settings/mysql.js';
import * as testDb from './helpers/index.js';

tap.test('Connect to an invalid host', test => {
  const zongji = new ZongJi({
    host: 'wronghost',
    user: 'wronguser',
    password: 'wrongpass'
  });

  let ended = false;
  // ZongJi creates two connections (ctrlConnection + connection), both will
  // fail with ENOTFOUND. We must handle all errors to prevent unhandled rejections.
  zongji.on('error', function(error) {
    if (!ended) {
      ended = true;
      test.ok(['ENOTFOUND', 'ETIMEDOUT'].indexOf(error.code) !== -1);
      zongji.stop();
      test.end();
    }
    // Ignore subsequent errors - they're expected from the second connection
  });

  zongji.start();
});

tap.test('Initialise testing db', async test => {
  try {
    await testDb.initAsync();
    test.pass('database initialized');
  } catch (err) {
    test.fail(err);
  }
});

const ACCEPTABLE_ERRORS = [
  'PROTOCOL_CONNECTION_LOST',
  // MySQL 5.1 emits a packet sequence error when the binlog disconnected
  'PROTOCOL_INCORRECT_PACKET_SEQUENCE'
];

tap.test('Disconnect binlog connection', test => {
  const zongji = new ZongJi(settings.connection);

  zongji.start({
    includeEvents: ['tablemap', 'writerows', 'updaterows', 'deleterows'],
    serverId: testDb.serverId(),
  });

  zongji.on('ready', () => {
    let threadId = zongji.connection.threadId;
    test.ok(!isNaN(threadId));
    testDb.execute([`kill ${threadId}`], err => {
      if (err) {
        test.threw(err);
      }
    });
  });

  zongji.on('error', err => {
    if (ACCEPTABLE_ERRORS.indexOf(err.code) > -1) {
      zongji.stop();
      test.end();
    } else {
      test.threw(err);
    }
  });
});

tap.test('Disconnect control connection', test => {
  const zongji = new ZongJi(settings.connection);

  zongji.start({
    includeEvents: ['tablemap', 'writerows', 'updaterows', 'deleterows'],
    serverId: testDb.serverId(),
  });

  zongji.on('ready', () => {
    let threadId = zongji.ctrlConnection.threadId;
    test.ok(!isNaN(threadId));
    testDb.execute([`kill ${threadId}`], err => {
      if (err) {
        test.threw(err);
      }
    });
  });

  zongji.on('error', err => {
    if (ACCEPTABLE_ERRORS.indexOf(err.code) > -1) {
      zongji.stop();
      test.end();
    } else {
      test.threw(err);
    }
  });
});


tap.test('Events come through in sequence', test => {
  const NEW_INST_TIMEOUT = 1000;
  const UPDATE_INTERVAL = 300;
  const UPDATE_COUNT = 5;
  const TEST_TABLE = 'reconnect_at_pos';

  test.test(`prepare table ${TEST_TABLE}`, test => {
    testDb.execute([
      `DROP TABLE IF EXISTS ${TEST_TABLE}`,
      `CREATE TABLE ${TEST_TABLE} (col INT UNSIGNED)`,
      `INSERT INTO ${TEST_TABLE} (col) VALUES (10)`,
    ], err =>{
      if (err) {
        return test.threw(err);
      }
      test.end();
    });
  });

  test.test('when reconnect', test => {
    const result = [];
    let first;
    let second;
    let ended = false;
    let pendingStops = 0;
    let endCalled = false;

    function finalize() {
      if (endCalled) return;
      endCalled = true;
      test.end();
    }

    function stopInstance(instance) {
      if (!instance) return;
      pendingStops += 1;
      instance.once('stopped', () => {
        pendingStops -= 1;
        if (ended && pendingStops === 0) {
          finalize();
        }
      });
      instance.stop();
    }

    function startPeriodicallyWriting() {
      let sequences = Array.from(
        {length: UPDATE_COUNT},
        (_, i) => `INSERT INTO ${TEST_TABLE} (col) VALUES (${i})`
      );

      let updateInterval = setInterval(() => {
        testDb.execute([sequences.shift()], error => {
          if (error) {
            clearInterval(updateInterval);
            test.threw(error);
          }
        });

        if (sequences.length === 0) {
          clearInterval(updateInterval);
        }
      }, UPDATE_INTERVAL);
    }

    function newInstance(options) {
      const zongji = new ZongJi(settings.connection);

      zongji.start({
        ...options,
        // Must include rotate events for filename and position properties
        includeEvents: [
          'rotate', 'tablemap', 'writerows', 'updaterows', 'deleterows'
        ]
      });

      zongji.on('binlog', function(event) {
        if (event.getTypeName() === 'WriteRows') {
          result.push(event.rows[0].col);
        }

        if (result.length === UPDATE_COUNT) {
          ended = true;
          test.strictSame(
            result,
            Array.from({length: UPDATE_COUNT}, (_, i) => i)
          );
          stopInstance(first);
          stopInstance(second);
          if (pendingStops === 0) {
            finalize();
          }
        }
      });

      return zongji;
    }

    first = newInstance({
      serverId: testDb.serverId(),
      startAtEnd: true,
    });
    test.teardown(() => {
      ended = true;
      stopInstance(first);
      stopInstance(second);
    });

    first.on('ready', () => {
      startPeriodicallyWriting();

      first.on('stopped', () => {
        if (ended) return;
        // Start new ZongJi instance where the previous was when stopped
        second = newInstance({
          serverId: testDb.serverId(),
          filename: first.get('filename'),
          position: first.get('position'),
        });
      });
      setTimeout(() => first.stop(), NEW_INST_TIMEOUT);
    });
  });

  test.end();
});

tap.test('Calling start() twice does not duplicate the binlog stream', test => {
  const TEST_TABLE = 'double_start_test';
  const zongji = new ZongJi(settings.connection);
  test.teardown(() => zongji.stop());

  const events = [];
  const errors = [];
  zongji.on('binlog', evt => events.push(evt));
  zongji.on('error', err => errors.push(err));

  testDb.execute([
    `DROP TABLE IF EXISTS ${TEST_TABLE}`,
    `CREATE TABLE ${TEST_TABLE} (col INT UNSIGNED)`,
  ], err => {
    if (err) {
      return test.fail(err);
    }

    const options = {
      startAtEnd: true,
      serverId: testDb.serverId(),
      includeEvents: ['tablemap', 'writerows'],
    };
    // Second synchronous call must be a no-op while the first initialises
    zongji.start(options);
    zongji.start(options);

    zongji.on('ready', () => {
      testDb.execute([
        `INSERT INTO ${TEST_TABLE} (col) VALUES (7)`,
      ], insertErr => {
        if (insertErr) {
          return test.fail(insertErr);
        }
        setTimeout(() => {
          test.equal(errors.length, 0, 'no errors after double start');
          test.equal(events.length, 2,
            'exactly one tablemap + one writerows (no duplicated stream)');
          test.equal(events[1].rows[0].col, 7);
          test.end();
        }, 1500);
      });
    });
  });
});

tap.test('Dead control connection during metadata fetch emits error', test => {
  const TEST_TABLE = 'dead_ctrl_conn_test';
  const zongji = new ZongJi(settings.connection);
  test.teardown(() => zongji.stop());

  const errors = [];
  zongji.on('error', err => errors.push(err));

  testDb.execute([
    `DROP TABLE IF EXISTS ${TEST_TABLE}`,
    `CREATE TABLE ${TEST_TABLE} (col INT UNSIGNED)`,
  ], err => {
    if (err) {
      return test.fail(err);
    }

    zongji.start({
      startAtEnd: true,
      serverId: testDb.serverId(),
      includeEvents: ['tablemap', 'writerows'],
    });

    zongji.on('ready', () => {
      const threadId = zongji.ctrlConnection.threadId;
      testDb.execute([`kill ${threadId}`], killErr => {
        if (killErr) {
          return test.fail(killErr);
        }
        // Give the control connection a moment to observe the kill, then
        // trigger a TableMap event that requires a metadata fetch
        setTimeout(() => {
          testDb.execute([
            `INSERT INTO ${TEST_TABLE} (col) VALUES (1)`,
          ], insertErr => {
            if (insertErr) {
              return test.fail(insertErr);
            }
            setTimeout(() => {
              test.ok(
                errors.some(e => /Binlog processing has halted/.test(e.message)),
                'received explicit halt error instead of a silent hang');
              test.end();
            }, 1500);
          });
        }, 500);
      });
    });
  });
});

tap.test('Errors throw when no error listener is ever attached', test => {
  const indexUrl = new URL('../index.js', import.meta.url).href;
  const script = `
    import(${JSON.stringify(indexUrl)}).then(({ default: ZongJi }) => {
      const zongji = new ZongJi({ host: '127.0.0.1', port: 1, user: 'x' });
      zongji.start();
    });
  `;
  execFile(process.execPath, ['-e', script], { timeout: 15000 },
    (err, stdout, stderr) => {
      test.ok(err, 'process exited with failure');
      test.match(stderr, /ECONNREFUSED/,
        'connection error surfaced as uncaught exception');
      test.end();
    });
});
