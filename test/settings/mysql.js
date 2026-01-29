// Replication logs will be cleared!
// Database will be recreated!
export default {
  connection: {
    host     : process.env.MYSQL_HOST || 'localhost',
    user     : 'root',
    password : 'secret',
    charset  : 'utf8mb4_unicode_ci',
    port     : process.env.TEST_MYSQL_PORT,
    timezone : process.env.TEST_TIMEZONE || 'Z',
    jsonStrings: process.env.TEST_JSON_STRINGS === 'false' ? false : true,
    dateStrings : (() => {
      if (!process.env.TEST_DATE_STRINGS) return ['TIMESTAMP'];
      if (process.env.TEST_DATE_STRINGS === 'true') return true;
      return process.env.TEST_DATE_STRINGS.split(',');
    })(),
    database: 'zongji_test',
    // debug: true
  },
  sessionSqlMode: process.env.TEST_SESSION_SQL_MODE || '',
};
