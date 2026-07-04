// Offline parser tests: replays raw binlog packets captured by
// scripts/capture-fixtures.js through the full parsing pipeline without a
// database connection. Values asserted here correspond to the statements
// in scripts/capture-fixtures.js.
import fs from 'fs';
import tap from 'tap';

import ZongJi from '../index.js';
import initBinlogPacketClass from '../lib/packet/binlog.js';
import { Parser } from '../lib/reader.js';

const FIXTURE = JSON.parse(fs.readFileSync(
  new URL('./fixtures/binlog-mysql84.json', import.meta.url), 'utf8'));
// Same statements captured with binlog_row_metadata=FULL; carries no
// tableSchemas, so decoding proves the events are self-describing
const FIXTURE_FULLMETA = JSON.parse(fs.readFileSync(
  new URL('./fixtures/binlog-mysql84-fullmeta.json', import.meta.url),
  'utf8'));

// Replays every packet in a fixture and returns the decoded events,
// mimicking the TableMap metadata handling of ZongJi's binlogHandler.
// configOverrides simulates different mysql2 connection options; the
// captured bytes are independent of them.
function decodeFixture(fixture, configOverrides = {}) {
  const zongji = new ZongJi({});
  zongji.useChecksum = fixture.useChecksum;
  zongji.connection = {
    config: { ...fixture.connectionConfig, ...configOverrides },
  };
  const BinlogPacket = initBinlogPacketClass(zongji);

  return fixture.packets.map(hex => {
    const buffer = Buffer.from(hex, 'hex');
    const packet = { buffer, offset: 0, end: buffer.length };
    const parser = new Parser(packet);
    const binlogPacket = new BinlogPacket();
    binlogPacket.parse(parser);
    const event = binlogPacket.getEvent();

    if (event.getTypeName() === 'TableMap') {
      // What ZongJi#binlogHandler does: self-describing events build their
      // own schemas, others get the INFORMATION_SCHEMA snapshot
      zongji.tableMap[event.tableId] = {
        columnSchemas: event.hasSelfDescribingMetadata() ?
          event.buildColumnSchemas() :
          fixture.tableSchemas[event.tableName],
        parentSchema: event.schemaName,
        tableName: event.tableName,
      };
      event.updateColumnInfo();
    }
    return event;
  });
}

// Row-value assertions shared by both metadata sources. e2 (an ENUM whose
// values contain a comma and a quote) is only asserted for the FULL
// metadata path: the INFORMATION_SCHEMA path parses the value list out of
// the COLUMN_TYPE string and cannot handle those characters.
function assertCanonicalRows(test, events, { exactEnumValues } = {}) {
  const writes = events.filter(e => e.getTypeName() === 'WriteRows');
  const updates = events.filter(e => e.getTypeName() === 'UpdateRows');
  const deletes = events.filter(e => e.getTypeName() === 'DeleteRows');

  test.equal(writes.length, 2);
  test.equal(updates.length, 1);
  test.equal(deletes.length, 1);

  const row = writes[0].rows[0];
  test.equal(row.id, 1);
  test.strictSame(row.i_big, '9223372036854775807', 'exact BIGINT string');
  test.strictSame(row.u_big, '18446744073709551615', 'exact UNSIGNED string');
  test.strictSame(row.dec_col, '-12345678901234567.0123456789',
    'exact DECIMAL string');
  test.equal(row.vc, 'héllo wörld');
  test.equal(row.ch, 'abc');
  test.strictSame(row.bin_col, Buffer.from('deadbeef', 'hex'));
  test.strictSame(row.vb, Buffer.from('0102', 'hex'));
  test.equal(row.txt, 'text value');
  test.strictSame(row.blb, Buffer.from('cafe', 'hex'));
  test.equal(row.flt, 1.25);
  test.equal(row.dbl, -2.5);
  test.ok(row.dt instanceof Date);
  test.equal(row.dt.toISOString(), '2024-06-15T12:34:56.789Z',
    'DATETIME(3) with timezone Z');
  test.equal(row.ts, '2024-06-15 12:34:56',
    'TIMESTAMP as string via dateStrings');
  test.ok(row.d instanceof Date);
  test.equal(row.d.toISOString(), '2024-06-15T00:00:00.000Z');
  test.equal(row.t, '-01:02:03.500');
  test.equal(row.y, 2024);
  test.equal(row.e, 'b');
  if (exactEnumValues) {
    test.equal(row.e2, "c'd",
      'ENUM values containing commas and quotes decode exactly');
  }
  test.equal(row.s, 'x,z');
  test.strictSame(row.bt, Buffer.from([0x02, 0x01]), 'BIT(10) b1000000001');
  test.strictSame(row.js, {
    a: 1,
    big: '9223372036854775807',
    arr: ['x', true, null],
    d: 1.5,
  }, 'JSON as parsed object, 64-bit integer exact');
  test.strictSame(row.geo, { x: 1, y: 2 });
  test.equal(row.txt_latin1, 'café ñ', 'latin1 TEXT decoded via its charset');

  const change = updates[0].rows[0];
  test.equal(change.before.id, 1);
  test.equal(change.before.vc, 'héllo wörld');
  test.equal(change.after.id, 2);
  test.equal(change.after.vc, 'updated');

  test.equal(deletes[0].rows[0].id, 2);

  const nullRow = writes[1].rows[0];
  test.equal(nullRow.id, 3);
  for (const key of Object.keys(nullRow)) {
    if (key !== 'id') {
      test.equal(nullRow[key], null, `${key} is null`);
    }
  }
}

tap.test('event stream structure matches capture', test => {
  const events = decodeFixture(FIXTURE);
  test.strictSame(
    events.map(e => e.getTypeName()),
    FIXTURE.eventSummary,
    'decoded event types match the sequence observed at capture time');
  test.end();
});

tap.test('row values decode exactly (default mysql2 semantics)', test => {
  const events = decodeFixture(FIXTURE);
  assertCanonicalRows(test, events);
  test.end();
});

tap.test('binlog_row_metadata=FULL: events are self-describing', test => {
  test.strictSame(FIXTURE_FULLMETA.tableSchemas, {},
    'fixture carries no INFORMATION_SCHEMA data at all');

  const events = decodeFixture(FIXTURE_FULLMETA);
  test.strictSame(
    events.map(e => e.getTypeName()),
    FIXTURE_FULLMETA.eventSummary,
    'decoded event types match the sequence observed at capture time');

  const tableMaps = events.filter(e => e.getTypeName() === 'TableMap');
  test.ok(tableMaps.length > 0);
  tableMaps.forEach(tm => {
    test.ok(tm.hasSelfDescribingMetadata(), 'TableMap self-describing');
  });

  // Row values decode identically to the INFORMATION_SCHEMA path,
  // including the enum whose values defeat COLUMN_TYPE string parsing
  assertCanonicalRows(test, events, { exactEnumValues: true });
  test.end();
});

tap.test('binlog_row_metadata=FULL: synthesised column schemas', test => {
  const events = decodeFixture(FIXTURE_FULLMETA);
  const tm = events.find(e => e.getTypeName() === 'TableMap');
  const schemas = tm.buildColumnSchemas();
  const byName = Object.fromEntries(schemas.map(s => [s.COLUMN_NAME, s]));

  test.strictSame(tm.columnNames.slice(0, 4),
    ['id', 'i_big', 'u_big', 'dec_col']);
  test.equal(byName.id.COLUMN_TYPE, 'int');
  test.equal(byName.id.UNSIGNED, false);
  test.equal(byName.i_big.COLUMN_TYPE, 'bigint');
  test.equal(byName.u_big.COLUMN_TYPE, 'bigint unsigned');
  test.equal(byName.u_big.UNSIGNED, true);
  test.equal(byName.dec_col.COLUMN_TYPE, 'decimal(30,10)');
  test.equal(byName.vc.COLUMN_TYPE, 'varchar(20)',
    'character width recovered from byte width and charset');
  test.equal(byName.vc.CHARACTER_SET_NAME, 'utf8mb4');
  test.equal(byName.ch.COLUMN_TYPE, 'char(5)');
  test.equal(byName.bin_col.COLUMN_TYPE, 'binary(4)');
  test.equal(byName.bin_col.CHARACTER_SET_NAME, null);
  test.equal(byName.vb.COLUMN_TYPE, 'varbinary(8)');
  test.equal(byName.txt.COLUMN_TYPE, 'text');
  test.equal(byName.txt.CHARACTER_SET_NAME, 'utf8mb4');
  test.equal(byName.txt_latin1.CHARACTER_SET_NAME, 'latin1',
    'per-column charset from binlog metadata');
  test.equal(byName.blb.COLUMN_TYPE, 'blob');
  test.equal(byName.blb.CHARACTER_SET_NAME, null);
  test.strictSame(byName.e.ENUM_VALUES, ['a', 'b', 'c']);
  test.strictSame(byName.e2.ENUM_VALUES, ['a,b', "c'd", 'plain'],
    'enum values with commas and quotes survive');
  test.equal(byName.e2.COLUMN_TYPE, "enum('a,b','c''d','plain')");
  test.strictSame(byName.s.SET_VALUES, ['x', 'y', 'z']);
  test.equal(byName.bt.COLUMN_TYPE, 'bit(10)');
  test.equal(byName.dt.COLUMN_TYPE, 'datetime(3)');
  test.equal(byName.ts.COLUMN_TYPE, 'timestamp');
  test.equal(byName.js.COLUMN_TYPE, 'json');
  test.equal(byName.geo.COLUMN_TYPE, 'geometry');

  test.strictSame(tm.primaryKey, [0], 'primary key column indexes');
  test.ok(tm.columnVisibility.every(Boolean), 'all columns visible');
  test.equal(tm.signedness[2], true, 'u_big signedness bit');
  test.equal(tm.signedness[4], undefined,
    'non-numeric columns carry no signedness');
  test.end();
});

tap.test('malformed optional metadata falls back to fetched schemas', test => {
  const zongji = new ZongJi({});
  zongji.useChecksum = FIXTURE_FULLMETA.useChecksum;
  zongji.connection = { config: { ...FIXTURE_FULLMETA.connectionConfig } };
  const BinlogPacket = initBinlogPacketClass(zongji);

  const tableMapIndex = FIXTURE_FULLMETA.eventSummary.indexOf('TableMap');
  const buffer = Buffer.from(FIXTURE_FULLMETA.packets[tableMapIndex], 'hex');

  // Locate the SIGNEDNESS field (type byte 0x01, length 0x01 for this
  // table) near the end of the event and corrupt its length so the field
  // parser would read into the next field
  let corrupted = null;
  for (let i = buffer.length - 1; i > 0; i--) {
    if (buffer[i] === 0x01 && buffer[i + 1] === 0x01) {
      corrupted = Buffer.from(buffer);
      corrupted[i + 1] = 0xf0; // absurd length, overruns the event
      break;
    }
  }
  test.ok(corrupted, 'found the SIGNEDNESS field to corrupt');

  const parser = new Parser(
    { buffer: corrupted, offset: 0, end: corrupted.length });
  const binlogPacket = new BinlogPacket();
  binlogPacket.parse(parser);
  const event = binlogPacket.getEvent();

  test.equal(event.getTypeName(), 'TableMap',
    'event still parses (metadata is optional)');
  test.equal(event.hasSelfDescribingMetadata(), false,
    'corrupt metadata is discarded entirely');
  test.equal(event.signedness, undefined);
  test.equal(event.primaryKey, undefined);
  test.end();
});

tap.test('binlog_row_metadata=MINIMAL fixture still uses fetched schemas',
  test => {
    const events = decodeFixture(FIXTURE);
    const tm = events.find(e => e.getTypeName() === 'TableMap');
    test.equal(tm.hasSelfDescribingMetadata(), false,
      'MINIMAL metadata has no column names');
    test.ok(tm.signedness, 'signedness still parsed under MINIMAL');
    test.equal(tm.signedness[2], true, 'u_big unsigned from binlog');
    test.end();
  });

tap.test('decimalNumbers and jsonStrings connection options', test => {
  // Options behave identically with either metadata source
  for (const fixture of [FIXTURE, FIXTURE_FULLMETA]) {
    const events = decodeFixture(fixture, {
      decimalNumbers: true,
      jsonStrings: true,
    });
    const row = events.find(e => e.getTypeName() === 'WriteRows').rows[0];

    test.type(row.dec_col, 'number', 'DECIMAL as Number with decimalNumbers');
    test.equal(row.dec_col, parseFloat('-12345678901234567.0123456789'));

    test.type(row.js, 'string', 'JSON as string with jsonStrings');
    test.match(row.js, /"big": 9223372036854775807\s*[,}]/,
      '64-bit integer serialised as a raw JSON numeral, not a quoted string');
    const parsed = JSON.parse(row.js);
    test.equal(parsed.a, 1);
    test.strictSame(parsed.arr, ['x', true, null]);
    test.equal(parsed.d, 1.5);
  }
  test.end();
});

tap.test('non-row events decode', test => {
  const events = decodeFixture(FIXTURE);

  const queries = events.filter(e => e.getTypeName() === 'Query');
  test.ok(queries.some(q => /CREATE TABLE/i.test(q.query)),
    'CREATE TABLE query event');
  test.ok(queries.every(q => q.schema === FIXTURE.schemaName));

  const xids = events.filter(e => e.getTypeName() === 'Xid');
  test.ok(xids.length >= 1);
  xids.forEach(x => test.type(x.xid, 'number'));

  const gtids = events.filter(e => e.getTypeName() === 'Gtid');
  gtids.forEach(g => {
    test.match(g.gtid, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}:\d+$/);
  });

  const rotates = events.filter(e => e.getTypeName() === 'Rotate');
  test.ok(rotates.length >= 2, 'fake rotate at start plus FLUSH LOGS');
  rotates.forEach(r => test.match(r.binlogName, /\.\d+$/));

  const previous = events.filter(e => e.getTypeName() === 'PreviousGtids');
  previous.forEach(p => test.type(p.gtidSet, 'string'));

  test.end();
});

tap.test('truncated packet surfaces a parse error via getEvent', test => {
  const zongji = new ZongJi({});
  zongji.useChecksum = FIXTURE.useChecksum;
  zongji.connection = { config: { ...FIXTURE.connectionConfig } };
  const BinlogPacket = initBinlogPacketClass(zongji);

  // Replay up to and including the first TableMap so the rows event has
  // metadata, then truncate the WriteRows packet body
  const writeIndex = FIXTURE.eventSummary.indexOf('WriteRows');
  for (let i = 0; i < writeIndex; i++) {
    const buffer = Buffer.from(FIXTURE.packets[i], 'hex');
    const parser = new Parser({ buffer, offset: 0, end: buffer.length });
    const binlogPacket = new BinlogPacket();
    binlogPacket.parse(parser);
    const event = binlogPacket.getEvent();
    if (event.getTypeName() === 'TableMap') {
      zongji.tableMap[event.tableId] = {
        columnSchemas: FIXTURE.tableSchemas[event.tableName],
        parentSchema: event.schemaName,
        tableName: event.tableName,
      };
      event.updateColumnInfo();
    }
  }

  const full = Buffer.from(FIXTURE.packets[writeIndex], 'hex');
  const truncated = full.subarray(0, 40);
  const parser = new Parser(
    { buffer: truncated, offset: 0, end: truncated.length });
  const binlogPacket = new BinlogPacket();
  binlogPacket.parse(parser);
  test.throws(() => binlogPacket.getEvent(),
    'corrupt packet throws instead of returning garbage');
  test.end();
});
