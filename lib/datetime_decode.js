// This file contains functions useful for converting bare numbers into
// JavaScript Date objects, or DATE/DATETIME/TIMESTAMP strings, according to the
// dateStrings option.  The dateStrings option should be read from
// zongji.connection.config, where zongji is the current instance of the ZongJi
// object.  The dateStrings option is interpreted the same as in node-mysql.
const common = require('./common'); // used only for common.zeroPad

// dateStrings are used only if the dateStrings option is true, or is an array
// containing the sql type name string, 'DATE', 'DATETIME', or 'TIMESTAMP'.
// This follows the documentation of the dateStrings option in node-mysql.
const useDateStringsForType = function(dateStrings, sqlTypeString) {
  return dateStrings &&
           (dateStrings === true ||
            dateStrings.indexOf && dateStrings.indexOf(sqlTypeString) > -1);
};

// fraction is the fractional second object from readTemporalFraction().
// returns '' or a '.' followed by fraction.precision digits, like '.123'
const getFractionString = exports.getFractionString = function(fraction) {
  return fraction ?
         '.' + common.zeroPad(fraction.value, fraction.precision) :
         '';
};

// 1950-00-00 and the like are perfectly valid Mysql dateStrings.  A 0 portion
// of a date is essentially a null part of the date, so we should keep it.
// year, month, and date must be integers >= 0.  January is month === 1.
const getDateString = exports.getDateString = function(year, month, date) {
  return common.zeroPad(year, 4) + '-' +
         common.zeroPad(month, 2) + '-' +
         common.zeroPad(date, 2);
};

// Date object months are 1 less than Mysql months, and we need to filter 0.
// If we don't filter 0, 2017-00-01 will become the javascript Date 2016-12-01,
// which is not what it means.  It means 2017-NULL-01, but the Date object
// cannot handle it, so we want to return an invalid month, rather than a
// subtracted month.
const jsMonthFromMysqlMonth = function(month) {
  return month > 0 ? month - 1 : undefined;
};

// Returns a new Date object or Mysql dateString, following the dateStrings
// option.  With the dateStrings option, it can output valid Mysql DATE strings
// representing values that cannot be represented by a Date object, such as
// values with a null part like '1950-00-04', or a zero date '0000-00-00'.
const createDateFromParts = function(year,
                                     month,
                                     date,
                                     hour,
                                     minute,
                                     second,
                                     millisecond,
                                     timezone) {
  const jsMonth = jsMonthFromMysqlMonth(month);
  if (!timezone || timezone === 'local') {
    return new Date(year,
                    jsMonth,
                    date,
                    hour,
                    minute,
                    second,
                    millisecond);
  }

  const utcTime = Date.UTC(year,
                           jsMonth,
                           date,
                           hour,
                           minute,
                           second,
                           millisecond);
  if (timezone === 'Z') {
    return new Date(utcTime);
  }

  const offsetMinutes = getTimezoneOffsetMinutes(timezone);
  if (offsetMinutes === null) {
    return new Date(year,
                    jsMonth,
                    date,
                    hour,
                    minute,
                    second,
                    millisecond);
  }
  return new Date(utcTime - offsetMinutes * 60000);
};

exports.getDate = function(dateStrings, // node-mysql dateStrings option
                           year,
                           month,       // January === 1
                           date,
                           timezone
                          )
{
  if (!useDateStringsForType(dateStrings, 'DATE')) {
    return createDateFromParts(year,
                               month,
                               date,
                               0,
                               0,
                               0,
                               0,
                               timezone);
  }
  return getDateString(year, month, date);
};

// Returns a new Date object or Mysql dateString, following the dateStrings
// option.  Fraction is an optional parameter that comes from
// readTemporalFraction().  Mysql dateStrings are needed for microsecond
// precision, or to represent '0000-00-00 00:00:00'.
exports.getDateTime = function(dateStrings, // node-mysql dateStrings option
                               year,
                               month,       // January === 1
                               date,
                               hour,
                               minute,
                               second,
                               fraction,    // optional fractional second object
                               timezone
                              )
{
  if (!useDateStringsForType(dateStrings, 'DATETIME')) {
    return createDateFromParts(year,
                               month,
                               date,
                               hour,
                               minute,
                               second,
                               fraction ? fraction.milliseconds : 0,
                               timezone);
  }
  return getDateString(year, month, date) + ' ' +
         common.zeroPad(hour, 2) + ':' +
         common.zeroPad(minute, 2) + ':' +
         common.zeroPad(second, 2) +
         getFractionString(fraction);
};

// Returns a new Date object or Mysql dateString, following the dateStrings
// option.  Fraction is an optional parameter that comes from
// readTemporalFraction().  With the dateStrings option from node-mysql,
// this returns a mysql TIMESTAMP string, like '1975-03-01 23:03:20.38945' or
// '1975-03-01 00:03:20'.  Mysql strings are needed for precision beyond ms.
const getTimezoneOffsetMinutes = function(timezone) {
  if (!timezone || timezone === 'local' || timezone === 'Z') {
    return null;
  }
  const match = timezone.match(/^([+-])(\d\d):(\d\d)$/);
  if (!match) {
    return null;
  }
  const sign = match[1] === '-' ? -1 : 1;
  const hours = parseInt(match[2], 10);
  const minutes = parseInt(match[3], 10);
  return sign * (hours * 60 + minutes);
};

const getTimeComponents = function(dateObject, timezone) {
  if (!timezone || timezone === 'local') {
    return {
      year: dateObject.getFullYear(),
      month: dateObject.getMonth() + 1,
      day: dateObject.getDate(),
      hours: dateObject.getHours(),
      minutes: dateObject.getMinutes(),
      seconds: dateObject.getSeconds(),
    };
  }

  if (timezone === 'Z') {
    return {
      year: dateObject.getUTCFullYear(),
      month: dateObject.getUTCMonth() + 1,
      day: dateObject.getUTCDate(),
      hours: dateObject.getUTCHours(),
      minutes: dateObject.getUTCMinutes(),
      seconds: dateObject.getUTCSeconds(),
    };
  }

  const offsetMinutes = getTimezoneOffsetMinutes(timezone);
  if (offsetMinutes === null) {
    return {
      year: dateObject.getFullYear(),
      month: dateObject.getMonth() + 1,
      day: dateObject.getDate(),
      hours: dateObject.getHours(),
      minutes: dateObject.getMinutes(),
      seconds: dateObject.getSeconds(),
    };
  }

  const shifted = new Date(dateObject.getTime() + offsetMinutes * 60000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
    seconds: shifted.getUTCSeconds(),
  };
};

exports.getTimeStamp = function(dateStrings, // node-mysql dateStrings option
                                secondsFromEpoch, // an integer
                                fraction, // optional fraction of second object
                                timezone // mysql2 timezone option
                               )
{
  const milliseconds = fraction ? fraction.milliseconds : 0;
  const dateObject = new Date(secondsFromEpoch * 1000 + milliseconds);
  if (!useDateStringsForType(dateStrings, 'TIMESTAMP')) {
    return dateObject;
  }
  if (secondsFromEpoch === 0 && (!fraction || fraction.value === 0)) {
    return '0000-00-00 00:00:00' + getFractionString(fraction);
  }
  const parts = getTimeComponents(dateObject, timezone);
  return getDateString(parts.year,
                       parts.month,
                       parts.day) + ' ' +
         common.zeroPad(parts.hours, 2) + ':' +
         common.zeroPad(parts.minutes, 2) + ':' +
         common.zeroPad(parts.seconds, 2) +
         getFractionString(fraction);
};
