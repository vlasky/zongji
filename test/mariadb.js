// MariaDB-specific behaviour: native GTID/checkpoint/GTID-list events
// (available because zongji announces @mariadb_slave_capability=4) and the
// interim rejection of MySQL-style GTID resume. The whole file no-ops
// against a MySQL server.
import tap from 'tap';

import ZongJi from '../index.js';
import * as testDb from './helpers/index.js';
import settings from './settings/mysql.js';

testDb.requireMariaDb(() => {
  tap.test('Initialise testing db', async test => {
    try {
      await testDb.initAsync();
      test.pass('database initialized');
    } catch (err) {
      test.fail(err);
    }
  });

  tap.test('native MariaDB GTID events', test => {
    const TEST_TABLE = 'mariadb_gtid_test';

    const zongji = new ZongJi(settings.connection);
    test.teardown(() => zongji.stop());
    zongji.on('error', err => test.fail(err));

    const gtidEvents = [];
    const rowGtids = [];
    let sawXid = false;
    zongji.on('binlog', evt => {
      const type = evt.getTypeName();
      if (type === 'MariadbGtid') {
        gtidEvents.push(evt);
      }
      if (type === 'WriteRows') {
        rowGtids.push(evt.gtid);
      }
      if (type === 'Xid') {
        sawXid = true;
      }
    });

    testDb.execute([
      `DROP TABLE IF EXISTS ${TEST_TABLE}`,
    ], err => {
      if (err) {
        return test.fail(err);
      }

      zongji.start({
        startAtEnd: true,
        serverId: testDb.serverId(),
        includeEvents:
          ['mariadbgtid', 'xid', 'tablemap', 'writerows'],
      });

      zongji.on('ready', () => {
        test.equal(zongji.isMariaDb, true, 'flavour detected');
        testDb.execute([
          // Standalone group (DDL)
          `CREATE TABLE ${TEST_TABLE} (col INT UNSIGNED)`,
          // Transactional group
          `INSERT INTO ${TEST_TABLE} (col) VALUES (23)`,
        ], insertErr => {
          if (insertErr) {
            return test.fail(insertErr);
          }
          setTimeout(() => {
            test.equal(gtidEvents.length, 2,
              'one GTID event per event group');

            const [ddl, txn] = gtidEvents;
            test.match(ddl.gtid, /^\d+-\d+-\d+$/,
              'domain-server-sequence form');
            test.equal(ddl.standalone, true, 'DDL group is standalone');
            test.equal(ddl.isDdl, true, 'DDL flag set');

            test.equal(txn.standalone, false,
              'transaction GTID replaces BEGIN');
            test.equal(txn.domainId, ddl.domainId, 'same domain');
            test.equal(txn.serverId, ddl.serverId, 'same server');
            test.ok(BigInt(String(txn.seqNo)) > BigInt(String(ddl.seqNo)),
              'sequence number advances');

            test.ok(sawXid, 'transaction still terminated by Xid');
            test.strictSame(rowGtids, [txn.gtid],
              'row events carry the MariaDB GTID of their transaction');
            test.end();
          }, 1000);
        });
      });
    });
  });

  tap.test('GTID list and binlog checkpoint at file start', test => {
    const zongji = new ZongJi(settings.connection);
    test.teardown(() => zongji.stop());
    zongji.on('error', err => test.fail(err));

    const events = [];
    zongji.on('binlog', evt => events.push(evt));

    // No filename: dump starts from the first available binlog file,
    // whose content begins with a GTID list then a binlog checkpoint
    zongji.start({
      serverId: testDb.serverId(),
      includeEvents: ['mariadbgtidlist', 'binlogcheckpoint'],
    });

    zongji.on('ready', () => {
      setTimeout(() => {
        const list = events.find(
          evt => evt.getTypeName() === 'MariadbGtidList');
        test.ok(list, 'GTID list event received');
        test.equal(list.count, list.gtids.length,
          'entry count matches parsed entries');
        for (const entry of list.gtids) {
          test.match(entry.gtid, /^\d+-\d+-\d+$/);
        }

        const checkpoint = events.find(
          evt => evt.getTypeName() === 'BinlogCheckpoint');
        test.ok(checkpoint, 'binlog checkpoint event received');
        test.match(checkpoint.binlogName, /^mysql-bin\.\d+$/,
          'checkpoint names a binlog file');
        test.end();
      }, 1500);
    });
  });

  tap.test('MariaDB data types decode to match query results', test => {
    const TEST_TABLE = 'mariadb_types_test';

    const zongji = new ZongJi(settings.connection);
    test.teardown(() => zongji.stop());
    zongji.on('error', err => test.fail(err));

    const rows = [];
    zongji.on('binlog', evt => {
      if (evt.getTypeName() === 'WriteRows' &&
          evt.tableMap[evt.tableId].tableName === TEST_TABLE) {
        rows.push(...evt.rows);
      }
    });

    testDb.execute([
      `DROP TABLE IF EXISTS ${TEST_TABLE}`,
      `CREATE TABLE ${TEST_TABLE} (
        id INT AUTO_INCREMENT PRIMARY KEY,
        u UUID,
        i4 INET4,
        i6 INET6,
        v VECTOR(3),
        j JSON,
        vc VARCHAR(500) COMPRESSED,
        vb VARBINARY(500) COMPRESSED,
        txt TEXT COMPRESSED,
        txt_latin1 TEXT COMPRESSED CHARACTER SET latin1,
        b BLOB COMPRESSED
      )`,
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
          // Long repeated values compress (zlib envelope); short ones are
          // stored uncompressed inside the envelope (method 0)
          `INSERT INTO ${TEST_TABLE}
            (u, i4, i6, v, j, vc, vb, txt, txt_latin1, b) VALUES
            ('11111111-2222-3333-4444-555555555555', '192.168.1.10',
             '2001:db8::1', VEC_FromText('[1.5,2.5,3.5]'),
             '{"a": 1, "b": [true, null]}',
             REPEAT('compressme-', 30), REPEAT('bin', 40),
             REPEAT('texty-', 50), 'caf\xE9 latin one', 'short'),
            (UUID(), '10.0.0.1', '::ffff:8.8.8.8', VEC_FromText('[0,0,1]'),
             '[1,2,3]', 'tiny', X'00FF00', 'small', 'sm\xE5ll', REPEAT('z', 900))`,
          `INSERT INTO ${TEST_TABLE} (i6) VALUES
            ('::8.8.8.8'), ('::1'), ('::'), ('1:0:0:2:0:0:0:3'),
            ('fe80::1:2:3:4')`,
        ], insertErr => {
          if (insertErr) {
            return test.fail(insertErr);
          }
          // The server's own text forms are the reference
          testDb.execute([
            `SELECT * FROM ${TEST_TABLE} ORDER BY id`,
          ], (selectErr, results) => {
            if (selectErr) {
              return test.fail(selectErr);
            }
            const expected = results[results.length - 1];
            setTimeout(() => {
              test.equal(rows.length, expected.length,
                'every inserted row decoded');
              for (let i = 0; i < expected.length; i++) {
                test.strictSame(rows[i], { ...expected[i] },
                  `row ${i + 1} matches the mysql2 query result`);
              }
              test.end();
            }, 1000);
          });
        });
      });
    });
  });

  tap.test('FULL row metadata pairs charsets across COMPRESSED columns', test => {
    const TEST_TABLE = 'mariadb_full_comp_test';

    const zongji = new ZongJi(settings.connection);
    test.teardown(() => zongji.stop());
    test.teardown(() => new Promise(resolve => testDb.execute(
      ['SET GLOBAL binlog_row_metadata = NO_LOG'], () => resolve())));
    zongji.on('error', err => test.fail(err));

    const rows = [];
    let sawSelfDescribing = false;
    zongji.on('binlog', evt => {
      const type = evt.getTypeName();
      if (type === 'TableMap' && evt.tableName === TEST_TABLE &&
          evt.hasSelfDescribingMetadata()) {
        sawSelfDescribing = true;
      }
      if (type === 'WriteRows' &&
          evt.tableMap[evt.tableId].tableName === TEST_TABLE) {
        rows.push(...evt.rows);
      }
    });

    testDb.execute([
      'SET GLOBAL binlog_row_metadata = FULL',
      `DROP TABLE IF EXISTS ${TEST_TABLE}`,
      // The COMPRESSED latin1 columns must participate in the charset
      // list indexing, or the trailing utf8mb4 column's charset would be
      // paired onto the wrong column
      `CREATE TABLE ${TEST_TABLE} (
        vc VARCHAR(100) COMPRESSED CHARACTER SET latin1,
        txt TEXT COMPRESSED CHARACTER SET latin1,
        vb VARBINARY(100) COMPRESSED,
        name VARCHAR(20)
      )`,
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
          `INSERT INTO ${TEST_TABLE} VALUES
            ('caf\xE9', REPEAT('caf\xE9-', 40), REPEAT('b', 60), 'plain')`,
        ], insertErr => {
          if (insertErr) {
            return test.fail(insertErr);
          }
          testDb.execute([
            `SELECT * FROM ${TEST_TABLE}`,
          ], (selectErr, results) => {
            if (selectErr) {
              return test.fail(selectErr);
            }
            const expected = results[results.length - 1];
            setTimeout(() => {
              test.ok(sawSelfDescribing,
                'TableMap carried FULL self-describing metadata');
              test.equal(rows.length, 1);
              test.strictSame(rows[0], { ...expected[0] },
                'row decoded from binlog metadata alone matches the ' +
                'mysql2 query result');
              test.end();
            }, 1000);
          });
        });
      });
    });
  });

  tap.test('resume from a persisted GTID position delivers only new transactions', test => {
    const TEST_TABLE = 'mariadb_resume_test';

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

      // startAtEnd seeds the position from @@GLOBAL.gtid_current_pos
      zongji.start({
        startAtEnd: true,
        serverId: testDb.serverId(),
        includeEvents: ['tablemap', 'writerows'],
      });

      zongji.on('ready', () => {
        test.ok(zongji.gtidSet !== undefined,
          'startAtEnd seeds gtidSet on MariaDB');
        testDb.execute([
          `INSERT INTO ${TEST_TABLE} (col) VALUES (1)`,
          `INSERT INTO ${TEST_TABLE} (col) VALUES (2)`,
        ], insertErr => {
          if (insertErr) {
            return test.fail(insertErr);
          }
          setTimeout(() => {
            const checkpoint = zongji.gtidSet;
            test.match(checkpoint, /^\d+-\d+-\d+(,\d+-\d+-\d+)*$/,
              'checkpoint is a MariaDB GTID position');
            zongji.stop();

            testDb.execute([
              `INSERT INTO ${TEST_TABLE} (col) VALUES (3)`,
              `INSERT INTO ${TEST_TABLE} (col) VALUES (4)`,
            ], moreErr => {
              if (moreErr) {
                return test.fail(moreErr);
              }

              const resumed = new ZongJi(settings.connection);
              test.teardown(() => resumed.stop());
              resumed.on('error', resumeErr => test.fail(resumeErr));

              const rows = [];
              resumed.on('binlog', evt => {
                if (evt.getTypeName() === 'WriteRows' &&
                    evt.tableMap[evt.tableId].tableName === TEST_TABLE) {
                  rows.push(evt.rows[0].col);
                }
              });

              resumed.start({
                gtidSet: checkpoint,
                serverId: testDb.serverId(),
                includeEvents: ['tablemap', 'writerows'],
              });

              resumed.on('ready', () => {
                setTimeout(() => {
                  test.strictSame(rows, [3, 4],
                    'transactions up to the checkpoint are skipped ' +
                    'server-side');
                  test.ok(resumed.gtidSet !== undefined &&
                      resumed.gtidSet !== checkpoint,
                    'resumed position extends past the checkpoint');
                  test.end();
                }, 1500);
              });
            });
          }, 1000);
        });
      });
    });
  });

  tap.test('empty GTID position replays the full available history', test => {
    const TEST_TABLE = 'mariadb_empty_pos_test';

    const zongji = new ZongJi(settings.connection);
    test.teardown(() => zongji.stop());
    zongji.on('error', err => test.fail(err));

    const rows = [];
    zongji.on('binlog', evt => {
      if (evt.getTypeName() === 'WriteRows' &&
          evt.tableMap[evt.tableId].tableName === TEST_TABLE) {
        rows.push(evt.rows[0].col);
      }
    });

    // Self-contained history: written before the dump starts, so an
    // empty position (= from the oldest binlog) must replay it
    testDb.execute([
      `DROP TABLE IF EXISTS ${TEST_TABLE}`,
      `CREATE TABLE ${TEST_TABLE} (col INT UNSIGNED)`,
      `INSERT INTO ${TEST_TABLE} (col) VALUES (1)`,
      `INSERT INTO ${TEST_TABLE} (col) VALUES (2)`,
    ], err => {
      if (err) {
        return test.fail(err);
      }

      zongji.start({
        gtidSet: '',
        serverId: testDb.serverId(),
        includeEvents: ['tablemap', 'writerows'],
      });

      zongji.on('ready', () => {
        setTimeout(() => {
          test.strictSame(rows, [1, 2],
            'history written before the dump streams from the oldest file');
          test.end();
        }, 1500);
      });
    });
  });

  tap.test('GTID position ahead of the binlog surfaces an explicit error', test => {
    const zongji = new ZongJi(settings.connection);
    test.teardown(() => zongji.stop());

    zongji.on('error', err => {
      test.match(err.message, /not in the master's binlog/i,
        'explicit GTID-not-found error');
      test.end();
    });
    zongji.on('binlog', () => test.fail('no events expected'));

    zongji.start({
      gtidSet: '0-1-99999999',
      serverId: testDb.serverId(),
    });
  });

  tap.test('MySQL-format gtidSet is rejected against MariaDB', test => {
    const zongji = new ZongJi(settings.connection);
    test.teardown(() => zongji.stop());

    zongji.on('error', err => {
      test.match(err.message, /MySQL GTID set but the server is MariaDB/);
      test.end();
    });
    zongji.on('binlog', () => test.fail('no events expected'));

    zongji.start({
      serverId: testDb.serverId(),
      gtidSet: '00000000-0000-0000-0000-000000000000:1-5',
    });
  });

  tap.test('gtidSet seeds from the stream when reading from the start', test => {
    const zongji = new ZongJi(settings.connection);
    test.teardown(() => zongji.stop());
    zongji.on('error', err => test.fail(err));
    zongji.on('binlog', () => {});

    // No filename/position: the dump starts at the oldest binlog file and
    // the GTID list at its start is the seed
    zongji.start({
      serverId: testDb.serverId(),
      includeEvents: ['tablemap', 'writerows'],
    });

    zongji.on('ready', () => {
      setTimeout(() => {
        test.ok(zongji.gtidSet !== undefined,
          'position seeded from the stream GTID list');
        test.match(zongji.gtidSet, /^$|^\d+-\d+-\d+(,\d+-\d+-\d+)*$/,
          'seeded value is a MariaDB GTID position');
        test.end();
      }, 1500);
    });
  });
});
