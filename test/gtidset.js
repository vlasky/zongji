// Offline unit tests for the GTID set model (lib/gtid_set.js)
import tap from 'tap';

import { GtidSet } from '../lib/gtid_set.js';
import { MariadbGtidPosition } from '../lib/mariadb_gtid.js';
import { PreviousGtids } from '../lib/binlog_event.js';
import { Parser } from '../lib/reader.js';

const UUID_A = '3e11fa47-71ca-11e1-9e33-c80aa9429562';
const UUID_B = '2c256447-3f0d-431b-9a25-bddf1f1f6ef6';

tap.test('parse and toString round-trip', test => {
  const cases = [
    '',
    `${UUID_A}:1-5`,
    `${UUID_A}:1-5:11-18`,
    `${UUID_B}:1-27,${UUID_A}:1-5:8`,
  ];
  for (const text of cases) {
    const canonical = GtidSet.parse(text).toString();
    test.equal(GtidSet.parse(canonical).toString(), canonical,
      `'${text}' round-trips`);
  }
  test.equal(GtidSet.parse('').isEmpty(), true);
  test.equal(GtidSet.parse(`${UUID_A}:7`).toString(), `${UUID_A}:7`,
    'single transaction has no range dash');
  test.equal(
    GtidSet.parse(` ${UUID_A.toUpperCase()} : 1-3 `.replace(/ /g, ''))
      .toString(),
    `${UUID_A}:1-3`, 'uuids normalise to lowercase');
  test.end();
});

tap.test('add coalesces intervals', test => {
  const set = GtidSet.parse(`${UUID_A}:1-5`);
  set.add(`${UUID_A}:6`);
  test.equal(set.toString(), `${UUID_A}:1-6`, 'adjacent gno extends');
  set.add(`${UUID_A}:9`);
  test.equal(set.toString(), `${UUID_A}:1-6:9`, 'gap starts a new interval');
  set.add(`${UUID_A}:8`);
  test.equal(set.toString(), `${UUID_A}:1-6:8-9`);
  set.add(`${UUID_A}:7`);
  test.equal(set.toString(), `${UUID_A}:1-9`, 'bridging gno merges intervals');
  set.add(`${UUID_A}:3`);
  test.equal(set.toString(), `${UUID_A}:1-9`, 'duplicate is a no-op');
  set.add(`${UUID_B}:1`);
  test.equal(set.toString(), `${UUID_B}:1,${UUID_A}:1-9`,
    'sids sort lexicographically');
  test.end();
});

tap.test('invalid input rejected', test => {
  test.throws(() => GtidSet.parse('not-a-uuid:1-5'));
  test.throws(() => GtidSet.parse(UUID_A), 'missing intervals');
  test.throws(() => GtidSet.parse(`${UUID_A}:5-1`), 'descending interval');
  test.throws(() => GtidSet.parse(`${UUID_A}:0`), 'gno must be >= 1');
  test.throws(() => GtidSet.parse(`${UUID_A}:1-2-3`));
  test.throws(() => new GtidSet().add('no-colon'));
  // Decimal digits only, per the MySQL GTID grammar
  test.throws(() => GtidSet.parse(`${UUID_A}:1e3`), 'exponent notation');
  test.throws(() => GtidSet.parse(`${UUID_A}:0x10`), 'hex notation');
  test.throws(() => GtidSet.parse(`${UUID_A}:1.0`), 'decimal point');
  test.throws(() => GtidSet.parse(`${UUID_A}:9007199254740993`),
    'beyond Number.MAX_SAFE_INTEGER');
  test.end();
});

tap.test('encode matches the Previous_gtids wire format', test => {
  // PreviousGtids (lib/binlog_event.js) decodes this same encoding from
  // real server packets, so decoding our own bytes with it proves the
  // formats agree
  const text = `${UUID_B}:1-27,${UUID_A}:1-5:8`;
  const encoded = GtidSet.parse(text).encode();

  // Simulate the event body: 19-byte header already consumed by the time
  // PreviousGtids reads the sid block, so hand the parser the block alone
  const parser = new Parser({
    buffer: encoded, offset: 0, end: encoded.length,
  });
  const event = new PreviousGtids(parser,
    { timestamp: 0, nextPosition: 0, size: encoded.length },
    { useChecksum: false });

  test.equal(event.gtidSet, text, 'PreviousGtids decodes our encoding');
  test.end();
});

tap.test('encode layout details', test => {
  const encoded = GtidSet.parse(`${UUID_A}:1-5`).encode();
  test.equal(encoded.length, 8 + 16 + 8 + 16);
  test.equal(encoded.readBigUInt64LE(0), 1n, 'n_sids');
  test.equal(encoded.subarray(8, 24).toString('hex'),
    UUID_A.replace(/-/g, ''), 'binary uuid');
  test.equal(encoded.readBigUInt64LE(24), 1n, 'n_intervals');
  test.equal(encoded.readBigUInt64LE(32), 1n, 'interval start');
  test.equal(encoded.readBigUInt64LE(40), 6n, 'interval end is exclusive');
  test.equal(GtidSet.parse('').encode().length, 8,
    'empty set encodes as zero sids');
  test.end();
});

tap.test('MariadbGtidPosition', test => {
  test.test('parse round-trips', test => {
    for (const text of ['', '0-1-5', '0-1-5,1-2-10', '2-4294967295-9007199254740991']) {
      test.equal(MariadbGtidPosition.parse(text).toString(), text);
    }
    // Whitespace tolerated, output sorted by domain
    test.equal(MariadbGtidPosition.parse(' 1-2-3 , 0-1-5 ').toString(),
      '0-1-5,1-2-3');
    // seq_no beyond 2^53 survives exactly
    test.equal(MariadbGtidPosition.parse('0-1-18446744073709551615').toString(),
      '0-1-18446744073709551615');
    test.end();
  });

  test.test('invalid positions are rejected', test => {
    const bad = ['0-1', '0-1-2-3', 'a-1-2', '1e3-1-1', '0x10-1-1',
      '0-1-1.0', '4294967296-1-1', '0-1-18446744073709551616',
      '0-1-5,0-2-6' /* duplicate domain */];
    for (const text of bad) {
      test.throws(() => MariadbGtidPosition.parse(text), text);
    }
    test.end();
  });

  test.test('add overwrites the domain watermark', test => {
    const position = MariadbGtidPosition.parse('0-1-5');
    position.add({ domainId: 0, serverId: 2, seqNo: 3 });
    // Deliberately not a max: "last processed" wins after a failover
    test.equal(position.toString(), '0-2-3');
    position.add({ domainId: 7, serverId: 1, seqNo: 1 });
    test.equal(position.toString(), '0-2-3,7-1-1');
    test.end();
  });

  test.test('fromGtidList keeps the last entry per domain', test => {
    const position = MariadbGtidPosition.fromGtidList([
      { domainId: 0, serverId: 1, seqNo: 5 },
      { domainId: 1, serverId: 1, seqNo: 2 },
      { domainId: 0, serverId: 3, seqNo: 4 },
    ]);
    test.equal(position.toString(), '0-3-4,1-1-2');
    test.end();
  });

  test.test('isEmpty', test => {
    test.equal(MariadbGtidPosition.parse('').isEmpty(), true);
    test.equal(MariadbGtidPosition.parse('0-1-1').isEmpty(), false);
    test.end();
  });

  test.end();
});
