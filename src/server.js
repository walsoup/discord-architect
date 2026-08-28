import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

import { updateEnvFile, readEnvFile } from './util/env.js';
import { getDiscordClient, getGuildStateSummary, isDiscordConfigured, reconnectDiscordClient } from './discord/client.js';
import { getSnapshot } from './discord/snapshot.js';
import { isDryRun, setDryRun } from './discord/ops.js';
import { runAgent, resetConversation, resolveApproval, cancelRun, isSessionRunning, sendUserSteeringMessage } from './agent/loop.js';
import { getAIConfig, setAIConfig, fetchAvailableModels } from './agent/config.js';
import { sseManager } from './util/sse.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT || '3650', 10);
const HOST = '127.0.0.1'; // Localhost only for safety

app.use(express.json());
app.use(express.static(path.resolve(__dirname, '../public')));

// -------------------------------------------------------------
// REST Endpoints
// -------------------------------------------------------------

// Root route
app.get('/', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../public/index.html'));
});

// Server and Discord State
app.get('/api/state', async (req, res) => {
  try {
    const summary = await getGuildStateSummary();
    const aiConfig = getAIConfig();
    res.json({
      ok: true,
      ...summary,
      dryRun: isDryRun(),
      model: aiConfig.model,
      baseURL: aiConfig.baseURL,
      reasoningEffort: aiConfig.reasoningEffort,
      hasApiKey: aiConfig.hasApiKey
    });
  } catch (err) {
    const aiConfig = getAIConfig();
    res.status(500).json({
      ok: false,
      error: err.message,
      dryRun: isDryRun(),
      model: aiConfig.model,
      baseURL: aiConfig.baseURL,
      reasoningEffort: aiConfig.reasoningEffort,
      hasApiKey: aiConfig.hasApiKey
    });
  }
});

// Setup Status & Info
app.get('/api/setup', (req, res) => {
  const env = readEnvFile();
  const ai = getAIConfig();
  res.json({
    ok: true,
    discordConfigured: isDiscordConfigured(),
    discordGuildId: env.DISCORD_GUILD_ID || process.env.DISCORD_GUILD_ID || '',
    hasDiscordToken: Boolean(env.DISCORD_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN),
    aiConfigured: ai.hasApiKey,
    model: ai.model,
    baseURL: ai.baseURL,
    reasoningEffort: ai.reasoningEffort
  });
});

// Save Setup Configuration from Web UI
app.post('/api/setup', async (req, res) => {
  try {
    const { discordBotToken, discordGuildId, openAiApiKey, openAiBaseUrl, openAiModel, reasoningEffort } = req.body;

    const updates = {};
    if (discordBotToken !== undefined && discordBotToken.trim()) updates.DISCORD_BOT_TOKEN = discordBotToken.trim();
    if (discordGuildId !== undefined && discordGuildId.trim()) updates.DISCORD_GUILD_ID = discordGuildId.trim();
    if (openAiApiKey !== undefined && openAiApiKey.trim()) updates.OPENAI_API_KEY = openAiApiKey.trim();
    if (openAiBaseUrl !== undefined) updates.OPENAI_BASE_URL = openAiBaseUrl.trim();
    if (openAiModel !== undefined && openAiModel.trim()) updates.OPENAI_MODEL = openAiModel.trim();
    if (reasoningEffort !== undefined) updates.OPENAI_REASONING_EFFORT = reasoningEffort.trim();

    updateEnvFile(updates);

    // Update AI Config
    setAIConfig({
      apiKey: updates.OPENAI_API_KEY || openAiApiKey,
      baseURL: updates.OPENAI_BASE_URL !== undefined ? updates.OPENAI_BASE_URL : openAiBaseUrl,
      model: updates.OPENAI_MODEL || openAiModel,
      reasoningEffort: updates.OPENAI_REASONING_EFFORT || reasoningEffort
    });

    let discordResult = null;
    const token = updates.DISCORD_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN;
    const guildId = updates.DISCORD_GUILD_ID || process.env.DISCORD_GUILD_ID;

    if (token && guildId) {
      discordResult = await reconnectDiscordClient(token, guildId);
    }

    res.json({
      ok: true,
      message: 'Setup saved successfully!',
      discord: discordResult,
      ai: getAIConfig()
    });
  } catch (err) {
    console.error('Error saving setup:', err);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Test Discord Connection
app.post('/api/setup/test-discord', async (req, res) => {
  const { token, guildId } = req.body;
  const targetToken = token || process.env.DISCORD_BOT_TOKEN;
  const targetGuildId = guildId || process.env.DISCORD_GUILD_ID;

  if (!targetToken || !targetGuildId) {
    return res.status(400).json({ ok: false, error: 'Both Discord Bot Token and Guild ID are required.' });
  }

  try {
    const result = await reconnectDiscordClient(targetToken, targetGuildId);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// AI Configuration
app.get('/api/config', (req, res) => {
  const config = getAIConfig();
  res.json({
    ok: true,
    model: config.model,
    baseURL: config.baseURL,
    reasoningEffort: config.reasoningEffort,
    hasApiKey: config.hasApiKey
  });
});

app.post('/api/config', (req, res) => {
  const { apiKey, baseURL, model, reasoningEffort } = req.body;
  const updated = setAIConfig({ apiKey, baseURL, model, reasoningEffort });
  if (apiKey) {
    updateEnvFile({ OPENAI_API_KEY: apiKey });
  }
  if (baseURL !== undefined) {
    updateEnvFile({ OPENAI_BASE_URL: baseURL });
  }
  if (model) {
    updateEnvFile({ OPENAI_MODEL: model });
  }
  if (reasoningEffort !== undefined) {
    updateEnvFile({ OPENAI_REASONING_EFFORT: reasoningEffort });
  }
  res.json({
    ok: true,
    model: updated.model,
    baseURL: updated.baseURL,
    reasoningEffort: updated.reasoningEffort,
    hasApiKey: updated.hasApiKey
  });
});

// Fetch Available Models from /models endpoint
app.get('/api/models', async (req, res) => {
  try {
    const models = await fetchAvailableModels();
    res.json({
      ok: true,
      models,
      currentModel: getAIConfig().model
    });
  } catch (err) {
    console.warn('Could not fetch models list from provider:', err.message);
    res.json({
      ok: false,
      error: err.message,
      currentModel: getAIConfig().model,
      fallbackModels: [
        'gemini-3.7-flash',
        'gpt-4.1',
        'gpt-4.5-preview',
        'gpt-4o',
        'gpt-4o-mini',
        'o1',
        'o3-mini',
        'claude-3-7-sonnet',
        'claude-3-5-sonnet',
        'meta-llama/llama-3.3-70b-instruct',
        'deepseek/deepseek-chat',
        'deepseek/deepseek-r1'
      ]
    });
  }
});

// Guild Snapshot
app.get('/api/snapshot', async (req, res) => {
  try {
    const snapshot = await getSnapshot();
    res.json({ ok: true, snapshot });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Start Chat / Agent Run
app.post('/api/chat', (req, res) => {
  const { message, sessionId = 'default', model, baseURL, apiKey, reasoningEffort } = req.body;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ ok: false, error: 'Field "message" is required and must be a string.' });
  }

  // Update active model & reasoning effort if provided in chat request
  if (model) {
    setAIConfig({ model });
  }
  if (reasoningEffort !== undefined) {
    setAIConfig({ reasoningEffort });
  }

  // If a run is already active for this session, inject mid-flight steering message!
  if (isSessionRunning(sessionId)) {
    const result = sendUserSteeringMessage(sessionId, message);
    return res.json({ ok: true, runId: result.runId, steered: true });
  }

  const runId = crypto.randomUUID();
  sseManager.createRun(runId);

  // Kick off the agent run asynchronously in background
  const emit = (eventType, data) => {
    sseManager.emit(runId, eventType, data);
  };

  runAgent(message, sessionId, runId, emit, { model, baseURL, apiKey, reasoningEffort })
    .catch((err) => {
      console.error(`Error in run ${runId}:`, err);
      emit('error', { message: err.message });
      emit('done', { summary: 'Aborted due to error.' });
    })
    .finally(() => {
      // Allow SSE clients to receive remaining events then close stream
      setTimeout(() => {
        sseManager.close(runId);
      }, 3000);
    });

  res.json({ ok: true, runId, steered: false });
});

// SSE Stream for Run Events
app.get('/api/stream/:runId', (req, res) => {
  const { runId } = req.params;
  sseManager.attach(runId, res);
});

// Approval Response for Destructive Operations
app.post('/api/approve', (req, res) => {
  const { runId, callId, approved } = req.body;
  if (!runId || !callId || approved === undefined) {
    return res.status(400).json({ ok: false, error: 'runId, callId, and approved (boolean) are required.' });
  }

  const resolved = resolveApproval(runId, callId, Boolean(approved));
  res.json({ ok: true, resolved });
});

// Toggle Dry-Run Mode
app.post('/api/dry-run', (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'Field "enabled" must be a boolean.' });
  }

  const state = setDryRun(enabled);
  res.json({ ok: true, dryRun: state });
});

// Cancel Active Run
app.post('/api/cancel', (req, res) => {
  const { runId } = req.body;
  if (!runId) {
    return res.status(400).json({ ok: false, error: 'runId is required.' });
  }
  const cancelled = cancelRun(runId);
  res.json({ ok: true, cancelled });
});

// Reset Conversation History
app.post('/api/reset', (req, res) => {
  const { sessionId = 'default' } = req.body || {};
  resetConversation(sessionId);
  res.json({ ok: true, message: `Conversation reset for session "${sessionId}".` });
});

// Start Server and Discord Bot
async function start() {
  try {
    console.log('Starting Discord Architect server...');

    // Attempt Discord connection if credentials exist
    if (isDiscordConfigured()) {
      getDiscordClient();
    } else {
      console.log('⚡ Discord credentials not found in .env yet. Web Setup Wizard ready at http://' + HOST + ':' + PORT);
    }

    app.listen(PORT, HOST, () => {
      console.log(`\n🚀 Discord Architect running at http://${HOST}:${PORT}`);
      console.log(`🔒 Bound to ${HOST} (localhost only).`);
      console.log(`🛡️ Dry-run mode is currently: ${isDryRun() ? 'ENABLED (Mutations simulated)' : 'DISABLED (ARMED: Live Discord mutations)'}\n`);
    });
  } catch (err) {
    console.error('Failed to initialize server:', err);
    process.exit(1);
  }
}

start();
