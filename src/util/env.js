import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENV_FILE_PATH = path.resolve(__dirname, '../../.env');
const ENV_EXAMPLE_PATH = path.resolve(__dirname, '../../.env.example');

/**
 * Read and parse .env file into key-value map.
 */
export function readEnvFile() {
  const envData = {};
  if (!fs.existsSync(ENV_FILE_PATH)) {
    if (fs.existsSync(ENV_EXAMPLE_PATH)) {
      try {
        fs.copyFileSync(ENV_EXAMPLE_PATH, ENV_FILE_PATH);
      } catch (_) {}
    } else {
      return envData;
    }
  }

  try {
    const content = fs.readFileSync(ENV_FILE_PATH, 'utf8');
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        envData[key] = value;
      }
    }
  } catch (err) {
    console.error('Error reading .env file:', err.message);
  }

  return envData;
}

/**
 * Update and persist environment variables to .env file and process.env.
 */
export function updateEnvFile(updates = {}) {
  const current = readEnvFile();

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      current[key] = String(value);
      process.env[key] = String(value);
    }
  }

  const lines = [
    '# OpenAI / OpenAI-Compatible Provider Settings',
    `OPENAI_API_KEY=${current.OPENAI_API_KEY || ''}`,
    `OPENAI_MODEL=${current.OPENAI_MODEL || 'gemini-3.7-flash'}`,
    `OPENAI_BASE_URL=${current.OPENAI_BASE_URL || ''}`,
    '',
    '# Discord Bot Credentials',
    `DISCORD_BOT_TOKEN=${current.DISCORD_BOT_TOKEN || ''}`,
    `DISCORD_GUILD_ID=${current.DISCORD_GUILD_ID || ''}`,
    '',
    '# Server Port',
    `PORT=${current.PORT || '3650'}`
  ];

  try {
    fs.writeFileSync(ENV_FILE_PATH, lines.join('\n') + '\n', 'utf8');
    console.log('[Config] .env file successfully updated and saved to disk.');
  } catch (err) {
    console.error('Failed to write .env file:', err.message);
  }

  return current;
}
