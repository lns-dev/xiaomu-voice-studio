const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDiagnosticLogger, normalizeLogValue } = require('../electron/diagnostic-log.cjs');

test('diagnostic logger writes structured records and rotates bounded logs', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomu-diagnostic-log-'));
  const logger = createDiagnosticLogger({ directory, maximumBytes: 80 });
  logger.write('info', 'application started');
  logger.write('error', 'generation failed', new Error('example failure'));

  assert.equal(fs.existsSync(logger.logPath), true);
  assert.equal(fs.existsSync(logger.previousLogPath), true);
  const record = JSON.parse(fs.readFileSync(logger.logPath, 'utf8').trim());
  assert.equal(record.level, 'error');
  assert.match(record.message, /generation failed/);
  assert.match(record.details, /example failure/);
});

test('diagnostic values remove control characters and stay bounded', () => {
  assert.equal(normalizeLogValue('a\u0000b', 10), 'ab');
  assert.equal(normalizeLogValue('123456', 4), '1234');
});
