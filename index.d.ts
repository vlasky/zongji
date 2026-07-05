import { EventEmitter } from 'events';
import { Connection, Pool, ConnectionOptions, PoolOptions } from 'mysql2';

// Configuration options for ZongJi
export interface ZongJiOptions {
  /** Unique server ID for the binlog connection (default: 1) */
  serverId?: number;
  /** If true, start reading from the end of the binlog */
  startAtEnd?: boolean;
  /** Binlog filename to start from */
  filename?: string;
  /** Binlog position to start from */
  position?: number;
  /**
   * Executed GTIDs to resume from (e.g. a persisted zongji.gtidSet): a
   * MySQL GTID set ('uuid:1-5,...') or a MariaDB GTID position
   * ('0-1-1234,...'), matching the server flavour. The server locates
   * the right binlog file and skips transactions already processed
   * (MySQL: COM_BINLOG_DUMP_GTID, requires gtid_mode=ON; MariaDB:
   * @slave_connect_state, always available), so this works across
   * failover to another server in the same topology. '' streams the
   * server's entire available history. Takes precedence over
   * filename/position.
   */
  gtidSet?: string;
  /** If true, use non-blocking mode */
  nonBlock?: boolean;
  /** List of event types to include (e.g., ['tablemap', 'writerows']) */
  includeEvents?: string[];
  /** List of event types to exclude */
  excludeEvents?: string[];
  /** Schema/table filter for inclusion. Use `true` for all tables in a schema, or array of table names */
  includeSchema?: Record<string, string[] | true>;
  /** Schema/table filter for exclusion */
  excludeSchema?: Record<string, string[] | true>;
}

// Column metadata, either fetched from INFORMATION_SCHEMA or synthesised
// from the binlog's own TableMap metadata (binlog_row_metadata=FULL).
// In the synthesised form COLUMN_TYPE is approximate for character columns
// (no display width) and COLLATION_NAME/COLUMN_COMMENT are not available.
export interface ColumnSchema {
  COLUMN_NAME: string;
  COLLATION_NAME: string | null;
  CHARACTER_SET_NAME: string | null;
  COLUMN_COMMENT: string;
  COLUMN_TYPE: string;
  /** Exact signedness from binlog metadata (MySQL 8.0+); numeric columns only */
  UNSIGNED?: boolean;
  /** ENUM value list from binlog metadata (binlog_row_metadata=FULL) */
  ENUM_VALUES?: string[];
  /** SET value list from binlog metadata (binlog_row_metadata=FULL) */
  SET_VALUES?: string[];
}

// Column information from TableMap event
export interface ColumnInfo {
  name: string;
  charset: string | null;
  type: number;
  metadata: Record<string, unknown>;
}

// Table metadata cached by ZongJi
export interface TableMapEntry {
  columnSchemas: ColumnSchema[];
  parentSchema: string;
  tableName: string;
  columns?: ColumnInfo[];
}

// Base binlog event class
export interface BinlogEvent {
  /** Timestamp of the event in milliseconds */
  timestamp: number;
  /** Position in the binlog after this event */
  nextPosition: number;
  /** Size of the event in bytes */
  size: number;
  /**
   * GTID of the transaction this event belongs to ('uuid:sequence'),
   * when the server runs with gtid_mode=ON. Undefined for anonymous
   * transactions and for events seen before the first GTID event of the
   * stream. On Gtid/AnonymousGtid events this is their own parsed value.
   */
  gtid?: string;
  /** Get the lowercase event name */
  getEventName(): string;
  /** Get the event class name */
  getTypeName(): string;
  /** Print event details to console */
  dump(): void;
}

// Rotate event - indicates binlog file change
export interface RotateEvent extends BinlogEvent {
  getTypeName(): 'Rotate';
  getEventName(): 'rotate';
  /** Position in the new binlog file */
  position: number;
  /** Name of the new binlog file */
  binlogName: string;
}

// Format Description event
export interface FormatEvent extends BinlogEvent {
  getTypeName(): 'Format';
  getEventName(): 'format';
}

// GTID event
export interface GtidEvent extends BinlogEvent {
  getTypeName(): 'Gtid';
  getEventName(): 'gtid';
  /** GTID flags */
  flags: number;
  /** Source UUID */
  sid: string;
  /** Group number (exact string beyond Number.MAX_SAFE_INTEGER) */
  gno: number | string;
  /** Full GTID string (sid:gno) */
  gtid: string;
}

// Anonymous GTID event
export interface AnonymousGtidEvent extends BinlogEvent {
  getTypeName(): 'AnonymousGtid';
  getEventName(): 'anonymousgtid';
  /** GTID flags */
  flags: number;
  /** Source UUID */
  sid: string;
  /** Group number (exact string beyond Number.MAX_SAFE_INTEGER) */
  gno: number | string;
  /** Full GTID string (sid:gno) */
  gtid: string;
}

// Previous GTIDs event
export interface GtidInterval {
  start: number;
  end: number;
}

export interface GtidSidEntry {
  sid: string;
  intervals: GtidInterval[];
}

export interface PreviousGtidsEvent extends BinlogEvent {
  getTypeName(): 'PreviousGtids';
  getEventName(): 'previousgtids';
  /** Array of SID entries with their intervals */
  sids: GtidSidEntry[];
  /** GTID set as a formatted string */
  gtidSet: string;
}

// XID (commit) event
export interface XidEvent extends BinlogEvent {
  getTypeName(): 'Xid';
  getEventName(): 'xid';
  /** Transaction ID for 2PC */
  xid: number | string;
}

// Query event
export interface QueryEvent extends BinlogEvent {
  getTypeName(): 'Query';
  getEventName(): 'query';
  /** Slave proxy ID */
  slaveProxyId: number;
  /** Time in seconds the query took to execute */
  executionTime: number;
  /** Length of the schema name */
  schemaLength: number;
  /** Error code (0 for success) */
  errorCode: number;
  /** Length of status variables */
  statusVarsLength: number;
  /** Status variables */
  statusVars: string;
  /** Database/schema name */
  schema: string;
  /** The SQL query */
  query: string;
}

// IntVar event (for statement-based replication)
export interface IntVarEvent extends BinlogEvent {
  getTypeName(): 'IntVar';
  getEventName(): 'intvar';
  /** Variable type: 1=LAST_INSERT_ID, 2=INSERT_ID */
  type: number;
  /** The integer value */
  value: number | string;
  /** Get the variable type name */
  getIntTypeName(): string;
}

// TableMap event
export interface TableMapEvent extends BinlogEvent {
  getTypeName(): 'TableMap';
  getEventName(): 'tablemap';
  /** Internal table ID */
  tableId: number;
  /** Table flags */
  flags: number;
  /** Database/schema name */
  schemaName: string;
  /** Table name */
  tableName: string;
  /** Number of columns */
  columnCount: number;
  /** Array of MySQL type codes for each column */
  columnTypes: number[];
  /** Column metadata */
  columnsMetadata: Record<string, unknown>[];
  /** Reference to the tableMap cache */
  tableMap: Record<number, TableMapEntry>;
  /**
   * Column names carried by the event itself (MySQL 8.0+ with
   * binlog_row_metadata=FULL)
   */
  columnNames?: string[];
  /**
   * Per-column signedness from binlog metadata (MySQL 8.0+, MINIMAL and
   * FULL); true = unsigned. Undefined entries are non-numeric columns.
   */
  signedness?: (boolean | undefined)[];
  /**
   * Primary key column indexes (0-based, all-columns numbering) from
   * binlog_row_metadata=FULL
   */
  primaryKey?: number[];
  /**
   * Per-column visibility from binlog_row_metadata=FULL (MySQL 8.0.23+);
   * false = INVISIBLE column
   */
  columnVisibility?: boolean[];
  /**
   * Per-column geometry subtype from binlog metadata (0 = geometry,
   * 1 = point, ...); undefined entries are non-spatial columns
   */
  geometryTypes?: (number | undefined)[];
  /**
   * True when the event carries binlog_row_metadata=FULL metadata, in
   * which case zongji decodes rows without querying INFORMATION_SCHEMA
   */
  hasSelfDescribingMetadata(): boolean;
  /**
   * True when the table contains classic temporal type codes, which on
   * MariaDB may hide 5.3 "hires" columns that binlog metadata cannot
   * reveal; such tables use the INFORMATION_SCHEMA path even under FULL
   */
  hasAmbiguousTemporalColumns(): boolean;
  /** Build ColumnSchema entries from the event's own metadata (FULL only) */
  buildColumnSchemas(): ColumnSchema[];
  /** Update column info after table metadata is available */
  updateColumnInfo(): void;
}

// Row data type - key is column name, value is column value
export type RowData = Record<string, unknown>;

// Update row with before/after values
export interface UpdateRowData {
  before: RowData;
  after: RowData;
}

// Base rows event
export interface RowsEvent extends BinlogEvent {
  /** Internal table ID */
  tableId: number;
  /** Event flags */
  flags: number;
  /** Number of columns */
  numberOfColumns: number;
  /** Reference to the tableMap cache */
  tableMap: Record<number, TableMapEntry>;
  /** Whether checksum is enabled */
  useChecksum: boolean;
}

// WriteRows event (INSERT)
export interface WriteRowsEvent extends RowsEvent {
  getTypeName(): 'WriteRows';
  getEventName(): 'writerows';
  /** Array of inserted rows */
  rows: RowData[];
}

// DeleteRows event (DELETE)
export interface DeleteRowsEvent extends RowsEvent {
  getTypeName(): 'DeleteRows';
  getEventName(): 'deleterows';
  /** Array of deleted rows */
  rows: RowData[];
}

// UpdateRows event (UPDATE)
export interface UpdateRowsEvent extends RowsEvent {
  getTypeName(): 'UpdateRows';
  getEventName(): 'updaterows';
  /** Array of updated rows with before/after values */
  rows: UpdateRowData[];
}

// Transaction Payload event (MySQL 8.0.20+, binlog_transaction_compression=ON)
// The compressed transaction body cannot be decoded and is skipped.
export interface TransactionPayloadEvent extends BinlogEvent {
  getTypeName(): 'TransactionPayload';
  getEventName(): 'transactionpayload';
}

// Partial Update Rows event (MySQL 8.0+, binlog_row_value_options=PARTIAL_JSON)
// The partial JSON diff body cannot be decoded and is skipped.
export interface PartialUpdateRowsEvent extends BinlogEvent {
  getTypeName(): 'PartialUpdateRows';
  getEventName(): 'partialupdaterows';
}

// Heartbeat event - sent while the connection idles (when a heartbeat
// period is configured) and after transactions were skipped server-side
// during a GTID dump; nextPosition carries the advanced position
export interface HeartbeatEvent extends BinlogEvent {
  getTypeName(): 'Heartbeat';
  getEventName(): 'heartbeat';
  /** Current binlog filename */
  binlogName: string;
  /**
   * Heartbeat position beyond 4 GiB (MariaDB only: sent in a sub-header
   * when the u32 nextPosition cannot represent it, which is then 0)
   */
  position?: number | string;
}

// MariaDB GTID event (code 162) - replaces the BEGIN Query event of a
// transaction (standalone=false) or marks a standalone group such as DDL
export interface MariadbGtidEvent extends BinlogEvent {
  getTypeName(): 'MariadbGtid';
  getEventName(): 'mariadbgtid';
  /** Sequence number within the domain (exact string beyond 2^53) */
  seqNo: number | string;
  /** Replication domain id */
  domainId: number;
  /** Originating server id (from the event header) */
  serverId: number;
  /** Raw flags2 byte */
  flags2: number;
  /** True for standalone groups (DDL, ...) with no terminating commit */
  standalone: boolean;
  /** True when the group can be safely rolled back */
  transactional: boolean;
  /** True when the group contains DDL */
  isDdl: boolean;
  /** XA PREPARE group; XID fields present */
  preparedXa: boolean;
  /** XA COMMIT/ROLLBACK group; XID fields present */
  completedXa: boolean;
  /** Group-commit id (same for all members of one group commit) */
  commitId?: number | string;
  /** XA format id, when preparedXa/completedXa */
  xidFormatId?: number;
  /** XA gtrid, when preparedXa/completedXa */
  xidGtrid?: Buffer;
  /** XA bqual, when preparedXa/completedXa */
  xidBqual?: Buffer;
  /** Raw flags_extra byte, when present */
  flagsExtra?: number;
  /** Number of extra engines, when FL_EXTRA_MULTI_ENGINE is set */
  extraEngines?: number;
  /** Start-alter sequence number, for COMMIT/ROLLBACK ALTER groups */
  saSeqNo?: number | string;
  /** Thread id of the originating connection (MariaDB 11.5+) */
  threadId?: number;
  /** Full GTID string (domain-server-sequence) */
  gtid: string;
}

export interface MariadbGtidListEntry {
  domainId: number;
  serverId: number;
  seqNo: number | string;
  /** Full GTID string (domain-server-sequence) */
  gtid: string;
}

// MariaDB GTID list event (code 163) - at the start of every binlog file,
// the last GTID per (domain, server) seen so far; MariaDB's analogue of
// MySQL's Previous_gtids
export interface MariadbGtidListEvent extends BinlogEvent {
  getTypeName(): 'MariadbGtidList';
  getEventName(): 'mariadbgtidlist';
  count: number;
  /** High 4 bits of the count word (FLAG_UNTIL_REACHED, FLAG_IGN_GTIDS) */
  flags: number;
  gtids: MariadbGtidListEntry[];
}

// MariaDB binlog checkpoint event (code 161) - XA-recovery marker naming
// the oldest binlog file that may still be needed for crash recovery
export interface BinlogCheckpointEvent extends BinlogEvent {
  getTypeName(): 'BinlogCheckpoint';
  getEventName(): 'binlogcheckpoint';
  binlogName: string;
}

// MariaDB annotate rows event (code 160) - the SQL statement text for the
// row events that follow
export interface AnnotateRowsEvent extends BinlogEvent {
  getTypeName(): 'AnnotateRows';
  getEventName(): 'annotaterows';
  statement: string;
}

// MariaDB start encryption event (code 164) - informational; the dump
// thread decrypts server-side and the stream itself is cleartext
export interface StartEncryptionEvent extends BinlogEvent {
  getTypeName(): 'StartEncryption';
  getEventName(): 'startencryption';
  scheme: number;
  keyVersion: number;
  nonce: Buffer;
}

// XA prepare event (code 38, MySQL 5.7+ and MariaDB) - terminates an
// XA-prepared event group
export interface XaPrepareEvent extends BinlogEvent {
  getTypeName(): 'XaPrepare';
  getEventName(): 'xaprepare';
  /** XA COMMIT ... ONE PHASE (commits immediately) */
  onePhase: boolean;
  xidFormatId: number;
  xidGtrid: Buffer;
  xidBqual: Buffer;
}

// Unknown event type
export interface UnknownEvent extends BinlogEvent {
  getTypeName(): 'Unknown';
  getEventName(): 'unknown';
}

// Union type of all event types
export type AnyBinlogEvent =
  | RotateEvent
  | FormatEvent
  | GtidEvent
  | AnonymousGtidEvent
  | PreviousGtidsEvent
  | XidEvent
  | QueryEvent
  | IntVarEvent
  | TableMapEvent
  | WriteRowsEvent
  | DeleteRowsEvent
  | UpdateRowsEvent
  | TransactionPayloadEvent
  | PartialUpdateRowsEvent
  | HeartbeatEvent
  | MariadbGtidEvent
  | MariadbGtidListEvent
  | BinlogCheckpointEvent
  | AnnotateRowsEvent
  | StartEncryptionEvent
  | XaPrepareEvent
  | UnknownEvent;

/** Union of all possible getTypeName() return values (e.g. 'Rotate', 'WriteRows') */
export type BinlogEventTypeName = ReturnType<AnyBinlogEvent['getTypeName']>;

/** Union of all possible getEventName() return values (e.g. 'rotate', 'writerows') */
export type BinlogEventName = ReturnType<AnyBinlogEvent['getEventName']>;

/**
 * Look up the concrete event type for a getTypeName() value.
 * Enables narrowing AnyBinlogEvent via getTypeName(), e.g.:
 *
 *   function isEventType<N extends BinlogEventTypeName>(
 *     event: AnyBinlogEvent, name: N
 *   ): event is BinlogEventByTypeName<N> {
 *     return event.getTypeName() === name;
 *   }
 *
 * (A plain `switch (event.getTypeName())` cannot narrow `event` because
 * TypeScript does not narrow unions on method-call discriminants.)
 */
export type BinlogEventByTypeName<N extends BinlogEventTypeName> = Extract<
  AnyBinlogEvent,
  { getTypeName(): N }
>;

/** Look up the concrete event type for a getEventName() value */
export type BinlogEventByName<N extends BinlogEventName> = Extract<
  AnyBinlogEvent,
  { getEventName(): N }
>;

// Connection options - can be mysql2 options, Connection, or Pool
export type ZongJiDsn = string | ConnectionOptions | PoolOptions | Connection | Pool;

// Main ZongJi class
declare class ZongJi extends EventEmitter {
  /** Cached table metadata */
  tableMap: Record<number, TableMapEntry>;
  /** Whether ZongJi is ready to receive events */
  ready: boolean;
  /** Whether ZongJi has been stopped */
  stopped: boolean;
  /** Whether binlog checksum is enabled */
  useChecksum: boolean;
  /**
   * Server version string as reported by SELECT VERSION(), e.g.
   * '8.4.5' or '11.8.8-MariaDB-ubu2404-log'. Set during start()
   * initialisation, before the 'ready' event.
   */
  serverVersion: string | undefined;
  /** True when the connected server is MariaDB (set during start()) */
  isMariaDb: boolean;
  /** Current binlog options */
  options: {
    serverId?: number;
    filename?: string;
    position?: number;
    startAtEnd?: boolean;
    gtidSet?: string;
    nonBlock?: boolean;
  };
  /**
   * The transactions this instance knows to be processed: the start()
   * seed plus every transaction whose commit has been observed. A MySQL
   * GTID set ('uuid:1-5,...') or a MariaDB GTID position ('0-1-1234,...')
   * depending on the connected server. Persist it and pass to
   * start({ gtidSet }) to resume, including on a different server.
   * Undefined when no exact seed was available (a mid-file file+position
   * start).
   */
  readonly gtidSet: string | undefined;
  /** Current filter settings */
  filters: {
    includeEvents?: string[];
    excludeEvents?: string[];
    includeSchema?: Record<string, string[] | true>;
    excludeSchema?: Record<string, string[] | true>;
  };
  /** The control connection (for metadata queries) */
  ctrlConnection: Connection | null;
  /** The binlog streaming connection */
  connection: Connection | null;

  /**
   * Create a new ZongJi instance
   * @param dsn - Connection string, options object, or existing Connection/Pool
   */
  constructor(dsn: ZongJiDsn);

  /**
   * Start listening to the binlog
   * @param options - Configuration options
   */
  start(options?: ZongJiOptions): void;

  /**
   * Stop listening to the binlog
   */
  stop(): void;

  /**
   * Get current option value(s)
   * @param name - Option name or array of names
   */
  get(name: string): unknown;
  get(name: string[]): Record<string, unknown>;

  // Event emitter overloads for type safety
  on(event: 'binlog', listener: (event: AnyBinlogEvent) => void): this;
  on(event: 'ready', listener: () => void): this;
  on(event: 'stopped', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;

  once(event: 'binlog', listener: (event: AnyBinlogEvent) => void): this;
  once(event: 'ready', listener: () => void): this;
  once(event: 'stopped', listener: () => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: string, listener: (...args: unknown[]) => void): this;

  emit(event: 'binlog', binlogEvent: AnyBinlogEvent): boolean;
  emit(event: 'ready'): boolean;
  emit(event: 'stopped'): boolean;
  emit(event: 'error', error: Error): boolean;
  emit(event: string, ...args: unknown[]): boolean;
}

export default ZongJi;
