// MariaDB-specific behaviour: native GTID/checkpoint/GTID-list events
// (available because zongji announces @mariadb_slave_capability=4) and the
// interim rejection of MySQL-style GTID resume. The whole file no-ops
// against a MySQL server.
import tap from 'tap';
import mysql from 'mysql2';

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

  tap.test('log_bin_compress events decode transparently', test => {
    const TEST_TABLE = 'mariadb_compress_test';

    const zongji = new ZongJi(settings.connection);
    test.teardown(() => zongji.stop());
    test.teardown(() => new Promise(resolve => testDb.execute(
      ['SET GLOBAL log_bin_compress = OFF',
        'SET GLOBAL log_bin_compress_min_len = 256'], () => resolve())));
    zongji.on('error', err => test.fail(err));

    const queries = [];
    const rowEvents = [];
    zongji.on('binlog', evt => {
      const type = evt.getTypeName();
      if (type === 'Query') {
        queries.push(evt.query);
      }
      if ((type === 'WriteRows' || type === 'UpdateRows' ||
           type === 'DeleteRows') &&
          evt.tableMap[evt.tableId].tableName === TEST_TABLE) {
        rowEvents.push(evt);
      }
    });

    testDb.execute([
      'SET GLOBAL log_bin_compress = ON',
      'SET GLOBAL log_bin_compress_min_len = 10',
      // Other test files may have left NOBLOB behind; the assertions
      // below expect the TEXT column in every row image
      'SET GLOBAL binlog_row_image = FULL',
      `DROP TABLE IF EXISTS ${TEST_TABLE}`,
    ], err => {
      if (err) {
        return test.fail(err);
      }

      zongji.start({
        startAtEnd: true,
        serverId: testDb.serverId(),
        includeEvents:
          ['query', 'xid', 'tablemap', 'writerows', 'updaterows',
            'deleterows'],
      });

      zongji.on('ready', () => {
        testDb.execute([
          `CREATE TABLE ${TEST_TABLE} (id INT PRIMARY KEY, payload TEXT)`,
          `INSERT INTO ${TEST_TABLE} VALUES (1, REPEAT('squash-', 60))`,
          `UPDATE ${TEST_TABLE} SET payload = REPEAT('flat-', 80)`,
          `DELETE FROM ${TEST_TABLE}`,
        ], insertErr => {
          if (insertErr) {
            return test.fail(insertErr);
          }
          setTimeout(() => {
            // Prove the server really compressed the events
            testDb.execute([
              'SHOW BINLOG EVENTS',
            ], (showErr, results) => {
              if (showErr) {
                return test.fail(showErr);
              }
              const eventTypes = results[results.length - 1]
                .map(row => row.Event_type);
              test.ok(eventTypes.some(t => /compressed/i.test(t)),
                'server wrote compressed events ' +
                `(saw: ${[...new Set(eventTypes)].join(', ')})`);

              test.ok(queries.some(q => q.includes(
                `CREATE TABLE ${TEST_TABLE}`)),
                'compressed Query event decodes to its statement text');

              test.equal(rowEvents.length, 3,
                'write, update and delete row events all arrived');
              const [w, u, d] = rowEvents;
              test.equal(w.getTypeName(), 'WriteRows');
              test.strictSame(w.rows[0],
                { id: 1, payload: 'squash-'.repeat(60) },
                'compressed insert row decodes');
              test.equal(u.getTypeName(), 'UpdateRows');
              test.strictSame(u.rows[0].after.payload, 'flat-'.repeat(80),
                'compressed update row decodes');
              test.equal(d.getTypeName(), 'DeleteRows');
              test.strictSame(d.rows[0].payload, 'flat-'.repeat(80),
                'compressed delete row decodes');
              test.end();
            });
          }, 1000);
        });
      });
    });
  });

  tap.test('MariaDB 5.3 hires temporals decode', test => {
    const TEST_TABLE = 'mariadb_hires_test';

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
      // GLOBAL-only; the storage format is baked into the table at
      // CREATE time, so it can be restored immediately afterwards
      'SET GLOBAL mysql56_temporal_format = OFF',
      `DROP TABLE IF EXISTS ${TEST_TABLE}`,
      `CREATE TABLE ${TEST_TABLE} (
        ts0 TIMESTAMP NULL, ts3 TIMESTAMP(3) NULL, ts6 TIMESTAMP(6) NULL,
        dt0 DATETIME, dt1 DATETIME(1), dt3 DATETIME(3), dt6 DATETIME(6),
        t0 TIME, t2 TIME(2), t3 TIME(3), t6 TIME(6), tneg TIME(3)
      )`,
      'SET GLOBAL mysql56_temporal_format = ON',
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
          `INSERT INTO ${TEST_TABLE} VALUES (
            '2023-01-02 03:04:05', '2023-01-02 03:04:05.678',
            '2023-01-02 03:04:05.678000',
            '2023-01-02 03:04:05', '2023-01-02 03:04:05.6',
            '2023-01-02 03:04:05.678', '2023-01-02 03:04:05.678000',
            '03:04:05', '03:04:05.67', '03:04:05.678', '03:04:05.678901',
            '-838:59:58.999')`,
          `INSERT INTO ${TEST_TABLE} VALUES
            (NULL, NULL, NULL, NULL, NULL, NULL, NULL,
             NULL, NULL, NULL, NULL, NULL)`,
        ], insertErr => {
          if (insertErr) {
            return test.fail(insertErr);
          }
          // FULL metadata cannot describe hires columns; these inserts
          // must fall back to the INFORMATION_SCHEMA path
          testDb.execute([
            'SET GLOBAL binlog_row_metadata = FULL',
            `INSERT INTO ${TEST_TABLE} VALUES (
              '2024-05-06 07:08:09', '2024-05-06 07:08:09.123',
              '2024-05-06 07:08:09.123000',
              '2024-05-06 07:08:09', '2024-05-06 07:08:09.1',
              '2024-05-06 07:08:09.123', '2024-05-06 07:08:09.123000',
              '07:08:09', '07:08:09.12', '07:08:09.123',
              '07:08:09.123456', '-01:02:03.004')`,
            'SET GLOBAL binlog_row_metadata = NO_LOG',
            `SELECT * FROM ${TEST_TABLE}`,
          ], (selectErr, results) => {
            if (selectErr) {
              return test.fail(selectErr);
            }
            const expected = results[results.length - 1];
            setTimeout(() => {
              test.equal(rows.length, expected.length,
                'all rows decoded');
              for (let i = 0; i < expected.length; i++) {
                test.strictSame(rows[i], { ...expected[i] },
                  `row ${i + 1} matches the mysql2 query result` +
                  (i === expected.length - 1 ?
                    ' (written under FULL metadata)' : ''));
              }
              test.end();
            }, 1000);
          });
        });
      });
    });
  });

  tap.test('requestAnnotateRows delivers statement text', test => {
    const TEST_TABLE = 'mariadb_annotate_test';

    // Annotate events are only sent when the dump requests them; a
    // second instance without the option must see none
    const withOption = new ZongJi(settings.connection);
    const withoutOption = new ZongJi(settings.connection);
    test.teardown(() => withOption.stop());
    test.teardown(() => withoutOption.stop());
    withOption.on('error', err => test.fail(err));
    withoutOption.on('error', err => test.fail(err));

    const annotations = [];
    let rowSeen = false;
    withOption.on('binlog', evt => {
      if (evt.getTypeName() === 'AnnotateRows') {
        annotations.push(evt.statement);
      }
      if (evt.getTypeName() === 'WriteRows') {
        rowSeen = true;
      }
    });
    let unrequestedAnnotations = 0;
    withoutOption.on('binlog', evt => {
      if (evt.getTypeName() === 'AnnotateRows') {
        unrequestedAnnotations++;
      }
    });

    testDb.execute([
      `DROP TABLE IF EXISTS ${TEST_TABLE}`,
      `CREATE TABLE ${TEST_TABLE} (col INT UNSIGNED)`,
    ], err => {
      if (err) {
        return test.fail(err);
      }

      const startOptions = {
        startAtEnd: true,
        includeEvents: ['annotaterows', 'tablemap', 'writerows'],
      };
      withOption.start({
        ...startOptions,
        serverId: testDb.serverId(),
        requestAnnotateRows: true,
      });
      withoutOption.start({
        ...startOptions,
        serverId: testDb.serverId(),
      });

      let readyCount = 0;
      const onReady = () => {
        if (++readyCount < 2) {
          return;
        }
        testDb.execute([
          `INSERT INTO ${TEST_TABLE} (col) VALUES (42)`,
        ], insertErr => {
          if (insertErr) {
            return test.fail(insertErr);
          }
          setTimeout(() => {
            test.ok(rowSeen, 'row event delivered alongside annotations');
            test.equal(annotations.length, 1,
              'one annotate event per row statement');
            test.match(annotations[0],
              new RegExp(`INSERT INTO ${TEST_TABLE}`),
              'annotation carries the originating SQL text');
            test.equal(unrequestedAnnotations, 0,
              'no annotate events without the option');
            test.end();
          }, 1000);
        });
      };
      withOption.on('ready', onReady);
      withoutOption.on('ready', onReady);
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

  tap.test('MariaDB JSON columns (LONGTEXT alias)', test => {
    const TEST_TABLE = 'mariadb_json_test';
    // The big integer exceeds Number.MAX_SAFE_INTEGER: JSON.parse would
    // silently round it to ...92. Exactness needs JSON.parse source
    // access (Node 22+); older runtimes deliberately fall back to plain
    // JSON.parse, so expect the rounded Number there
    const sourceAccessSupported = (() => {
      let supported = false;
      JSON.parse('0', (key, value, context) => {
        supported = context !== undefined &&
          typeof context.source === 'string';
        return value;
      });
      return supported;
    })();
    const BIG_EXPECTED = sourceAccessSupported ?
      '9007199254740993' : 9007199254740992;
    const DOC = '{"n": 1, "big": 9007199254740993, "s": "x"}';
    const CHECKED_DOC = '{"n": 2}';
    const PLAIN_DOC = '{"n": 3}';
    const BACKTICK_DOC = '{"n": 4}';

    test.test(`prepare table ${TEST_TABLE}`, test => {
      // JSON detection uses the column's json_valid check constraint via
      // INFORMATION_SCHEMA, so it needs the non-self-describing metadata
      // path; MINIMAL is the server default, pin it in case a FULL test
      // left it set
      testDb.execute([
        'SET GLOBAL binlog_row_metadata = MINIMAL',
        `DROP TABLE IF EXISTS ${TEST_TABLE}`,
        // jc: the server flags any longtext with a column-level
        // json_valid check as JSON on the wire, declared JSON or not;
        // t: valid JSON text in a plain LONGTEXT must stay a string
        // (detection is by constraint, not content); the backticked
        // name pins the identifier escaping in the detection join
        `CREATE TABLE ${TEST_TABLE} (
          id INT PRIMARY KEY,
          j JSON,
          jc LONGTEXT CHECK (json_valid(jc)),
          t LONGTEXT,
          \`bt\`\`ick\` JSON
        )`,
      ], err => {
        if (err) {
          return test.fail(err);
        }
        test.end();
      });
    });

    test.test('parsed values by default, 64-bit integers exact', test => {
      // The shared test settings turn jsonStrings on; drop the key so
      // this exercises the option's default
      const defaults = { ...settings.connection };
      delete defaults.jsonStrings;
      const zongji = new ZongJi(defaults);
      test.teardown(() => zongji.stop());
      zongji.on('error', err => test.fail(err));

      let row = null;
      let schemas = null;
      zongji.on('binlog', evt => {
        if (evt.getTypeName() === 'WriteRows' &&
            evt.tableMap[evt.tableId].tableName === TEST_TABLE) {
          row = evt.rows[0];
          schemas = evt.tableMap[evt.tableId].columnSchemas;
        }
      });

      zongji.start({
        startAtEnd: true,
        serverId: testDb.serverId(),
        includeEvents: ['tablemap', 'writerows'],
      });
      zongji.on('ready', () => {
        testDb.execute([
          `INSERT INTO ${TEST_TABLE} VALUES
            (1, '${DOC}', '${CHECKED_DOC}', '${PLAIN_DOC}',
             '${BACKTICK_DOC}')`,
        ], err => {
          if (err) {
            return test.fail(err);
          }
          setTimeout(() => {
            test.strictSame(row.j, { n: 1, big: BIG_EXPECTED, s: 'x' },
              'declared JSON parses; big integer arrives exact (Node 22+)');
            test.strictSame(row.jc, { n: 2 },
              'json_valid-checked LONGTEXT parses too (matches the ' +
              'server wire-protocol JSON flag)');
            test.equal(row.t, PLAIN_DOC,
              'plain LONGTEXT stays a string even when it holds JSON');
            test.strictSame(row['bt`ick'], { n: 4 },
              'backticks in the column name survive detection');
            test.strictSame(schemas.map(schema => schema.IS_JSON),
              [false, true, true, false, true],
              'IS_JSON marks all three');
            test.end();
          }, 1500);
        });
      });
    });

    test.test('jsonStrings: true keeps the raw text', test => {
      const zongji = new ZongJi({
        ...settings.connection, jsonStrings: true,
      });
      test.teardown(() => zongji.stop());
      zongji.on('error', err => test.fail(err));

      let row = null;
      zongji.on('binlog', evt => {
        if (evt.getTypeName() === 'WriteRows' &&
            evt.tableMap[evt.tableId].tableName === TEST_TABLE) {
          row = evt.rows[0];
        }
      });

      zongji.start({
        startAtEnd: true,
        serverId: testDb.serverId(),
        includeEvents: ['tablemap', 'writerows'],
      });
      zongji.on('ready', () => {
        testDb.execute([
          `INSERT INTO ${TEST_TABLE} VALUES
            (2, '${DOC}', '${CHECKED_DOC}', '${PLAIN_DOC}',
             '${BACKTICK_DOC}')`,
        ], err => {
          if (err) {
            return test.fail(err);
          }
          setTimeout(() => {
            test.equal(row.j, DOC,
              'raw stored text, 64-bit integer digits intact');
            test.equal(row.jc, CHECKED_DOC);
            test.equal(row.t, PLAIN_DOC);
            test.equal(row['bt`ick'], BACKTICK_DOC);
            test.end();
          }, 1500);
        });
      });
    });

    // The json_valid constraint is not enforced for a session that sets
    // check_constraint_checks=0, so a JSON column can hold text that does
    // not parse. The value must arrive as the raw string and the stream
    // must carry on
    test.test('invalid JSON stays a string', test => {
      const INVALID_DOC = 'not json';
      const zongji = new ZongJi({
        ...settings.connection, jsonStrings: false,
      });
      test.teardown(() => zongji.stop());
      zongji.on('error', err => test.fail(err));

      const rows = [];
      zongji.on('binlog', evt => {
        if (evt.getTypeName() === 'WriteRows' &&
            evt.tableMap[evt.tableId].tableName === TEST_TABLE) {
          rows.push(evt.rows[0]);
        }
      });

      zongji.start({
        startAtEnd: true,
        serverId: testDb.serverId(),
        includeEvents: ['tablemap', 'writerows'],
      });
      zongji.on('ready', () => {
        testDb.execute([
          'SET SESSION check_constraint_checks = 0',
          `INSERT INTO ${TEST_TABLE} VALUES
            (3, '${INVALID_DOC}', '${CHECKED_DOC}', '${PLAIN_DOC}',
             '${BACKTICK_DOC}')`,
          'SET SESSION check_constraint_checks = 1',
          `INSERT INTO ${TEST_TABLE} VALUES
            (4, '${DOC}', '${CHECKED_DOC}', '${PLAIN_DOC}',
             '${BACKTICK_DOC}')`,
        ], err => {
          if (err) {
            return test.fail(err);
          }
          setTimeout(() => {
            test.equal(rows.length, 2, 'both rows delivered');
            test.equal(rows[0].j, INVALID_DOC,
              'unparseable text is delivered as stored');
            test.strictSame(rows[0].jc, { n: 2 },
              'other JSON columns in the same row still parse');
            test.strictSame(rows[1].j, { n: 1, big: BIG_EXPECTED, s: 'x' },
              'the stream carries on: the following row parses normally');
            test.end();
          }, 1500);
        });
      });
    });

    // The catalogue renders the column name inside the check clause
    // according to the session that reads it: backticks by default,
    // double quotes under ANSI_QUOTES, bare with sql_quote_show_create=0.
    // Detection must recognise all three, including names that contain
    // the quote character itself. ZongJi runs its metadata query on the
    // connection it is given, so set the session there
    for (const sessionSetting of [
      "sql_mode = 'ANSI_QUOTES'",
      'sql_quote_show_create = 0',
    ]) {
      test.test(`detected with session ${sessionSetting}`, test => {
        const QUOTE_TABLE = 'mariadb_json_quote_test';
        const conn = mysql.createConnection({
          ...settings.connection, jsonStrings: false,
        });
        conn.query(`SET SESSION ${sessionSetting}`);
        const zongji = new ZongJi(conn);
        zongji.on('stopped', () => conn.destroy());
        test.teardown(() => zongji.stop());
        zongji.on('error', err => test.fail(err));

        let row = null;
        let schemas = null;
        zongji.on('binlog', evt => {
          if (evt.getTypeName() === 'WriteRows' &&
              evt.tableMap[evt.tableId].tableName === QUOTE_TABLE) {
            row = evt.rows[0];
            schemas = evt.tableMap[evt.tableId].columnSchemas;
          }
        });

        testDb.execute([
          `DROP TABLE IF EXISTS ${QUOTE_TABLE}`,
          `CREATE TABLE ${QUOTE_TABLE} (
            id INT PRIMARY KEY,
            j JSON,
            \`bt\`\`ick\` JSON,
            \`dq"uote\` JSON,
            t LONGTEXT
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
              `INSERT INTO ${QUOTE_TABLE} VALUES
                (1, '${CHECKED_DOC}', '${BACKTICK_DOC}', '${DOC}',
                 '${PLAIN_DOC}')`,
            ], err => {
              if (err) {
                return test.fail(err);
              }
              setTimeout(() => {
                test.strictSame(schemas.map(schema => schema.IS_JSON),
                  [false, true, true, true, false]);
                test.strictSame(row.j, { n: 2 });
                test.strictSame(row['bt`ick'], { n: 4 },
                  'a name containing a backtick is matched');
                test.strictSame(row['dq"uote'],
                  { n: 1, big: BIG_EXPECTED, s: 'x' },
                  'a name containing a double quote is matched');
                test.equal(row.t, PLAIN_DOC);
                test.end();
              }, 1500);
            });
          });
        });
      });
    }

    // The server flags a column with a column-level json_valid check as
    // JSON when it is a character or binary string type, not only
    // LONGTEXT, and a mysql2 query returns parsed values for all of them
    // (text with jsonStrings). Binary types hold the text as bytes, read
    // as UTF-8. The same check on other types (DECIMAL, ENUM here) is not
    // flagged by the server, so those values must be left alone
    const UNICODE_DOC = '{"s": "café"}';
    const DECIMAL_TEXT = '123456789012345678.90';
    for (const jsonStrings of [false, true]) {
      test.test(`json_valid check on other column types, jsonStrings: ${
        jsonStrings}`, test => {
        const TYPES_TABLE = 'mariadb_json_types_test';
        const zongji = new ZongJi({ ...settings.connection, jsonStrings });
        test.teardown(() => zongji.stop());
        zongji.on('error', err => test.fail(err));

        let row = null;
        let schemas = null;
        zongji.on('binlog', evt => {
          if (evt.getTypeName() === 'WriteRows' &&
              evt.tableMap[evt.tableId].tableName === TYPES_TABLE) {
            row = evt.rows[0];
            schemas = evt.tableMap[evt.tableId].columnSchemas;
          }
        });

        testDb.execute([
          `DROP TABLE IF EXISTS ${TYPES_TABLE}`,
          `CREATE TABLE ${TYPES_TABLE} (
            id INT PRIMARY KEY,
            tx TEXT CHECK (json_valid(tx)),
            vc VARCHAR(100) CHECK (json_valid(vc)),
            ch CHAR(50) CHECK (json_valid(ch)),
            lb LONGBLOB CHECK (json_valid(lb)),
            vb VARBINARY(100) CHECK (json_valid(vb)),
            d DECIMAL(20,2) CHECK (json_valid(d)),
            e ENUM('true', 'x') CHECK (json_valid(e)),
            plain VARCHAR(100)
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
              `INSERT INTO ${TYPES_TABLE} VALUES
                (1, '${CHECKED_DOC}', '${CHECKED_DOC}', '${CHECKED_DOC}',
                 '${UNICODE_DOC}', '${UNICODE_DOC}', ${DECIMAL_TEXT},
                 'true', '${CHECKED_DOC}')`,
            ], err => {
              if (err) {
                return test.fail(err);
              }
              setTimeout(() => {
                test.strictSame(schemas.map(schema => schema.IS_JSON),
                  [false, true, true, true, true, true, false, false, false],
                  'string and binary types flagged, DECIMAL and ENUM not');
                for (const name of ['tx', 'vc', 'ch']) {
                  test.strictSame(row[name],
                    jsonStrings ? CHECKED_DOC : { n: 2 }, name);
                }
                for (const name of ['lb', 'vb']) {
                  test.strictSame(row[name],
                    jsonStrings ? UNICODE_DOC : { s: 'café' },
                    `${name}: bytes read as UTF-8`);
                }
                test.equal(row.d, DECIMAL_TEXT,
                  'DECIMAL keeps its exact decimal text');
                test.equal(row.e, 'true', 'ENUM value is not converted');
                test.equal(row.plain, CHECKED_DOC,
                  'a column without the check stays a string');
                test.end();
              }, 1500);
            });
          });
        });
      });
    }

    test.end();
  });
});
