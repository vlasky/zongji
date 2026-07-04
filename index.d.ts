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

// Column metadata from INFORMATION_SCHEMA
export interface ColumnSchema {
  COLUMN_NAME: string;
  COLLATION_NAME: string | null;
  CHARACTER_SET_NAME: string | null;
  COLUMN_COMMENT: string;
  COLUMN_TYPE: string;
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
  /** Group number */
  gno: number;
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
  /** Group number */
  gno: number;
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
  /** Update column info after fetching from INFORMATION_SCHEMA */
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
  /** Current binlog options */
  options: {
    serverId?: number;
    filename?: string;
    position?: number;
    startAtEnd?: boolean;
  };
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
