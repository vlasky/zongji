// Offline unit tests for the GTID set model (lib/gtid_set.js)
import tap from 'tap';

import { GtidSet } from '../lib/gtid_set.js';
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
