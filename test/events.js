import tap from 'tap';
import mysql from 'mysql2';

import ZongJi from '../index.js';
import expectEvents from './helpers/expectEvents.js';
import * as testDb from './helpers/index.js';
import settings from './settings/mysql.js';

const checkTableMatches = function(tableName) {
  return function(test, event) {
    const tableDetails = event.tableMap[event.tableId];
    test.equal(tableDetails.parentSchema, testDb.SCHEMA_NAME);
    test.equal(tableDetails.tableName, tableName);
  };
};

// For use with expectEvents()
const tableMapEvent = function(tableName) {
  return {
    _type: 'TableMap',
    tableName: tableName,
    schemaName: testDb.SCHEMA_NAME,
  };
};

tap.test('Initialise testing db', async test => {
  try {
    await testDb.initAsync();
    test.pass('database initialized');
  } catch (err) {
    test.fail(err);
  }
});

tap.test('Binlog option startAtEnd', test => {
  const TEST_TABLE = 'start_at_end_test';

  test.test(`prepare new table ${TEST_TABLE}`, test => {
    testDb.execute([
      'FLUSH LOGS', // Ensure ZongJi perseveres through a rotation event
      `DROP TABLE IF EXISTS ${TEST_TABLE}`,
      `CREATE TABLE ${TEST_TABLE} (col INT UNSIGNED)`,
      `INSERT INTO ${TEST_TABLE} (col) VALUES (12)`,
    ], err => {
      if (err) {
        return test.fail(err);
      }
      test.end();
    });
  });

  test.test('start', test => {
    const events = [];

    const zongji = new ZongJi(settings.connection);
    test.teardown(() => zongji.stop());

    zongji.on('binlog', evt => events.push(evt));
    zongji.start({
      startAtEnd: true,
      includeEvents: ['tablemap', 'writerows'],
    });

    zongji.on('ready', () => {
      testDb.execute([
        `INSERT INTO ${TEST_TABLE} (col) VALUES (9)`,
      ], err => {
        if (err) {
          return test.fail(err);
        }

        // Should only have 2 events since ZongJi start
        expectEvents(test, events,
          [
            { /* do not bother testing anything on first event */ },
            { rows: [ { col: 9 } ] }
          ], 1,
          () => test.end()
        );
      });
    });


  });

  test.end();
});

tap.test('Class constructor', test => {
  const TEST_TABLE = 'conn_obj_test';

  test.test(`prepare table ${TEST_TABLE}`, test => {
    testDb.execute([
      `DROP TABLE IF EXISTS ${TEST_TABLE}`,
      `CREATE TABLE ${TEST_TABLE} (col INT UNSIGNED)`,
      `INSERT INTO ${TEST_TABLE} (col) VALUES (10)`,
    ], err => {
      if (err) {
        return test.fail(err);
      }

      test.end();
    });
  });

  function run(test, zongji) {
    test.teardown(() => zongji.stop());

    const events = [];
    zongji.on('binlog', evt => events.push(evt));
    zongji.start({
      startAtEnd: true,
      serverId: testDb.serverId(),
      includeEvents: ['tablemap', 'writerows'],
    });
    zongji.on('ready', () => {
      let value = Math.round(Math.random() *  100);
      testDb.execute([
          `INSERT INTO ${TEST_TABLE} (col) VALUES (${value})`,
        ], err => {
          if (err) {
            return test.fail(err);
          }
          // Should only have 2 events since ZongJi start

          expectEvents(test, events, [
            { /* do not bother testing anything on first event */ },
            { rows: [ { col: value } ] }
          ], 1, () => test.end());
        });
    });
  }

  test.test('pass a mysql connection instance', test => {
    const conn = mysql.createConnection(settings.connection);
    const zongji = new ZongJi(conn);
    zongji.on('stopped', () => conn.destroy());
    run(test, zongji);
  });

  test.test('pass a mysql pool', test => {
    const pool = mysql.createPool(settings.connection);
    const zongji = new ZongJi(pool);
    zongji.on('stopped', () => pool.end());
    run(test, zongji);
  });

  test.end();
});

tap.test('Write events', test => {
  const TEST_TABLE = 'write_events_test';

  test.test(`prepare table ${TEST_TABLE}`, test => {
    testDb.execute([
      `DROP TABLE IF EXISTS ${TEST_TABLE}`,
      `CREATE TABLE ${TEST_TABLE} (col INT UNSIGNED)`,
    ], err => {
      if (err) {
        return test.fail(err);
      }

      test.end();
    });
  });

  test.test('write a record', test => {
    const events = [];
    const zongji = new ZongJi(settings.connection);
    test.teardown(() => zongji.stop());

    zongji.start({
      startAtEnd: true,
      serverId: testDb.serverId(),
      includeEvents: ['tablemap', 'writerows'],
    });

    zongji.on('ready', () => {
      testDb.execute([
        `INSERT INTO ${TEST_TABLE} (col) VALUES (14)`,
      ], err => {
        if (err) {
          return test.fail(err);
        }
      });
    });

    zongji.on('binlog', evt => {
      events.push(evt);

      if (events.length == 2) {
        expectEvents(test, events,
          [
            tableMapEvent(TEST_TABLE),
            {
              _type: 'WriteRows',
              _checkTableMap: checkTableMatches(TEST_TABLE),
              rows: [ { col: 14 } ],
            }
          ], 1,
          () => test.end()
        );
      }
    });
  });

  test.test('update a record', test => {
    const events = [];
    const zongji = new ZongJi(settings.connection);
    test.teardown(() => zongji.stop());

    zongji.start({
      startAtEnd: true,
      serverId: testDb.serverId(),
      includeEvents: ['tablemap', 'updaterows'],
    });

    zongji.on('ready', () => {
      testDb.execute([
        `UPDATE ${TEST_TABLE} SET col=15`,
      ], err => {
        if (err) {
          return test.fail(err);
        }
      });
    });

    zongji.on('binlog', evt => {
      events.push(evt);

      if (events.length == 2) {
        expectEvents(test, events,
          [
            tableMapEvent(TEST_TABLE),
            {
              _type: 'UpdateRows',
              _checkTableMap: checkTableMatches(TEST_TABLE),
              rows: [ { before: { col: 14 }, after: { col: 15 } } ],
            }
          ], 1,
          () => test.end()
        );
      }
    });
  });

  test.test('delete a record', test => {
    const events = [];
    const zongji = new ZongJi(settings.connection);
    test.teardown(() => zongji.stop());

    zongji.start({
      startAtEnd: true,
      serverId: testDb.serverId(),
      includeEvents: ['tablemap', 'deleterows'],
    });

    zongji.on('ready', () => {
      testDb.execute([
        `DELETE FROM ${TEST_TABLE}`,
      ], err => {
        if (err) {
          return test.fail(err);
        }
      });
    });

    zongji.on('binlog', evt => {
      events.push(evt);

      if (events.length == 2) {
        expectEvents(test, events,
          [
            tableMapEvent(TEST_TABLE),
            {
              _type: 'DeleteRows',
              _checkTableMap: checkTableMatches(TEST_TABLE),
              rows: [ { col: 15 } ],
            }
          ], 1,
          () => test.end()
        );
      }
    });
  });

  test.end();
});

tap.test('Intvar / Query event', test => {
  const TEST_TABLE = 'intvar_test';

  test.test(`prepare table ${TEST_TABLE}`, test => {
    testDb.execute([
      `DROP TABLE IF EXISTS ${TEST_TABLE}`,
      `CREATE TABLE ${TEST_TABLE} (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, col INT)`,
    ], err => {
      if (err) {
        return test.fail(err);
      }

      test.end();
    });
  });

  test.test('begin', test => {
    const events = [];
    const zongji = new ZongJi(settings.connection);
    test.teardown(() => zongji.stop());

    zongji.on('binlog', event => {
      if (event.getTypeName() === 'Query' && event.query === 'BEGIN') {
        return;
      }
      events.push(event);

      if (events.length === 6) {
        expectEvents(test, events, [
            { _type: 'IntVar', type: 2, value: 1 },
            { _type: 'Query' },
            { _type: 'IntVar', type: 2, value: 2 },
            { _type: 'Query' },
            { _type: 'IntVar', type: 1, value: 2 },
            { _type: 'Query' },
          ], 1, () => test.end()
        );
      }
    });

    zongji.start({
      startAtEnd: true,
      serverId: testDb.serverId(),
      includeEvents: ['intvar', 'query'],
    });

    zongji.on('ready', () => {
      testDb.execute([
        'SET SESSION binlog_format=STATEMENT',
        `INSERT INTO ${TEST_TABLE} (col) VALUES (10)`,
        `INSERT INTO ${TEST_TABLE} (col) VALUES (11)`,
        `INSERT INTO ${TEST_TABLE} (id, col) VALUES (100, LAST_INSERT_ID())`,
        // Other tests expect row-based replication, so reset here
        'SET SESSION binlog_format=ROW',
      ], err => {
        if (err) {
          test.fail(err);
        }
      });
    });

  });

  test.end();
});

tap.test('With many columns', test => {
  const TEST_TABLE = '33_columns';
  const events = [];

  const zongji = new ZongJi(settings.connection);

  test.teardown(() => zongji.stop());
  zongji.on('binlog', evt => events.push(evt));
  zongji.start({
    startAtEnd: true,
    serverId: testDb.serverId(),
    includeEvents: ['tablemap', 'writerows'],
  });

  zongji.on('ready', () => {
    testDb.execute([
      `DROP TABLE IF EXISTS ${TEST_TABLE}`,
      `CREATE TABLE ${TEST_TABLE} (
        col1 INT SIGNED NULL, col2 BIGINT SIGNED NULL,
        col3 TINYINT SIGNED NULL, col4 SMALLINT SIGNED NULL,
        col5 MEDIUMINT SIGNED NULL, col6 INT SIGNED NULL,
        col7 BIGINT SIGNED NULL, col8 TINYINT SIGNED NULL,
        col9 SMALLINT SIGNED NULL, col10 INT SIGNED NULL,
        col11 BIGINT SIGNED NULL, col12 TINYINT SIGNED NULL,
        col13 SMALLINT SIGNED NULL, col14 INT SIGNED NULL,
        col15 BIGINT SIGNED NULL, col16 TINYINT SIGNED NULL,
        col17 SMALLINT SIGNED NULL, col18 INT SIGNED NULL,
        col19 BIGINT SIGNED NULL, col20 TINYINT SIGNED NULL,
        col21 SMALLINT SIGNED NULL, col22 INT SIGNED NULL,
        col23 BIGINT SIGNED NULL, col24 TINYINT SIGNED NULL,
        col25 SMALLINT SIGNED NULL, col26 INT SIGNED NULL,
        col27 BIGINT SIGNED NULL, col28 TINYINT SIGNED NULL,
        col29 SMALLINT SIGNED NULL, col30 INT SIGNED NULL,
        col31 BIGINT SIGNED NULL, col32 TINYINT SIGNED NULL,
        col33 SMALLINT SIGNED NULL)`,
      `INSERT INTO ${TEST_TABLE} (col1, col2, col3, col4, col5, col33) VALUES
          (null, null, null, null, null, null),
          (-1, -1, -1, -1, -1, -1),
          (2147483647, 9007199254740993, 127, 32767, 8388607, 12),
          (-2147483648, -9007199254740993, -128, -32768, -8388608, 10),
          (-2147483645, -1, -126, -32766, -8388606, 6),
          (-1, 9223372036854775809, -1, -1, null, -6),
          (123456, -9223372036854775809, 96, 300, 1000, null),
          (-123456, 9223372036854775807, -96, -300, -1000, null)`,
      `SELECT * FROM ${TEST_TABLE}`,
    ], (err, result) => {
      if (err) {
        return test.fail(err);
      }

      expectEvents(test, events, [
        { _type: 'TableMap' },
        { rows: result[result.length - 1], _type: 'WriteRows' }
      ], 1, test.end);
    });
  });
});

tap.test('Rotate event on flush logs', test => {
  const zongji = new ZongJi(settings.connection);
  test.teardown(() => zongji.stop());

  let initialLogName;
  let rotateReceived = false;
  let finished = false;
  let timeoutId;

  zongji.start({
    startAtEnd: true,
    serverId: testDb.serverId(),
    includeEvents: ['rotate'],
  });

  zongji.on('binlog', event => {
    if (finished) return;
    if (event.getTypeName() !== 'Rotate') return;
    if (!initialLogName) return;
    if (event.binlogName === initialLogName) return;
    rotateReceived = true;
    test.ok(event.position > 0);
    test.ok(event.binlogName.indexOf(initialLogName) === -1);
    finished = true;
    clearTimeout(timeoutId);
    test.end();
  });

  zongji.on('ready', () => {
    testDb.execute(['SHOW BINARY LOGS'], (err, results) => {
      if (err) {
        return test.fail(err);
      }
      const rows = results[results.length - 1];
      initialLogName = rows[rows.length - 1].Log_name;
      testDb.execute(['FLUSH LOGS'], (flushErr) => {
        if (flushErr) {
          return test.fail(flushErr);
        }
        timeoutId = setTimeout(() => {
          if (!rotateReceived) {
            test.fail('Rotate event not received');
            finished = true;
            test.end();
          }
        }, 2000);
      });
    });
  });
});

tap.test('Binlog checksum enabled', test => {
  const TEST_TABLE = 'checksum_test';
  const zongji = new ZongJi(settings.connection);
  test.teardown(() => zongji.stop());

  let originalChecksum;

  const setupQueries = [
    'SELECT @@GLOBAL.binlog_checksum AS checksum',
    `DROP TABLE IF EXISTS ${TEST_TABLE}`,
    `CREATE TABLE ${TEST_TABLE} (col INT UNSIGNED)`,
  ];

  testDb.execute(setupQueries, (err, results) => {
    if (err) {
      return test.fail(err);
    }
    originalChecksum = results[0][0].checksum;
    testDb.execute(['SET GLOBAL binlog_checksum = \'CRC32\''], (setErr) => {
      if (setErr) {
        return test.fail(setErr);
      }

      zongji.start({
        startAtEnd: true,
        serverId: testDb.serverId(),
        includeEvents: ['tablemap', 'writerows'],
      });

      zongji.on('ready', () => {
        testDb.execute([
          `INSERT INTO ${TEST_TABLE} (col) VALUES (1)`,
        ], insertErr => {
          if (insertErr) {
            return test.fail(insertErr);
          }
        });
      });

      zongji.on('binlog', event => {
        if (event.getTypeName() !== 'WriteRows') {
          return;
        }
        test.same(event.rows, [{ col: 1 }]);
        testDb.execute([`SET GLOBAL binlog_checksum = '${originalChecksum}'`], (resetErr) => {
          if (resetErr) {
            return test.fail(resetErr);
          }
          test.end();
        });
      });
    });
  });
});

tap.test('GTID events', test => {
  const TEST_TABLE = 'gtid_test';
  const zongji = new ZongJi(settings.connection);
  test.teardown(() => zongji.stop());

  testDb.ensureGtidMode(() => testDb.execute([
    `DROP TABLE IF EXISTS ${TEST_TABLE}`,
    `CREATE TABLE ${TEST_TABLE} (col INT UNSIGNED)`,
  ], err => {
    if (err) {
      return test.fail(err);
    }
    {

      let seenGtid = false;
      zongji.start({
        startAtEnd: true,
        serverId: testDb.serverId(),
        includeEvents: ['gtid', 'anonymousgtid', 'previousgtids', 'tablemap', 'writerows'],
      });

      zongji.on('binlog', event => {
        if (event.getTypeName() === 'Gtid' || event.getTypeName() === 'AnonymousGtid') {
          seenGtid = true;
        }
        if (event.getTypeName() === 'WriteRows' && seenGtid) {
          test.ok(seenGtid);
          test.end();
        }
      });

      zongji.on('ready', () => {
        testDb.execute([
          `INSERT INTO ${TEST_TABLE} (col) VALUES (1)`,
        ], insertErr => {
          if (insertErr) {
            return test.fail(insertErr);
          }
        });
      });
    }
  }));
});

tap.test('Table name containing quote characters', test => {
  // Regression test: table metadata is fetched with a parameterised query,
  // so identifiers containing quotes must not break (or inject into) the
  // INFORMATION_SCHEMA lookup.
  const TEST_TABLE = 'quote\'in"name';
  const ESCAPED_TABLE = '`' + TEST_TABLE + '`';

  const zongji = new ZongJi(settings.connection);
  test.teardown(() => zongji.stop());

  const events = [];
  const errors = [];
  zongji.on('binlog', evt => events.push(evt));
  zongji.on('error', err => errors.push(err));

  testDb.execute([
    `DROP TABLE IF EXISTS ${ESCAPED_TABLE}`,
    `CREATE TABLE ${ESCAPED_TABLE} (col INT UNSIGNED)`,
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
      testDb.execute([
        `INSERT INTO ${ESCAPED_TABLE} (col) VALUES (42)`,
      ], insertErr => {
        if (insertErr) {
          return test.fail(insertErr);
        }

        expectEvents(test, events, [
          tableMapEvent(TEST_TABLE),
          {
            _type: 'WriteRows',
            _custom: checkTableMatches(TEST_TABLE),
            rows: [{ col: 42 }],
          },
        ], 1, () => {
          test.equal(errors.length, 0, 'no errors during quoted table test');
          test.end();
        });
      });
    });
  });
});

// MySQL 8.0.20+: compressed transactions arrive as TRANSACTION_PAYLOAD_EVENT,
// which zongji cannot decode. The row changes are dropped, but an error must
// be emitted (once) so the data loss is not silent.
testDb.requireVersion('8.0.20', () => {
  tap.test('Transaction compression emits unsupported-event error', test => {
    const TEST_TABLE = 'txn_compression_test';

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
        // All statements in one execute() call share a connection, so the
        // session variable applies to the inserts
        testDb.execute([
          'SET SESSION binlog_transaction_compression=ON',
          `INSERT INTO ${TEST_TABLE} (col) VALUES (1)`,
          `INSERT INTO ${TEST_TABLE} (col) VALUES (2)`,
        ], insertErr => {
          if (insertErr) {
            return test.fail(insertErr);
          }

          // Wait for the binlog events to arrive
          setTimeout(() => {
            test.equal(errors.length, 1,
              'exactly one error despite two compressed transactions');
            test.match(errors[0].message, /TRANSACTION_PAYLOAD_EVENT/);
            test.match(errors[0].message, /binlog_transaction_compression/);
            test.end();
          }, 1000);
        });
      });
    });
  });
});

// The binlog stream with connection compression patches mysql2's
// handlePacket to sync sequence IDs (MySQL resets inner packet sequence
// numbers within compressed chunks). This exercises that patch against
// the installed mysql2 version: events must arrive intact and without
// "packets out of order" warnings.
tap.test('Binlog stream with connection compression', test => {
  const TEST_TABLE = 'compression_conn_test';

  const warnings = [];
  const originalConsoleError = console.error;
  console.error = (...args) => {
    if (typeof args[0] === 'string' && args[0].includes('packets out of order')) {
      warnings.push(args[0]);
      return;
    }
    originalConsoleError(...args);
  };
  test.teardown(() => {
    console.error = originalConsoleError;
  });

  const zongji = new ZongJi({ ...settings.connection, compress: true });
  test.teardown(() => zongji.stop());

  const events = [];
  const errors = [];
  zongji.on('binlog', evt => events.push(evt));
  zongji.on('error', err => errors.push(err));

  testDb.execute([
    `DROP TABLE IF EXISTS ${TEST_TABLE}`,
    `CREATE TABLE ${TEST_TABLE} (col INT UNSIGNED, txt VARCHAR(100))`,
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
      const inserts = Array.from({ length: 5 }, (_, i) =>
        `INSERT INTO ${TEST_TABLE} (col, txt) VALUES (${i}, REPEAT('x', 100))`);
      testDb.execute(inserts, insertErr => {
        if (insertErr) {
          return test.fail(insertErr);
        }
        expectEvents(test, events, [
          tableMapEvent(TEST_TABLE),
          { _type: 'WriteRows' },
        ], 5, () => {
          test.equal(errors.length, 0, 'no errors over compressed stream');
          test.equal(warnings.length, 0, 'no sequence ID warnings');
          const values = events
            .filter(e => e.getTypeName() === 'WriteRows')
            .map(e => e.rows[0].col);
          test.strictSame(values, [0, 1, 2, 3, 4]);
          test.end();
        });
      });
    });
  });
});

// event.gtid: row events carry the GTID of their transaction even when
// 'gtid' events are excluded from includeEvents. Runs with gtid_mode=ON
// (enabled here if necessary, as in the GTID events test above).
tap.test('event.gtid attached to row events', test => {
  const TEST_TABLE = 'event_gtid_test';
  const GTID_REGEX = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}:\d+$/;

  const zongji = new ZongJi(settings.connection);
  test.teardown(() => zongji.stop());

  const events = [];
  zongji.on('binlog', evt => events.push(evt));
  zongji.on('error', err => test.fail(err));

  testDb.ensureGtidMode(() => testDb.execute([
    `DROP TABLE IF EXISTS ${TEST_TABLE}`,
    `CREATE TABLE ${TEST_TABLE} (col INT UNSIGNED)`,
  ], err => {
    if (err) {
      return test.fail(err);
    }
    {
      zongji.start({
        startAtEnd: true,
        serverId: testDb.serverId(),
        // 'gtid' deliberately NOT included: tracking must still work
        includeEvents: ['tablemap', 'writerows'],
      });

      zongji.on('ready', () => {
        // Two separate statements = two transactions = two GTIDs
        testDb.execute([
          `INSERT INTO ${TEST_TABLE} (col) VALUES (1)`,
          `INSERT INTO ${TEST_TABLE} (col) VALUES (2)`,
        ], insertErr => {
          if (insertErr) {
            return test.fail(insertErr);
          }
          expectEvents(test, events, [
            tableMapEvent(TEST_TABLE),
            { _type: 'WriteRows' },
          ], 2, () => {
            const [tm1, wr1, tm2, wr2] = events;
            for (const evt of events) {
              test.match(evt.gtid, GTID_REGEX,
                `${evt.getTypeName()} carries a GTID`);
            }
            test.equal(tm1.gtid, wr1.gtid,
              'tablemap and rows of one transaction share a GTID');
            test.equal(tm2.gtid, wr2.gtid);
            test.not(wr1.gtid, wr2.gtid,
              'separate transactions have distinct GTIDs');
            test.end();
          });
        });
      });
    }
  }));
});

// Regression: filters passed to a start() issued while a previous start()
// is still initialising must be applied, not silently dropped. Consumers
// (e.g. mysql-live-select) register tables between start() and 'ready'
// and re-call start() to apply them, the documented way to update
// filters since they became snapshotted.
tap.test('start() during initialisation applies new filters', test => {
  const TABLE_A = 'init_filter_a';
  const TABLE_B = 'init_filter_b';

  const zongji = new ZongJi(settings.connection);
  test.teardown(() => zongji.stop());
  zongji.on('error', err => test.fail(err));

  const rowTables = [];
  zongji.on('binlog', evt => {
    if (evt.getTypeName() === 'WriteRows') {
      rowTables.push(evt.tableMap[evt.tableId].tableName);
    }
  });

  testDb.execute([
    `DROP TABLE IF EXISTS ${TABLE_A}`,
    `DROP TABLE IF EXISTS ${TABLE_B}`,
    `CREATE TABLE ${TABLE_A} (col INT UNSIGNED)`,
    `CREATE TABLE ${TABLE_B} (col INT UNSIGNED)`,
  ], err => {
    if (err) {
      return test.fail(err);
    }

    const firstServerId = testDb.serverId();
    zongji.start({
      startAtEnd: true,
      serverId: firstServerId,
      includeEvents: ['tablemap', 'writerows'],
      includeSchema: { [testDb.SCHEMA_NAME]: [TABLE_A] },
    });

    // Still initialising: this must update the filters (to table B only)
    // without clobbering the first call's stream options
    zongji.start({
      serverId: testDb.serverId(),
      includeEvents: ['tablemap', 'writerows'],
      includeSchema: { [testDb.SCHEMA_NAME]: [TABLE_B] },
    });

    zongji.on('ready', () => {
      test.equal(zongji.options.serverId, firstServerId,
        'stream options from the first start() are preserved');

      testDb.execute([
        `INSERT INTO ${TABLE_A} (col) VALUES (1)`,
        `INSERT INTO ${TABLE_B} (col) VALUES (2)`,
      ], insertErr => {
        if (insertErr) {
          return test.fail(insertErr);
        }
        setTimeout(() => {
          test.strictSame(rowTables, [TABLE_B],
            'only the second start() call\'s filters are in effect');
          test.end();
        }, 1000);
      });
    });
  });
});

// Regression: options.position must never advance past a TableMap event.
// A consumer persisting options.position for resume-on-reconnect could
// otherwise land between a TableMap and its row events; the resumed
// instance then has no metadata for the tableId and silently drops the
// rows. Holding position back replays the TableMap first (at-least-once
// delivery of the rows that followed it).
tap.test('resume position never lands after a TableMap event', test => {
  const TEST_TABLE = 'tablemap_position_test';

  const zongji = new ZongJi(settings.connection);
  test.teardown(() => zongji.stop());
  zongji.on('error', err => test.fail(err));

  let tableMapCount = 0;
  let snapshot = null;
  const rows = [];
  zongji.on('binlog', evt => {
    const type = evt.getTypeName();
    if (type === 'TableMap' && evt.tableName === TEST_TABLE) {
      tableMapCount++;
      // MariaDB writes end_log_pos=0 on events inside a transaction, so
      // the held-back position can only be compared where the event
      // carries a real end position (MySQL always does)
      if (evt.nextPosition > 0) {
        test.ok(zongji.options.position < evt.nextPosition,
          'position held back at TableMap #' + tableMapCount);
      }
      if (tableMapCount === 2) {
        // The second TableMap goes through the cached-metadata path,
        // which used to advance the position past itself
        snapshot = {
          filename: zongji.options.filename,
          position: zongji.options.position,
        };
      }
    }
    if (type === 'WriteRows') {
      rows.push(evt.rows[0].col);
    }
  });

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
      testDb.execute([
        `INSERT INTO ${TEST_TABLE} (col) VALUES (1)`,
        `INSERT INTO ${TEST_TABLE} (col) VALUES (2)`,
      ], insertErr => {
        if (insertErr) {
          return test.fail(insertErr);
        }
        setTimeout(() => {
          test.strictSame(rows, [1, 2]);
          test.ok(snapshot, 'captured resume point at the second TableMap');
          zongji.stop();

          // Resume a fresh instance (empty tableMap cache) at the
          // persisted point: the row events must still be delivered
          const resumed = new ZongJi(settings.connection);
          test.teardown(() => resumed.stop());
          resumed.on('error', resumeErr => test.fail(resumeErr));

          const resumedRows = [];
          resumed.on('binlog', evt => {
            if (evt.getTypeName() === 'WriteRows' &&
                evt.tableMap[evt.tableId].tableName === TEST_TABLE) {
              resumedRows.push(evt.rows[0].col);
            }
          });

          resumed.start({
            filename: snapshot.filename,
            position: snapshot.position,
            serverId: testDb.serverId(),
            includeEvents: ['tablemap', 'writerows'],
          });

          resumed.on('ready', () => {
            setTimeout(() => {
              test.ok(resumedRows.includes(2),
                'row following the TableMap is delivered after resume, ' +
                'not silently dropped');
              test.end();
            }, 1000);
          });
        }, 1000);
      });
    });
  });
});

// Regression: a rotate event's payload position (start of the NEW file)
// is the only value coherent with its binlogName. Using the header
// nextPosition (an OLD-file offset; 0 for the artificial rotate at dump
// start) left options as a corrupt (new file, old offset) resume pair.
tap.test('rotate events keep filename and position coherent', test => {
  const TEST_TABLE = 'rotate_position_test';

  const zongji = new ZongJi(settings.connection);
  test.teardown(() => zongji.stop());
  zongji.on('error', err => test.fail(err));

  let sawRealRotate = false;
  zongji.on('binlog', evt => {
    if (evt.getTypeName() !== 'Rotate') {
      return;
    }
    test.equal(zongji.options.filename, evt.binlogName,
      'filename follows the rotate');
    test.equal(zongji.options.position, evt.position,
      'position is the rotate payload position, not the header value');
    test.ok(zongji.options.position > 0,
      'artificial rotate at dump start must not zero the position');
    if (evt.timestamp !== 0) {
      // Real rotation from FLUSH LOGS: new file starts at 4
      sawRealRotate = true;
      test.equal(evt.position, 4);
    }
  });

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
      includeEvents: ['rotate', 'tablemap', 'writerows'],
    });

    zongji.on('ready', () => {
      testDb.execute(['FLUSH LOGS'], flushErr => {
        if (flushErr) {
          return test.fail(flushErr);
        }
        setTimeout(() => {
          test.ok(sawRealRotate, 'real rotate observed');
          const resumePoint = {
            filename: zongji.options.filename,
            position: zongji.options.position,
          };
          // The rotate itself sets position 4; the new file's filtered
          // header events (format description, Previous_gtids) may then
          // advance it within the header region, which is equally
          // coherent. What must never appear is 0 (artificial-rotate bug)
          // or an old-file offset beyond the new file's header (the
          // corrupt pair this test regression-guards); the resume below
          // proves the pair is actually usable.
          test.ok(resumePoint.position >= 4 && resumePoint.position < 1000,
            'resume pair points into the start of the new file ' +
            `(position ${resumePoint.position})`);

          // Events written after the rotation must be reachable from the
          // persisted pair
          testDb.execute([
            `INSERT INTO ${TEST_TABLE} (col) VALUES (7)`,
          ], insertErr => {
            if (insertErr) {
              return test.fail(insertErr);
            }
            zongji.stop();

            const resumed = new ZongJi(settings.connection);
            test.teardown(() => resumed.stop());
            resumed.on('error', resumeErr => test.fail(resumeErr));

            const resumedRows = [];
            resumed.on('binlog', evt => {
              if (evt.getTypeName() === 'WriteRows' &&
                  evt.tableMap[evt.tableId].tableName === TEST_TABLE) {
                resumedRows.push(evt.rows[0].col);
              }
            });

            resumed.start({
              filename: resumePoint.filename,
              position: resumePoint.position,
              serverId: testDb.serverId(),
              includeEvents: ['tablemap', 'writerows'],
            });

            resumed.on('ready', () => {
              setTimeout(() => {
                test.strictSame(resumedRows, [7],
                  'stream resumes cleanly from the persisted pair');
                test.end();
              }, 1000);
            });
          });
        }, 1000);
      });
    });
  });
});

// Regression: events filtered out by includeEvents must still advance the
// resume position (packet layer). With only 'tablemap' included, no
// delivered event carries a usable position (TableMap is deliberately held
// back), so freshness must come from the filtered events. On MariaDB this
// is acute for any filter set excluding 'query'/'xid': events inside a
// transaction carry end_log_pos=0, so only the filtered commit knows the
// real position.
tap.test('filtered events keep the resume position fresh', test => {
  const TEST_TABLE = 'filtered_position_test';

  const zongji = new ZongJi(settings.connection);
  test.teardown(() => zongji.stop());
  zongji.on('error', err => test.fail(err));

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
      includeEvents: ['tablemap'],
    });

    zongji.on('ready', () => {
      const startPosition = zongji.options.position;
      testDb.execute([
        `INSERT INTO ${TEST_TABLE} (col) VALUES (1)`,
      ], insertErr => {
        if (insertErr) {
          return test.fail(insertErr);
        }
        setTimeout(() => {
          test.ok(zongji.options.position > startPosition,
            'position advanced past the start point ' +
            `(${zongji.options.position} > ${startPosition})`);
          test.end();
        }, 1000);
      });
    });
  });
});
