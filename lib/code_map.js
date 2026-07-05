import * as events from './binlog_event.js';
import * as rowsEvents from './rows_event.js';

const CodeEvent = [
  'UNKNOWN_EVENT',
  'START_EVENT_V3',
  'QUERY_EVENT',
  'STOP_EVENT',
  'ROTATE_EVENT',
  'INTVAR_EVENT',
  'LOAD_EVENT',
  'SLAVE_EVENT',
  'CREATE_FILE_EVENT',
  'APPEND_BLOCK_EVENT',
  'EXEC_LOAD_EVENT',
  'DELETE_FILE_EVENT',
  'NEW_LOAD_EVENT',
  'RAND_EVENT',
  'USER_VAR_EVENT',
  'FORMAT_DESCRIPTION_EVENT',
  'XID_EVENT',
  'BEGIN_LOAD_QUERY_EVENT',
  'EXECUTE_LOAD_QUERY_EVENT',
  'TABLE_MAP_EVENT',
  'PRE_GA_DELETE_ROWS_EVENT',
  'PRE_GA_UPDATE_ROWS_EVENT',
  'PRE_GA_WRITE_ROWS_EVENT',
  'WRITE_ROWS_EVENT_V1',
  'UPDATE_ROWS_EVENT_V1',
  'DELETE_ROWS_EVENT_V1',
  'INCIDENT_EVENT',
  'HEARTBEAT_LOG_EVENT',
  'IGNORABLE_LOG_EVENT',
  'ROWS_QUERY_LOG_EVENT',
  'WRITE_ROWS_EVENT_V2',
  'UPDATE_ROWS_EVENT_V2',
  'DELETE_ROWS_EVENT_V2',
  'GTID_LOG_EVENT',
  'ANONYMOUS_GTID_LOG_EVENT',
  'PREVIOUS_GTIDS_LOG_EVENT',
  'TRANSACTION_CONTEXT_EVENT',
  'VIEW_CHANGE_EVENT',
  'XA_PREPARE_LOG_EVENT',
  'PARTIAL_UPDATE_ROWS_EVENT',
  'TRANSACTION_PAYLOAD_EVENT',
  'HEARTBEAT_LOG_EVENT_V2',
  'GTID_TAGGED_LOG_EVENT'
];

// MariaDB-specific event codes (sql/log_event.h enum Log_event_type).
// The GTID names are prefixed to avoid clashing with MySQL's
// GTID_LOG_EVENT (33): MariaDB's own enum calls 162/163 GTID_EVENT and
// GTID_LIST_EVENT.
CodeEvent[160] = 'ANNOTATE_ROWS_EVENT';
CodeEvent[161] = 'BINLOG_CHECKPOINT_EVENT';
CodeEvent[162] = 'MARIADB_GTID_EVENT';
CodeEvent[163] = 'MARIADB_GTID_LIST_EVENT';
CodeEvent[164] = 'START_ENCRYPTION_EVENT';
CodeEvent[165] = 'QUERY_COMPRESSED_EVENT';
CodeEvent[166] = 'WRITE_ROWS_COMPRESSED_EVENT_V1';
CodeEvent[167] = 'UPDATE_ROWS_COMPRESSED_EVENT_V1';
CodeEvent[168] = 'DELETE_ROWS_COMPRESSED_EVENT_V1';
CodeEvent[169] = 'WRITE_ROWS_COMPRESSED_EVENT';
CodeEvent[170] = 'UPDATE_ROWS_COMPRESSED_EVENT';
CodeEvent[171] = 'DELETE_ROWS_COMPRESSED_EVENT';

const EventClass = {
  UNKNOWN_EVENT: events.Unknown,
  QUERY_EVENT: events.Query,
  INTVAR_EVENT: events.IntVar,
  ROTATE_EVENT: events.Rotate,
  FORMAT_DESCRIPTION_EVENT: events.Format,
  XID_EVENT: events.Xid,
  HEARTBEAT_LOG_EVENT: events.Heartbeat,
  GTID_LOG_EVENT: events.Gtid,
  // Tagged GTIDs (MySQL 8.3+) decode inside the plain Gtid class (keyed
  // on options.eventType), so consumers see and filter ordinary 'gtid'
  // events; event.gtid is 'uuid:tag:gno' and event.tag is set
  GTID_TAGGED_LOG_EVENT: events.Gtid,
  ANONYMOUS_GTID_LOG_EVENT: events.AnonymousGtid,
  PREVIOUS_GTIDS_LOG_EVENT: events.PreviousGtids,
  TRANSACTION_PAYLOAD_EVENT: events.TransactionPayload,
  PARTIAL_UPDATE_ROWS_EVENT: events.PartialUpdateRows,

  TABLE_MAP_EVENT: events.TableMap,
  DELETE_ROWS_EVENT_V1: rowsEvents.DeleteRows,
  UPDATE_ROWS_EVENT_V1: rowsEvents.UpdateRows,
  WRITE_ROWS_EVENT_V1: rowsEvents.WriteRows,
  WRITE_ROWS_EVENT_V2: rowsEvents.WriteRows,
  UPDATE_ROWS_EVENT_V2: rowsEvents.UpdateRows,
  DELETE_ROWS_EVENT_V2: rowsEvents.DeleteRows,

  XA_PREPARE_LOG_EVENT: events.XaPrepare,
  ROWS_QUERY_LOG_EVENT: events.RowsQuery,

  // MariaDB
  ANNOTATE_ROWS_EVENT: events.AnnotateRows,
  BINLOG_CHECKPOINT_EVENT: events.BinlogCheckpoint,
  MARIADB_GTID_EVENT: events.MariadbGtid,
  MARIADB_GTID_LIST_EVENT: events.MariadbGtidList,
  START_ENCRYPTION_EVENT: events.StartEncryption,
  // log_bin_compress=ON variants decompress transparently inside the
  // plain event classes (keyed on options.eventType), so consumers see
  // and filter ordinary query/writerows/updaterows/deleterows events
  QUERY_COMPRESSED_EVENT: events.Query,
  WRITE_ROWS_COMPRESSED_EVENT_V1: rowsEvents.WriteRows,
  UPDATE_ROWS_COMPRESSED_EVENT_V1: rowsEvents.UpdateRows,
  DELETE_ROWS_COMPRESSED_EVENT_V1: rowsEvents.DeleteRows,
  WRITE_ROWS_COMPRESSED_EVENT: rowsEvents.WriteRows,
  UPDATE_ROWS_COMPRESSED_EVENT: rowsEvents.UpdateRows,
  DELETE_ROWS_COMPRESSED_EVENT: rowsEvents.DeleteRows,
};

export function getEventClass(code) {
  return EventClass[CodeEvent[code]] || events.Unknown;
}
