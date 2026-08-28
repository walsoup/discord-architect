import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGS_DIR = path.resolve(__dirname, '../../logs');

// ANSI color codes for terminal logging
const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  bold: '\x1b[1m'
};

/**
 * Ensure the logs directory exists.
 */
function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

/**
 * Get current date string formatted as YYYY-MM-DD.
 */
function getDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Append an audit entry to the daily JSONL file and output a colored terminal summary.
 * 
 * @param {Object} entry
 * @param {string} entry.tool - Name of the tool executed
 * @param {Object} entry.args - Arguments passed to the tool
 * @param {boolean} entry.ok - Whether execution succeeded
 * @param {any} [entry.result] - Result object on success
 * @param {string} [entry.error] - Error message on failure
 * @param {boolean} entry.dryRun - Whether executed in dry-run mode
 */
export function auditLog({ tool, args, ok, result, error, dryRun }) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    tool,
    args,
    ok,
    result: ok ? result : undefined,
    error: !ok ? error : undefined,
    dryRun: Boolean(dryRun)
  };

  try {
    ensureLogsDir();
    const logFilePath = path.join(LOGS_DIR, `audit-${getDateString()}.jsonl`);
    fs.appendFileSync(logFilePath, JSON.stringify(logEntry) + '\n', 'utf8');
  } catch (err) {
    console.error('Failed to write to audit log file:', err.message);
  }

  // Print concise colored terminal summary
  const tag = dryRun ? `${colors.yellow}[DRY-RUN]${colors.reset}` : `${colors.magenta}[MUTATION]${colors.reset}`;
  const status = ok
    ? `${colors.green}✓ OK${colors.reset}`
    : `${colors.red}✗ FAILED: ${error || 'Unknown error'}${colors.reset}`;
  const argsSummary = Object.entries(args || {})
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ');

  console.log(
    `${colors.dim}[${timestamp.slice(11, 19)}]${colors.reset} ${tag} ${colors.cyan}${colors.bold}${tool}${colors.reset} (${argsSummary}) -> ${status}`
  );
}
