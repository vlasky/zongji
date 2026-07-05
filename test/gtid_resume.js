// Live tests for GTID-based resume: start({ gtidSet }) issues
// COM_BINLOG_DUMP_GTID and the server itself skips transactions already
// in the set. Requires gtid_mode=ON (enabled here; works on MySQL 5.7+).
import tap from 'tap';

import ZongJi from '../index.js';
import * as testDb from './helpers/index.js';
import settings from './settings/mysql.js';

const TEST_TABLE = 'gtid_resume_test';

// Resets the binlog so the "entire history" test below stays small
tap.test('Initialise testing db', async test => {
  try {
    await testDb.initAsync();
    test.pass('database initialized');
  } catch (err) {
    test.fail(err);
  }
});

const IS_MARIADB = await testDb.isMariaDb();
const MYSQL_ONLY =
  IS_MARIADB && 'MySQL gtid_mode only; see test/mariadb.js';
const NO_TAGGED_GTIDS = IS_MARIADB ? MYSQL_ONLY :
  (!(await testDb.serverVersionAtLeast('8.3.0')) &&
    'tagged GTIDs need MySQL 8.3+');

tap.test('resume from a persisted gtidSet delivers only new transactions',
  { skip: MYSQL_ONLY },
  test => {
    const first = new ZongJi(settings.connection);
    test.teardown(() => first.stop());
    first.on('error', err => test.fail(err));

    let checkpoint;
    const firstRows = [];
    first.on('binlog', event => {
      if (event.getTypeName() === 'WriteRows') {
        firstRows.push(event.rows[0].col);
      }
    });

    testDb.ensureGtidMode(() => testDb.execute([
      `DROP TABLE IF EXISTS ${TEST_TABLE}`,
      `CREATE TABLE ${TEST_TABLE} (col INT UNSIGNED)`,
    ], err => {
      if (err) {
        return test.fail(err);
      }

      first.start({
        startAtEnd: true,
        serverId: testDb.serverId(),
        includeEvents: ['tablemap', 'writerows'],
      });

      first.on('ready', () => {
        test.ok(first.gtidSet !== undefined,
          'startAtEnd seeds gtidSet from the server');

        // Two separate transactions observed by the first instance
        testDb.execute([
          `INSERT INTO ${TEST_TABLE} (col) VALUES (1)`,
          `INSERT INTO ${TEST_TABLE} (col) VALUES (2)`,
        ], insertErr => {
          if (insertErr) {
            return test.fail(insertErr);
          }

          setTimeout(() => {
            test.strictSame(firstRows, [1, 2]);
            checkpoint = first.gtidSet;
            test.match(checkpoint, /[0-9a-f-]{36}:/,
              'checkpoint includes observed transactions');
            first.stop();

            // Two more transactions while no listener is running
            testDb.execute([
              `INSERT INTO ${TEST_TABLE} (col) VALUES (3)`,
              `INSERT INTO ${TEST_TABLE} (col) VALUES (4)`,
            ], gapErr => {
              if (gapErr) {
                return test.fail(gapErr);
              }
              resumeAndVerify();
            });
          }, 1000);
        });
      });
    }));

    const resumeAndVerify = () => {
      const second = new ZongJi(settings.connection);
      test.teardown(() => second.stop());
      second.on('error', err => test.fail(err));

      const resumedRows = [];
      second.on('binlog', event => {
        if (event.getTypeName() === 'WriteRows') {
          resumedRows.push(event.rows[0].col);
        }
      });

      second.start({
        gtidSet: checkpoint,
        serverId: testDb.serverId(),
        includeEvents: ['tablemap', 'writerows'],
      });

      second.on('ready', () => {
        setTimeout(() => {
          test.strictSame(resumedRows, [3, 4],
            'only the transactions missing from the checkpoint arrive');
          test.not(second.gtidSet, checkpoint,
            'gtidSet advances past the replayed transactions');
          test.ok(second.gtidSet.length >= checkpoint.length,
            'resumed set contains the checkpoint');
          test.end();
        }, 1500);
      });
    };
  });

tap.test('empty gtidSet streams the entire available history',
  { skip: MYSQL_ONLY }, test => {
  const zongji = new ZongJi(settings.connection);
  test.teardown(() => zongji.stop());
  zongji.on('error', err => test.fail(err));

  const rows = [];
  zongji.on('binlog', event => {
    if (event.getTypeName() === 'WriteRows') {
      rows.push(event.rows[0].col);
    }
  });

  zongji.start({
    gtidSet: '',
    serverId: testDb.serverId(),
    includeEvents: ['tablemap', 'writerows'],
  });

  zongji.on('ready', () => {
    setTimeout(() => {
      // The binlog was reset at the top of this file, so history is
      // exactly the four inserts of the previous test
      test.strictSame(rows, [1, 2, 3, 4]);
      test.ok(zongji.gtidSet.length > 0,
        'gtidSet rebuilt from the full replay');
      test.end();
    }, 1500);
  });
});

tap.test('purged required GTIDs surface as an explicit error',
  { skip: MYSQL_ONLY }, test => {
  const zongji = new ZongJi(settings.connection);
  test.teardown(() => zongji.stop());

  const errors = [];
  zongji.on('error', err => errors.push(err));

  // Rotate and purge so gtid_purged is non-empty, making an empty client
  // set unsatisfiable
  testDb.execute(['FLUSH LOGS'], flushErr => {
    if (flushErr) {
      return test.fail(flushErr);
    }
    testDb.execute(['SHOW BINARY LOGS'], (showErr, results) => {
      if (showErr) {
        return test.fail(showErr);
      }
      const logs = results[0];
      const newest = logs[logs.length - 1].Log_name;
      testDb.execute([`PURGE BINARY LOGS TO '${newest}'`], purgeErr => {
        if (purgeErr) {
          return test.fail(purgeErr);
        }

        zongji.start({
          gtidSet: '',
          serverId: testDb.serverId(),
          includeEvents: ['writerows'],
        });

        setTimeout(() => {
          test.ok(errors.length > 0, 'an error is emitted');
          // The wire error is ER_SOURCE_FATAL_ERROR_READING_BINLOG (1236)
          // carrying the purged-GTIDs message text
          test.equal(errors[0].errno, 1236);
          test.match(errors[0].message, /purged/i);
          test.end();
        }, 2000);
      });
    });
  });
});

tap.test('gtidSet never claims an uncommitted XA transaction',
  { skip: MYSQL_ONLY }, test => {
  const TABLE = 'gtid_xa_test';
  const zongji = new ZongJi(settings.connection);
  test.teardown(() => new Promise(resolve => {
    zongji.stop();
    // Roll back the prepared transaction if the test failed before commit
    testDb.execute(["XA ROLLBACK 'xatest'"], () => resolve());
  }));
  zongji.on('error', err => test.fail(err));

  testDb.execute([
    `DROP TABLE IF EXISTS ${TABLE}`,
    `CREATE TABLE ${TABLE} (col INT UNSIGNED)`,
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
      const baseline = zongji.gtidSet;
      // All statements share one connection inside a single execute()
      testDb.execute([
        "XA START 'xatest'",
        `INSERT INTO ${TABLE} (col) VALUES (1)`,
        "XA END 'xatest'",
        "XA PREPARE 'xatest'",
      ], prepareErr => {
        if (prepareErr) {
          return test.fail(prepareErr);
        }

        setTimeout(() => {
          test.equal(zongji.gtidSet, baseline,
            'prepared-but-uncommitted XA transaction is not claimed');

          testDb.execute(["XA COMMIT 'xatest'"], commitErr => {
            if (commitErr) {
              return test.fail(commitErr);
            }
            setTimeout(() => {
              test.not(zongji.gtidSet, baseline,
                'set advances once the XA transaction commits');
              test.end();
            }, 1000);
          });
        }, 1000);
      });
    });
  });
});

tap.test('invalid gtidSet rejected before any connection work', test => {
  const zongji = new ZongJi(settings.connection);
  test.teardown(() => zongji.stop());

  const errors = [];
  zongji.on('error', err => errors.push(err));

  zongji.start({
    gtidSet: 'not-a-uuid:1-5',
    serverId: testDb.serverId(),
  });

  setImmediate(() => {
    test.equal(errors.length, 1);
    test.match(errors[0].message, /Invalid GTID/);
    test.equal(zongji.ready, false, 'start aborted');
    test.end();
  });
});

testDb.requireMySql(() => {
  tap.test('MariaDB-format gtidSet is rejected against MySQL', test => {
    const zongji = new ZongJi(settings.connection);
    test.teardown(() => zongji.stop());

    zongji.on('error', err => {
      test.match(err.message,
        /MariaDB GTID position but the server is MySQL/);
      test.end();
    });
    zongji.on('binlog', () => test.fail('no events expected'));

    zongji.start({
      serverId: testDb.serverId(),
      gtidSet: '0-1-1234',
    });
  });
});

// Tagged GTIDs (MySQL 8.3+, GTID_NEXT='AUTOMATIC:tag'): transactions
// arrive as GTID_TAGGED_LOG_EVENT (code 42), gtid_executed grows a
// ':tag:intervals' section, and - permanently, surviving RESET - the
// server switches Previous_gtids to the tagged set encoding. All of
// zongji's GTID surfaces must keep working: event decode, event.gtid
// attribution, gtidSet tracking/seeding, and resume via
// COM_BINLOG_DUMP_GTID with a tagged payload.
tap.test('tagged GTIDs decode, seed and resume',
  { skip: NO_TAGGED_GTIDS }, test => {
  const TAGGED_TABLE = 'gtid_tagged_test';

  const first = new ZongJi(settings.connection);
  test.teardown(() => first.stop());
  first.on('error', err => test.fail(err));

  const gtids = [];
  const rowGtids = [];
  first.on('binlog', event => {
    if (event.getTypeName() === 'Gtid') {
      gtids.push(event);
    } else if (event.getTypeName() === 'WriteRows') {
      rowGtids.push(event.gtid);
    }
  });

  testDb.ensureGtidMode(() => testDb.execute([
    `DROP TABLE IF EXISTS ${TAGGED_TABLE}`,
    `CREATE TABLE ${TAGGED_TABLE} (col INT UNSIGNED)`,
  ], err => {
    if (err) {
      return test.fail(err);
    }

    first.start({
      startAtEnd: true,
      serverId: testDb.serverId(),
      includeEvents: ['gtid', 'tablemap', 'writerows'],
    });

    first.on('ready', () => {
      testDb.execute([
        "SET SESSION gtid_next = 'AUTOMATIC:ztag'",
        `INSERT INTO ${TAGGED_TABLE} (col) VALUES (1)`,
        "SET SESSION gtid_next = 'AUTOMATIC'",
        `INSERT INTO ${TAGGED_TABLE} (col) VALUES (2)`,
      ], insertErr => {
        if (insertErr) {
          return test.fail(insertErr);
        }
        setTimeout(() => {
          test.equal(gtids.length, 2);
          const [tagged, untagged] = gtids;
          test.equal(tagged.tag, 'ztag',
            'GTID_TAGGED_LOG_EVENT decodes with its tag');
          test.match(tagged.gtid, /^[0-9a-f-]{36}:ztag:\d+$/,
            'tagged gtid text is uuid:tag:gno');
          test.equal(untagged.tag, undefined,
            'classic GTID events are unchanged');
          test.equal(rowGtids[0], tagged.gtid,
            'row events carry the tagged transaction gtid');
          test.equal(rowGtids[1], untagged.gtid);
          test.match(first.gtidSet, /:ztag:/,
            'the executed set tracks the tagged transaction');

          const checkpoint = first.gtidSet;
          first.stop();
          // One more of each flavour while nothing listens
          testDb.execute([
            "SET SESSION gtid_next = 'AUTOMATIC:ztag'",
            `INSERT INTO ${TAGGED_TABLE} (col) VALUES (3)`,
            "SET SESSION gtid_next = 'AUTOMATIC'",
            `INSERT INTO ${TAGGED_TABLE} (col) VALUES (4)`,
          ], gapErr => {
            if (gapErr) {
              return test.fail(gapErr);
            }
            resumeAndVerify(checkpoint);
          });
        }, 1000);
      });
    });
  }));

  // Resuming with a tagged checkpoint sends the tagged
  // COM_BINLOG_DUMP_GTID payload; the server must skip transactions
  // 1 and 2 itself and deliver only 3 and 4
  const resumeAndVerify = (checkpoint) => {
    const second = new ZongJi(settings.connection);
    test.teardown(() => second.stop());
    second.on('error', err => test.fail(err));

    const resumedRows = [];
    second.on('binlog', event => {
      if (event.getTypeName() === 'WriteRows') {
        resumedRows.push(event.rows[0].col);
      }
    });

    second.start({
      gtidSet: checkpoint,
      serverId: testDb.serverId(),
      includeEvents: ['tablemap', 'writerows'],
    });

    second.on('ready', () => {
      setTimeout(() => {
        test.strictSame(resumedRows, [3, 4],
          'the tagged checkpoint resumes past both flavours');
        test.match(second.gtidSet, /:ztag:/,
          'the resumed set keeps the tagged transactions');

        // A fresh startAtEnd instance must seed from a gtid_executed
        // that now contains tags (this crashed before tagged support)
        const third = new ZongJi(settings.connection);
        test.teardown(() => third.stop());
        third.on('error', err => test.fail(err));
        third.start({
          startAtEnd: true,
          serverId: testDb.serverId(),
          includeEvents: ['tablemap', 'writerows'],
        });
        third.on('ready', () => {
          test.match(third.gtidSet, /:ztag:/,
            'startAtEnd seeds from a tagged gtid_executed');
          test.end();
        });
      }, 1500);
    });
  };
});
