const fs = require('node:fs');
const path = require('node:path');

function normalizeLogValue(value, maximumLength = 4000) {
  const text = value instanceof Error
    ? value.stack || value.message
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);
  return String(text ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, maximumLength);
}

function createDiagnosticLogger({ directory, fileName = 'studio.log', maximumBytes = 2 * 1024 * 1024 }) {
  const logDirectory = path.resolve(directory);
  const logPath = path.join(logDirectory, fileName);
  const previousLogPath = `${logPath}.1`;

  function rotateIfNeeded() {
    try {
      if (!fs.existsSync(logPath) || fs.statSync(logPath).size < maximumBytes) return;
      if (fs.existsSync(previousLogPath)) fs.unlinkSync(previousLogPath);
      fs.renameSync(logPath, previousLogPath);
    } catch {
      // Logging must never prevent the application from starting or closing.
    }
  }

  function write(level, message, details = null) {
    try {
      fs.mkdirSync(logDirectory, { recursive: true });
      rotateIfNeeded();
      const record = {
        time: new Date().toISOString(),
        level: String(level || 'info').toLowerCase(),
        message: normalizeLogValue(message, 1200)
      };
      if (details !== null && details !== undefined && details !== '') {
        record.details = normalizeLogValue(details);
      }
      fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // Diagnostic logging is best effort and cannot become a new failure path.
    }
  }

  return { logPath, previousLogPath, write };
}

module.exports = { createDiagnosticLogger, normalizeLogValue };
