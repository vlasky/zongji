class ComBinlog {
  constructor({ serverId, nonBlock, filename, position }) {
    this.command = 0x12;
    this.position = position || 4;

    // will send eof package if there is no more binlog event
    // https://dev.mysql.com/doc/internals/en/com-binlog-dump.html#binlog-dump-non-block
    this.flags = nonBlock ? 1 : 0;

    this.serverId = serverId || 1;
    this.filename = filename || '';
  }

  write(writer) {
    writer.writeUnsignedNumber(1, this.command);
    writer.writeUnsignedNumber(4, this.position);
    writer.writeUnsignedNumber(2, this.flags);
    writer.writeUnsignedNumber(4, this.serverId);
    writer.writeNullTerminatedString(this.filename);
  }

  parse() {
    throw new Error('should never be called here');
  }
}

export default ComBinlog;
