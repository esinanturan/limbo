"use strict";

const { Database: NativeDB } = require("./index.js");
const { bindParams } = require("./bind.js");

const SqliteError = require("./sqlite-error.js");

// Step result constants
const STEP_ROW = 1;
const STEP_DONE = 2;
const STEP_IO = 3;

const convertibleErrorTypes = { TypeError };
const CONVERTIBLE_ERROR_PREFIX = "[TURSO_CONVERT_TYPE]";

function convertError(err) {
  if ((err.code ?? "").startsWith(CONVERTIBLE_ERROR_PREFIX)) {
    return createErrorByName(
      err.code.substring(CONVERTIBLE_ERROR_PREFIX.length),
      err.message,
    );
  }

  return new SqliteError(err.message, err.code, err.rawCode);
}

function createErrorByName(name, message) {
  const ErrorConstructor = convertibleErrorTypes[name];
  if (!ErrorConstructor) {
    throw new Error(`unknown error type ${name} from Turso`);
  }

  return new ErrorConstructor(message);
}

/**
 * Database represents a connection that can prepare and execute SQL statements.
 */
class Database {
  /**
   * Creates a new database connection. If the database file pointed to by `path` does not exists, it will be created.
   *
   * @constructor
   * @param {string} path - Path to the database file.
   * @param {Object} opts - Options for database behavior.
   * @param {boolean} [opts.readonly=false] - Open the database in read-only mode.
   * @param {boolean} [opts.fileMustExist=false] - If true, throws if database file does not exist.
   * @param {number} [opts.timeout=0] - Timeout duration in milliseconds for database operations. Defaults to 0 (no timeout).
   */
  constructor(path, opts = {}) {
    opts.readonly = opts.readonly === undefined ? false : opts.readonly;
    opts.fileMustExist =
      opts.fileMustExist === undefined ? false : opts.fileMustExist;
    opts.timeout = opts.timeout === undefined ? 0 : opts.timeout;

    this.db = new NativeDB(path, opts);
    this.memory = this.db.memory;
    const db = this.db;

    Object.defineProperties(this, {
      inTransaction: {
        get() {
          return db.inTransaction();
        },
      },
      name: {
        get() {
          return path;
        },
      },
      readonly: {
        get() {
          return opts.readonly;
        },
      },
      open: {
        get() {
          return this.db.open;
        },
      },
    });
  }

  /**
   * Prepares a SQL statement for execution.
   *
   * @param {string} sql - The SQL statement string to prepare.
   */
  prepare(sql) {
    if (!sql) {
      throw new RangeError("The supplied SQL string contains no statements");
    }

    try {
      return new Statement(this.db.prepare(sql), this);
    } catch (err) {
      throw convertError(err);
    }
  }

  /**
   * Returns a function that executes the given function in a transaction.
   *
   * @param {function} fn - The function to wrap in a transaction.
   */
  transaction(fn) {
    if (typeof fn !== "function")
      throw new TypeError("Expected first argument to be a function");

    const db = this;
    const wrapTxn = (mode) => {
      return (...bindParameters) => {
        db.exec("BEGIN " + mode);
        try {
          const result = fn(...bindParameters);
          db.exec("COMMIT");
          return result;
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      };
    };
    const properties = {
      default: { value: wrapTxn("") },
      deferred: { value: wrapTxn("DEFERRED") },
      immediate: { value: wrapTxn("IMMEDIATE") },
      exclusive: { value: wrapTxn("EXCLUSIVE") },
      database: { value: this, enumerable: true },
    };
    Object.defineProperties(properties.default.value, properties);
    Object.defineProperties(properties.deferred.value, properties);
    Object.defineProperties(properties.immediate.value, properties);
    Object.defineProperties(properties.exclusive.value, properties);
    return properties.default.value;
  }

  pragma(source, options) {
    if (options == null) options = {};

    if (typeof source !== "string")
      throw new TypeError("Expected first argument to be a string");

    if (typeof options !== "object")
      throw new TypeError("Expected second argument to be an options object");

    const pragma = `PRAGMA ${source}`;
    
    const stmt = this.prepare(pragma);
    const results = stmt.all();
    
    return results;
  }

  backup(filename, options) {
    throw new Error("not implemented");
  }

  serialize(options) {
    throw new Error("not implemented");
  }

  function(name, options, fn) {
    throw new Error("not implemented");
  }

  aggregate(name, options) {
    throw new Error("not implemented");
  }

  table(name, factory) {
    throw new Error("not implemented");
  }

  loadExtension(path) {
    this.db.loadExtension(path);
  }

  maxWriteReplicationIndex() {
    throw new Error("not implemented");
  }

  /**
   * Executes a SQL statement.
   *
   * @param {string} sql - The SQL statement string to execute.
   */
  exec(sql) {
    try {
      this.db.batch(sql);
    } catch (err) {
      throw convertError(err);
    }
  }

  /**
   * Interrupts the database connection.
   */
  interrupt() {
    this.db.interrupt();
  }

  /**
   * Closes the database connection.
   */
  close() {
    this.db.close();
  }
}

/**
 * Statement represents a prepared SQL statement that can be executed.
 */
class Statement {
  constructor(stmt, database) {
    this.stmt = stmt;
    this.db = database;
  }

  /**
   * Toggle raw mode.
   *
   * @param raw Enable or disable raw mode. If you don't pass the parameter, raw mode is enabled.
   */
  raw(raw) {
    this.stmt.raw(raw);
    return this;
  }

  /**
   * Toggle pluck mode.
   *
   * @param pluckMode Enable or disable pluck mode. If you don't pass the parameter, pluck mode is enabled.
   */
  pluck(pluckMode) {
    this.stmt.pluck(pluckMode);
    return this;
  }

  get source() {
    return this.stmt.source;
  }

  get reader() {
    throw new Error("not implemented");
  }

  get source() {
    return this.stmt.source;
  }

  get database() {
    return this.db;
  }

  /**
   * Executes the SQL statement and returns an info object.
   */
  run(...bindParameters) {
    const totalChangesBefore = this.db.db.totalChanges();
    
    this.stmt.reset();
    bindParams(this.stmt, bindParameters);
    for (;;) {
      const stepResult = this.stmt.step();
      if (stepResult === STEP_IO) {
        this.db.db.ioLoopSync();
        continue;
      }
      if (stepResult === STEP_DONE) {
        break;
      }
      if (stepResult === STEP_ROW) {
        // For run(), we don't need the row data, just continue
        continue;
      }
    }
    
    const lastInsertRowid = this.db.db.lastInsertRowid();
    const changes = this.db.db.totalChanges() === totalChangesBefore ? 0 : this.db.db.changes();
    
    return { changes, lastInsertRowid };
  }

  /**
   * Executes the SQL statement and returns the first row.
   *
   * @param bindParameters - The bind parameters for executing the statement.
   */
  get(...bindParameters) {
    this.stmt.reset();
    bindParams(this.stmt, bindParameters);
    for (;;) {
      const stepResult = this.stmt.step();
      if (stepResult === STEP_IO) {
        this.db.db.ioLoopSync();
        continue;
      }
      if (stepResult === STEP_DONE) {
        return undefined;
      }
      if (stepResult === STEP_ROW) {
        return this.stmt.row();
      }
    }
  }

  /**
   * Executes the SQL statement and returns an iterator to the resulting rows.
   *
   * @param bindParameters - The bind parameters for executing the statement.
   */
  *iterate(...bindParameters) {
    throw new Error("not implemented");
  }

  /**
   * Executes the SQL statement and returns an array of the resulting rows.
   *
   * @param bindParameters - The bind parameters for executing the statement.
   */
  all(...bindParameters) {
    this.stmt.reset();
    bindParams(this.stmt, bindParameters);
    const rows = [];
    for (;;) {
      const stepResult = this.stmt.step();
      if (stepResult === STEP_IO) {
        this.db.db.ioLoopSync();
        continue;
      }
      if (stepResult === STEP_DONE) {
        break;
      }
      if (stepResult === STEP_ROW) {
        rows.push(this.stmt.row());
      }
    }
    return rows;
  }

  /**
   * Interrupts the statement.
   */
  interrupt() {
    this.stmt.interrupt();
    return this;
  }

  /**
   * Returns the columns in the result set returned by this prepared statement.
   */
  columns() {
    return this.stmt.columns();
  }

  /**
   * Binds the given parameters to the statement _permanently_
   *
   * @param bindParameters - The bind parameters for binding the statement.
   * @returns this - Statement with binded parameters
   */
  bind(...bindParameters) {
    try {
      bindParams(this.stmt, bindParameters);
      return this;
    } catch (err) {
      throw convertError(err);
    }
  }
}

module.exports = Database;
module.exports.SqliteError = SqliteError;
