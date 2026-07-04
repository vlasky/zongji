// Live tests for TABLE_MAP_EVENT optional metadata (binlog_row_metadata).
// MySQL 8.0+ only; the FULL tests toggle the global setting and restore it.
import tap from 'tap';

import ZongJi from '../index.js';
import * as testDb from './helpers/index.js';
import settings from './settings/mysql.js';

tap.test('Initialise testing db', async test => {
  try {
    await testDb.initAsync();
    test.pass('database initialized');
  } catch (err) {
    test.fail(err);
  }
});

testDb.requireVersion('8.0.1', () => {
  tap.test('FULL metadata: rows decode without INFORMATION_SCHEMA', test => {
    const TEST_TABLE = 'metadata_full_test';

    const zongji = new ZongJi(settings.connection);
    test.teardown(() => new Promise(resolve => {
      zongji.stop();
      testDb.execute(['SET GLOBAL binlog_row_metadata = MINIMAL'],
        () => resolve());
    }));

    zongji.on('error', err => test.fail(err));

    const events = [];
    zongji.on('binlog', event => events.push(event));

    testDb.execute([
      'SET GLOBAL binlog_row_metadata = FULL',
      `DROP TABLE IF EXISTS ${TEST_TABLE}`,
      `CREATE TABLE ${TEST_TABLE} (
        id INT UNSIGNED PRIMARY KEY,
        big BIGINT UNSIGNED,
        e ENUM('a,b', 'c''d', 'plain'),
        t TEXT CHARACTER SET latin1,
        v VARBINARY(4)
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
        // The self-describing path must never touch the control connection;
        // _fetchTableInfo is its only execute() caller
        let metadataQueries = 0;
        const ctrlConnection = zongji.ctrlConnection;
        const originalExecute = ctrlConnection.execute.bind(ctrlConnection);
        ctrlConnection.execute = (...args) => {
          metadataQueries++;
          return originalExecute(...args);
        };

        testDb.execute([
          `INSERT INTO ${TEST_TABLE} VALUES
            (1, 18446744073709551615, 'c''d', 'café ñ', X'01FF')`,
        ], insertErr => {
          if (insertErr) {
            return test.fail(insertErr);
          }

          setTimeout(() => {
            const tableMap = events.find(event =>
              event.getTypeName() === 'TableMap' &&
              event.tableName === TEST_TABLE);
            const write = events.find(event =>
              event.getTypeName() === 'WriteRows' &&
              event.tableMap[event.tableId].tableName === TEST_TABLE);

            test.ok(tableMap, 'TableMap event received');
            test.ok(tableMap.hasSelfDescribingMetadata(),
              'TableMap carries FULL metadata');
            test.strictSame(tableMap.columnNames,
              ['id', 'big', 'e', 't', 'v']);
            test.strictSame(tableMap.primaryKey, [0]);

            test.ok(write, 'WriteRows event received');
            const row = write.rows[0];
            test.equal(row.id, 1);
            test.strictSame(row.big, '18446744073709551615',
              'UNSIGNED BIGINT exact via binlog signedness');
            test.equal(row.e, "c'd",
              'enum value with quote decodes from binlog value list');
            test.equal(row.t, 'café ñ',
              'latin1 TEXT decoded via binlog charset');
            test.strictSame(row.v, Buffer.from([0x01, 0xff]));

            test.equal(metadataQueries, 0,
              'no INFORMATION_SCHEMA fetch happened');
            test.end();
          }, 1000);
        });
      });
    });
  });

  tap.test('FULL metadata: ALTER TABLE never leaves stale columns', test => {
    const TEST_TABLE = 'metadata_alter_test';

    const zongji = new ZongJi(settings.connection);
    test.teardown(() => new Promise(resolve => {
      zongji.stop();
      testDb.execute(['SET GLOBAL binlog_row_metadata = MINIMAL'],
        () => resolve());
    }));

    zongji.on('error', err => test.fail(err));

    const writes = [];
    zongji.on('binlog', event => {
      if (event.getTypeName() === 'WriteRows') {
        writes.push(event.rows[0]);
      }
    });

    testDb.execute([
      'SET GLOBAL binlog_row_metadata = FULL',
      `DROP TABLE IF EXISTS ${TEST_TABLE}`,
      `CREATE TABLE ${TEST_TABLE} (a INT)`,
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
          `INSERT INTO ${TEST_TABLE} VALUES (1)`,
          `ALTER TABLE ${TEST_TABLE} ADD COLUMN b VARCHAR(10)`,
          `INSERT INTO ${TEST_TABLE} VALUES (2, 'two')`,
        ], insertErr => {
          if (insertErr) {
            return test.fail(insertErr);
          }

          setTimeout(() => {
            test.strictSame(writes, [
              { a: 1 },
              { a: 2, b: 'two' },
            ], 'each row decoded with the schema in force when written');
            test.end();
          }, 1000);
        });
      });
    });
  });

  tap.test('MINIMAL metadata: binlog signedness reaches column schemas',
    test => {
      const TEST_TABLE = 'metadata_minimal_test';

      const zongji = new ZongJi(settings.connection);
      test.teardown(() => zongji.stop());

      zongji.on('error', err => test.fail(err));

      const events = [];
      zongji.on('binlog', event => events.push(event));

      // binlog_row_metadata is MINIMAL here (the server default; earlier
      // tests restore it)
      testDb.execute([
        `DROP TABLE IF EXISTS ${TEST_TABLE}`,
        `CREATE TABLE ${TEST_TABLE} (i BIGINT, u BIGINT UNSIGNED)`,
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
            `INSERT INTO ${TEST_TABLE} VALUES (-1, 18446744073709551615)`,
          ], insertErr => {
            if (insertErr) {
              return test.fail(insertErr);
            }

            setTimeout(() => {
              const tableMap = events.find(event =>
                event.getTypeName() === 'TableMap' &&
                event.tableName === TEST_TABLE);
              test.ok(tableMap, 'TableMap event received');
              test.equal(tableMap.hasSelfDescribingMetadata(), false,
                'MINIMAL metadata is not self-describing');
              test.strictSame(tableMap.signedness, [false, true],
                'signedness parsed from MINIMAL metadata');

              const schemas = tableMap.tableMap[tableMap.tableId]
                .columnSchemas;
              test.equal(schemas[0].UNSIGNED, false);
              test.equal(schemas[1].UNSIGNED, true,
                'binlog signedness overlaid on fetched schemas');

              const write = events.find(event =>
                event.getTypeName() === 'WriteRows');
              test.equal(write.rows[0].i, -1);
              test.strictSame(write.rows[0].u, '18446744073709551615');
              test.end();
            }, 1000);
          });
        });
      });
    });
});
