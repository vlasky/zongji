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

  tap.test('gtidSet start is rejected clearly on MariaDB', test => {
    const zongji = new ZongJi(settings.connection);
    test.teardown(() => zongji.stop());

    zongji.on('error', err => {
      test.match(err.message, /not yet supported against MariaDB/);
      test.end();
    });
    zongji.on('binlog', () => test.fail('no events expected'));

    zongji.start({
      serverId: testDb.serverId(),
      // A MySQL-style set: parses fine, but MariaDB cannot serve it
      gtidSet: '00000000-0000-0000-0000-000000000000:1-5',
    });
  });
});
