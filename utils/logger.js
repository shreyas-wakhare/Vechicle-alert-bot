/**
 * utils/logger.js
 *
 * Production-grade logger:
 *  - Colour-coded terminal output
 *  - Writes to logs/app.log (plain text, no colour)
 *  - Auto-rotates: keeps last 7 daily log files
 */

const fs   = require('fs');
const path = require('path');

// ─── Colour codes ──────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  grey:   '\x1b[90m',
  cyan:   '\x1b[36m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  bgRed:  '\x1b[41m',
  green:  '\x1b[32m',
  bold:   '\x1b[1m',
};

// ─── Log directory ─────────────────────────────────────────────────────────
const LOG_DIR  = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, `app-${_dateStamp()}.log`);

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
_rotateLogs();

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

// ─── Helpers ───────────────────────────────────────────────────────────────
function _pad(n)        { return String(n).padStart(2, '0'); }
function _dateStamp()   {
  const d = new Date();
  return `${d.getFullYear()}-${_pad(d.getMonth()+1)}-${_pad(d.getDate())}`;
}
function _timestamp() {
  const d = new Date();
  return `${_dateStamp()} ${_pad(d.getHours())}:${_pad(d.getMinutes())}:${_pad(d.getSeconds())}`;
}

/** Keep only the 7 most recent log files */
function _rotateLogs() {
  try {
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith('app-') && f.endsWith('.log'))
      .map(f => ({ name: f, time: fs.statSync(path.join(LOG_DIR, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    files.slice(7).forEach(f => fs.unlinkSync(path.join(LOG_DIR, f.name)));
  } catch {}
}

function _write(level, colour, label, args) {
  const ts  = _timestamp();
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a))).join(' ');

  // Terminal (with colour)
  const termLine = `${C.grey}[${ts}]${C.reset} ${colour}${C.bold}${label}${C.reset} ${msg}`;
  if (level === 'error') process.stderr.write(termLine + '\n');
  else                   process.stdout.write(termLine + '\n');

  // File (plain text, always)
  logStream.write(`[${ts}] ${label} ${msg}\n`);
}

// ─── Public API ────────────────────────────────────────────────────────────
const logger = {
  info:    (...args) => _write('info',    C.cyan,           'INFO  ', args),
  success: (...args) => _write('info',    C.green,          'OK    ', args),
  warn:    (...args) => _write('warn',    C.yellow,         'WARN  ', args),
  error:   (...args) => _write('error',   C.red,            'ERROR ', args),
  fatal:   (...args) => _write('error',   C.bgRed + C.bold, 'FATAL ', args),
  debug:   (...args) => {
    if (process.env.DEBUG) _write('debug', C.grey, 'DEBUG ', args);
  },
  /** Print a clear visual separator in the terminal */
  banner: (text) => {
    const line = '─'.repeat(60);
    process.stdout.write(`\n${C.cyan}${line}\n  ${C.bold}${text}${C.reset}${C.cyan}\n${line}${C.reset}\n\n`);
  },
};

module.exports = logger;

