// Captures raw binlog packets from a running MySQL server into
// test/fixtures/*.json so the parsing layer can be tested offline
// (see test/parser.js). Regenerate with:
//
//   node scripts/capture-fixtures.js [suffix]
//
// against a MySQL server started like the test containers
// (docker-compose up -d mysql84). Environment overrides:
// MYSQL_HOST, TEST_MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2';
import ZongJi from '../index.js';

const FIXTURE_DB = 'zongji_fixture_capture';
const SUFFIX = process.argv[2] || 'mysql';

const connectionSettings = {
  host: process.env.MYSQL_HOST || 'localhost',
  port: process.env.TEST_MYSQL_PORT || 3306,
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || 'secret',
  timezone: 'Z',
  dateStrings: ['TIMESTAMP'],
};

// The statements whose binlog events form the fixture. Session time_zone is
// pinned so TIMESTAMP values are reproducible.
const CAPTURE_TABLE = 'capture_types';
const captureStatements = [
  'SET @@session.time_zone = "+00:00"',
  `CREATE TABLE ${CAPTURE_TABLE} (
    id INT,
    i_big BIGINT,
    u_big BIGINT UNSIGNED,
    dec_col DECIMAL(30, 10),
    vc VARCHAR(20),
    ch CHAR(5),
    bin_col BINARY(4),
    vb VARBINARY(8),
    txt TEXT,
    blb BLOB,
    flt FLOAT,
    dbl DOUBLE,
    dt DATETIME(3),
    ts TIMESTAMP NULL,
    d DATE,
    t TIME(3),
    y YEAR,
    e ENUM('a', 'b', 'c'),
    s SET('x', 'y', 'z'),
    bt BIT(10),
    js JSON,
    geo GEOMETRY
  )`,
  `INSERT INTO ${CAPTURE_TABLE} VALUES (
    1,
    9223372036854775807,
    18446744073709551615,
    -12345678901234567.0123456789,
    'héllo wörld',
    'abc',
    X'DEADBEEF',
    X'0102',
    'text value',
    X'CAFE',
    1.25,
    -2.5,
    '2024-06-15 12:34:56.789',
    '2024-06-15 12:34:56',
    '2024-06-15',
    '-01:02:03.500',
    2024,
    'b',
    'x,z',
    b'1000000001',
    '{"a": 1, "big": 9223372036854775807, "arr": ["x", true, null], "d": 1.5}',
    ST_GeomFromText('POINT(1 2)')
  )`,
  `UPDATE ${CAPTURE_TABLE} SET id = 2, vc = 'updated' WHERE id = 1`,
  `DELETE FROM ${CAPTURE_TABLE} WHERE id = 2`,
  `INSERT INTO ${CAPTURE_TABLE} (id) VALUES (3)`, // all other columns NULL
  'FLUSH LOGS', // real Rotate event
  'SET @@session.time_zone = "SYSTEM"',
];

function query(conn, sql) {
  return new Promise((resolve, reject) => {
    conn.query(sql, (err, result) => err ? reject(err) : resolve(result));
  });
}

async function main() {
  const admin = mysql.createConnection(connectionSettings);
  await query(admin, `DROP DATABASE IF EXISTS ${FIXTURE_DB}`);
  await query(admin, `CREATE DATABASE ${FIXTURE_DB}`);
  const versionRows = await query(admin, 'SELECT VERSION() AS version');

  const zongji = new ZongJi({ ...connectionSettings, database: FIXTURE_DB });
  const packets = [];
  const eventSummary = [];

  zongji.on('error', err => {
    console.error('zongji error:', err);
    process.exitCode = 1;
  });

  zongji.on('binlog', event => {
    eventSummary.push(event.getTypeName());
  });

  zongji.on('ready', async () => {
    // Capture every packet payload exactly as the Parser sees it
    const proto = zongji.BinlogClass.prototype;
    const originalBinlogData = proto.binlogData;
    proto.binlogData = function(packet, connection) {
      if (packet && packet.buffer && !packet.isEOF() && !packet.isError()) {
        packets.push(
          packet.buffer.subarray(packet.offset, packet.end).toString('hex'));
      }
      return originalBinlogData.call(this, packet, connection);
    };

    const work = mysql.createConnection(
      { ...connectionSettings, database: FIXTURE_DB });
    try {
      for (const sql of captureStatements) {
        await query(work, sql);
      }
    } finally {
      work.destroy();
    }

    // Give the binlog stream a moment to drain
    setTimeout(async () => {
      const tableSchemas = {};
      for (const entry of Object.values(zongji.tableMap)) {
        tableSchemas[entry.tableName] = entry.columnSchemas;
      }

      const fixture = {
        description:
          'Raw binlog packet payloads captured by scripts/capture-fixtures.js',
        serverVersion: versionRows[0].version,
        useChecksum: zongji.useChecksum,
        connectionConfig: {
          timezone: connectionSettings.timezone,
          dateStrings: connectionSettings.dateStrings,
        },
        schemaName: FIXTURE_DB,
        tableSchemas,
        eventSummary,
        packets,
      };

      const dir = path.dirname(fileURLToPath(import.meta.url));
      const outFile = path.join(
        dir, '..', 'test', 'fixtures', `binlog-${SUFFIX}.json`);
      fs.writeFileSync(outFile, JSON.stringify(fixture, null, 2) + '\n');
      console.log(`Wrote ${packets.length} packets (${eventSummary.join(', ')})`);
      console.log(`-> ${outFile}`);

      zongji.stop();
      await query(admin, `DROP DATABASE IF EXISTS ${FIXTURE_DB}`);
      admin.destroy();
    }, 2000);
  });

  zongji.start({ startAtEnd: true, serverId: 999 });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
