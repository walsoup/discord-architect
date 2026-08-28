import { toolsRegistry, getOpenAITools } from './tools.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { isDryRun } from '../discord/ops.js';
import { getOpenAIClient, getAIConfig } from './config.js';

// In-memory conversation stores: sessionId -> Array of messages
const conversations = new Map();

// Pending approvals: `${runId}:${callId}` -> { resolve }
const pendingApprovals = new Map();

// Active run abort controllers: runId -> AbortController
const activeRunControllers = new Map();

// Active session tracking: sessionId -> { runId, emit }
const activeSessionRuns = new Map();

export function isSessionRunning(sessionId = 'default') {
  return activeSessionRuns.has(sessionId);
}

export function sendUserSteeringMessage(sessionId = 'default', message) {
  const history = getConversation(sessionId);
  if (message) {
    history.push({ role: 'user', content: message });
  }
  const active = activeSessionRuns.get(sessionId);
  if (active) {
    console.log(`[Run] Steered active session "${sessionId}" (runId: ${active.runId}) with new user instruction`);
    if (active.emit) {
      active.emit('steer', { message });
    }
    return { steered: true, runId: active.runId };
  }
  return { steered: false };
}

export function cancelRun(runId) {
  let found = false;
  if (activeRunControllers.has(runId)) {
    const controller = activeRunControllers.get(runId);
    controller.abort();
    activeRunControllers.delete(runId);
    console.log(`[Run] Cancelled active run ${runId}`);
    found = true;
  }
  for (const [sessionId, info] of activeSessionRuns.entries()) {
    if (info.runId === runId) {
      activeSessionRuns.delete(sessionId);
    }
  }
  return found;
}

export function resolveApproval(runId, callId, approved) {
  const key = `${runId}:${callId}`;
  const pending = pendingApprovals.get(key);
  if (pending) {
    pending.resolve(Boolean(approved));
    pendingApprovals.delete(key);
    return true;
  }
  return false;
}

export function resetConversation(sessionId = 'default') {
  // 1. Cancel and abort any active run controller for this session
  const active = activeSessionRuns.get(sessionId);
  if (active && active.runId) {
    if (activeRunControllers.has(active.runId)) {
      const controller = activeRunControllers.get(active.runId);
      controller.abort();
      activeRunControllers.delete(active.runId);
    }
  }
  activeSessionRuns.delete(sessionId);

  // 2. Clear pending approvals for this session
  if (active && active.runId) {
    for (const [key, pending] of pendingApprovals.entries()) {
      if (key.startsWith(active.runId)) {
        pending.resolve(false);
        pendingApprovals.delete(key);
      }
    }
  }

  // 3. Clear conversation array in place and remove from map
  if (conversations.has(sessionId)) {
    const list = conversations.get(sessionId);
    list.length = 0; // Clear array in place so any closures holding it are also emptied
  }
  conversations.delete(sessionId);

  console.log(`[Conversation] Reset session "${sessionId}"`);
}

export function getConversation(sessionId = 'default') {
  if (!conversations.has(sessionId)) {
    conversations.set(sessionId, []);
  }
  return conversations.get(sessionId);
}

/**
 * Truncate large tool result strings to max characters.
 */
function truncateString(str, max = 4000) {
  if (str.length <= max) return str;
  return str.slice(0, max) + '... [truncated]';
}

/**
 * Safely resolves tool names even if an upstream proxy or model emitted a repeated name.
 * e.g. "create_categorycreate_category" -> "create_category"
 */
function resolveToolName(rawName) {
  if (!rawName || typeof rawName !== 'string') return null;
  const trimmed = rawName.trim();
  if (toolsRegistry.has(trimmed)) return trimmed;

  // Check known tool names in registry
  const knownTools = Array.from(toolsRegistry.keys());
  for (const known of knownTools) {
    if (trimmed.startsWith(known) || trimmed.includes(known)) {
      return known;
    }
  }

  return trimmed;
}

/**
 * Safely parse JSON or extract multiple concatenated JSON objects if a model (like Gemini) emits them.
 * Example: `{"name":"A"}{"name":"B"}` -> `[ {name: "A"}, {name: "B"} ]`
 */
function parseAndSplitToolArguments(rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'string') return [{}];
  const trimmed = rawArgs.trim();
  if (!trimmed) return [{}];

  // Try standard JSON parse first
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null) {
      return [parsed];
    }
  } catch (_) {}

  // If standard parse failed (e.g. concatenated objects `}{`), extract each balanced JSON object
  const objects = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0 && start !== -1) {
          const chunk = trimmed.slice(start, i + 1);
          try {
            const obj = JSON.parse(chunk);
            if (typeof obj === 'object' && obj !== null) {
              objects.push(obj);
            }
          } catch (_) {}
          start = -1;
        }
      }
    }
  }

  return objects.length > 0 ? objects : null;
}

/**
 * Ensure messages sent to OpenAI/Gemini contain 100% valid JSON arguments and no broken structures.
 */
function sanitizeMessagesForProvider(messages = []) {
  const sanitized = [];

  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      const cleanToolCalls = [];
      for (const tc of msg.tool_calls) {
        let argsStr = tc.function?.arguments || '{}';
        const cleanName = resolveToolName(tc.function?.name) || tc.function?.name;
        try {
          JSON.parse(argsStr);
          cleanToolCalls.push({
            ...tc,
            function: {
              ...tc.function,
              name: cleanName
            }
          });
        } catch (_) {
          // Attempt to repair by extracting first valid JSON object
          const extracted = parseAndSplitToolArguments(argsStr);
          if (extracted && extracted[0]) {
            cleanToolCalls.push({
              ...tc,
              function: {
                name: cleanName,
                arguments: JSON.stringify(extracted[0])
              }
            });
          }
        }
      }

      sanitized.push({
        ...msg,
        tool_calls: cleanToolCalls.length > 0 ? cleanToolCalls : undefined
      });
    } else {
      sanitized.push(msg);
    }
  }

  return sanitized;
}

/**
 * Executes the agent loop for a user message.
 * 
 * @param {string} userMessage - Text from user
 * @param {string} sessionId - Session identifier
 * @param {string} runId - Unique execution run ID
 * @param {(eventType: string, data: any) => void} emit - Event dispatcher (SSE)
 * @param {Object} [options] - Dynamic runtime model or provider overrides
 */
export async function runAgent(userMessage, sessionId = 'default', runId, emit, options = {}) {
  const currentConfig = getAIConfig();
  const rawKey = options.apiKey !== undefined ? options.apiKey : currentConfig.apiKey;
  const baseURL = options.baseURL !== undefined ? options.baseURL : currentConfig.baseURL;

  // If using standard OpenAI (no custom baseURL) and no API key is provided, alert the user.
  if ((!rawKey || rawKey.trim() === '') && (!baseURL || baseURL.trim() === '')) {
    emit('error', { message: 'API key is missing. Configure OPENAI_API_KEY in .env or click Setup & Config.' });
    emit('done', { summary: 'Aborted: Missing API key.' });
    return;
  }

  const model = options.model || currentConfig.model || 'gemini-3.7-flash';
  let openai;
  try {
    openai = getOpenAIClient(options);
  } catch (err) {
    emit('error', { message: `Failed to initialize AI client: ${err.message}` });
    emit('done', { summary: 'Aborted: Client initialization error.' });
    return;
  }

  const history = getConversation(sessionId);

  // Add user message to history
  if (userMessage) {
    history.push({ role: 'user', content: userMessage });
  }

  const abortController = new AbortController();
  activeRunControllers.set(runId, abortController);
  activeSessionRuns.set(sessionId, { runId, emit });

  const MAX_ITERATIONS = parseInt(process.env.AGENT_MAX_ITERATIONS || '100', 10);
  let iteration = 0;
  let finishedSummary = null;

  try {
    while (iteration < MAX_ITERATIONS) {
      if (abortController.signal.aborted) {
        emit('done', { summary: 'Run was cancelled by user.' });
        return;
      }

      iteration++;

      // Build fresh system prompt on each iteration to reflect current guild state & dry-run mode
      const systemPrompt = await buildSystemPrompt();

      // Assemble messages array with fresh system prompt at index 0 and sanitize structure
      const rawMessages = [
        { role: 'system', content: systemPrompt },
        ...history
      ];
      const messages = sanitizeMessagesForProvider(rawMessages);

      const requestPayload = {
        model,
        messages,
        tools: getOpenAITools(),
        stream: true
      };

      const effort = options.reasoningEffort || currentConfig.reasoningEffort;
      if (effort && effort !== 'none' && effort !== 'off') {
        requestPayload.reasoning_effort = effort;
      }

      let stream;
      try {
        stream = await openai.chat.completions.create(requestPayload, {
          signal: abortController.signal
        });
      } catch (streamErr) {
        if (abortController.signal.aborted) {
          emit('done', { summary: 'Run was cancelled by user.' });
          return;
        }
        // If the model/provider rejected reasoning_effort, retry without it
        if (requestPayload.reasoning_effort && (streamErr.message?.includes('reasoning_effort') || streamErr.code === 'unsupported_parameter')) {
          delete requestPayload.reasoning_effort;
          stream = await openai.chat.completions.create(requestPayload, {
            signal: abortController.signal
          });
        } else {
          throw streamErr;
        }
      }

      let assistantText = '';
      const toolCallsMap = new Map(); // index -> { id, name, args }
      let insideThinkTag = false;

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        // Extract reasoning / thinking tokens from reasoning-focused models
        const reasoningText = delta.reasoning_content || delta.reasoning || delta.thought || '';
        if (reasoningText) {
          emit('reasoning_delta', { chunk: reasoningText });
        }

        if (delta.content) {
          const contentChunk = delta.content;

          // Check for embedded <think> ... </think> tags
          if (contentChunk.includes('<think>')) {
            insideThinkTag = true;
            const parts = contentChunk.split('<think>');
            if (parts[0]) {
              assistantText += parts[0];
              emit('assistant_delta', { chunk: parts[0] });
            }
            if (parts[1]) {
              if (parts[1].includes('</think>')) {
                insideThinkTag = false;
                const thinkSubparts = parts[1].split('</think>');
                emit('reasoning_delta', { chunk: thinkSubparts[0] });
                if (thinkSubparts[1]) {
                  assistantText += thinkSubparts[1];
                  emit('assistant_delta', { chunk: thinkSubparts[1] });
                }
              } else {
                emit('reasoning_delta', { chunk: parts[1] });
              }
            }
          } else if (insideThinkTag) {
            if (contentChunk.includes('</think>')) {
              insideThinkTag = false;
              const parts = contentChunk.split('</think>');
              emit('reasoning_delta', { chunk: parts[0] });
              if (parts[1]) {
                assistantText += parts[1];
                emit('assistant_delta', { chunk: parts[1] });
              }
            } else {
              emit('reasoning_delta', { chunk: contentChunk });
            }
          } else {
            assistantText += contentChunk;
            emit('assistant_delta', { chunk: contentChunk });
          }
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            let idx = tc.index;
            if (idx === undefined || idx === null) {
              idx = toolCallsMap.size > 0 ? toolCallsMap.size - 1 : 0;
            }

            // If a different tool name arrives on the same index, start a new index
            if (toolCallsMap.has(idx)) {
              const existing = toolCallsMap.get(idx);
              if (tc.function?.name && existing.name && existing.name !== tc.function.name) {
                idx = toolCallsMap.size;
              } else if (tc.id && existing.id && existing.id !== tc.id) {
                idx = toolCallsMap.size;
              }
            }

            if (!toolCallsMap.has(idx)) {
              toolCallsMap.set(idx, {
                id: tc.id || '',
                name: tc.function?.name || '',
                args: ''
              });
            }

            const item = toolCallsMap.get(idx);
            if (tc.id && !item.id) item.id = tc.id;
            if (tc.function?.name && !item.name) item.name = tc.function.name;
            if (tc.function?.arguments) item.args += tc.function.arguments;
          }
        }
      }

      // If no tool calls were made, the turn is finished (standard prose response)
      if (toolCallsMap.size === 0) {
        if (assistantText) {
          history.push({ role: 'assistant', content: assistantText });
        }
        break;
      }

      // Normalize and expand any concatenated JSON tool calls (e.g. Gemini `{...}{...}`) into individual calls
      const formattedToolCalls = [];
      const parsedCallsToExecute = [];

      for (const [idx, tc] of toolCallsMap.entries()) {
        const rawToolName = tc.name;
        const toolName = resolveToolName(rawToolName) || rawToolName;
        const rawArgs = tc.args;
        const parsedList = parseAndSplitToolArguments(rawArgs);

        if (!parsedList || parsedList.length === 0) {
          // Push as single failed call
          const callId = tc.id && tc.id.trim() !== '' ? tc.id : `call_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 7)}`;
          formattedToolCalls.push({
            id: callId,
            type: 'function',
            function: { name: toolName, arguments: rawArgs }
          });
          parsedCallsToExecute.push({
            id: callId,
            name: toolName,
            args: null,
            rawArgs,
            parseError: 'Invalid JSON arguments'
          });
        } else {
          // Create a distinct, valid tool call for each object
          parsedList.forEach((parsedObj, subIdx) => {
            const callId = (parsedList.length === 1 && tc.id && tc.id.trim() !== '')
              ? tc.id
              : `call_${Date.now()}_${idx}_${subIdx}_${Math.random().toString(36).slice(2, 7)}`;
            
            const cleanArgsStr = JSON.stringify(parsedObj);
            formattedToolCalls.push({
              id: callId,
              type: 'function',
              function: { name: toolName, arguments: cleanArgsStr }
            });
            parsedCallsToExecute.push({
              id: callId,
              name: toolName,
              args: parsedObj,
              rawArgs: cleanArgsStr,
              parseError: null
            });
          });
        }
      }

      history.push({
        role: 'assistant',
        content: assistantText || null,
        tool_calls: formattedToolCalls
      });

      let madeMutations = false;

      // Execute each tool call sequentially
      for (const callItem of parsedCallsToExecute) {
        if (abortController.signal.aborted) {
          emit('done', { summary: 'Run was cancelled by user.' });
          return;
        }

        const { id: callId, name: rawToolName, args: parsedArgs, parseError } = callItem;
        const toolName = resolveToolName(rawToolName) || rawToolName;

        if (parseError) {
          const errorResult = { ok: false, error: parseError };
          emit('tool_call', { name: toolName, args: callItem.rawArgs, callId });
          emit('tool_result', { name: toolName, ok: false, summary: errorResult.error, callId });
          history.push({
            role: 'tool',
            tool_call_id: callId,
            content: JSON.stringify(errorResult)
          });
          continue;
        }

        const tool = toolsRegistry.get(toolName);
        if (!tool) {
          const errorResult = { ok: false, error: `Unknown tool: "${toolName}"` };
          emit('tool_call', { name: toolName, args: parsedArgs, callId });
          emit('tool_result', { name: toolName, ok: false, summary: errorResult.error, callId });
          history.push({
            role: 'tool',
            tool_call_id: callId,
            content: JSON.stringify(errorResult)
          });
          continue;
        }

        // Validate with Zod
        const validation = tool.schema.safeParse(parsedArgs);
        if (!validation.success) {
          const zodErrors = validation.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
          const errorResult = { ok: false, error: `Schema validation failed: ${zodErrors}` };
          emit('tool_call', { name: toolName, args: parsedArgs, callId });
          emit('tool_result', { name: toolName, ok: false, summary: errorResult.error, callId });
          history.push({
            role: 'tool',
            tool_call_id: callId,
            content: JSON.stringify(errorResult)
          });
          continue;
        }

        emit('tool_call', { name: toolName, args: validation.data, callId });

        // Approval Gate for destructive tools when dryRun is OFF
        let toolExecutionResult;
        const dryRun = isDryRun();

        const toolContext = {
          emit,
          runId,
          callId,
          onProgress: (progressData) => {
            emit('tool_progress', {
              callId,
              name: toolName,
              ...progressData
            });
          }
        };

        if (tool.destructive && !dryRun) {
          emit('approval_required', {
            runId,
            callId,
            name: toolName,
            args: validation.data
          });

          // Wait for approval response
          const approved = await new Promise((resolve) => {
            pendingApprovals.set(`${runId}:${callId}`, { resolve });
          });

          if (!approved) {
            toolExecutionResult = { ok: false, error: 'User denied this action.' };
          } else {
            toolExecutionResult = await tool.handler(validation.data, toolContext);
          }
        } else {
          toolExecutionResult = await tool.handler(validation.data, toolContext);
        }

        if (toolExecutionResult.ok && !['get_guild_snapshot', 'list_roles', 'finish'].includes(toolName)) {
          madeMutations = true;
        }

        if (toolName === 'finish' && toolExecutionResult.ok) {
          finishedSummary = validation.data.summary;
        }

        const summaryText = toolExecutionResult.ok
          ? (typeof toolExecutionResult.result === 'object' ? JSON.stringify(toolExecutionResult.result) : String(toolExecutionResult.result))
          : toolExecutionResult.error;

        emit('tool_result', {
          name: toolName,
          ok: toolExecutionResult.ok,
          summary: summaryText,
          callId
        });

        const contentString = truncateString(JSON.stringify(toolExecutionResult));
        history.push({
          role: 'tool',
          tool_call_id: callId,
          content: contentString
        });
      }

      if (madeMutations) {
        emit('snapshot_updated', {});
      }

      if (finishedSummary) {
        emit('done', { summary: finishedSummary });
        break;
      }
    }

    if (iteration >= MAX_ITERATIONS) {
      emit('error', { message: `Maximum iteration limit (${MAX_ITERATIONS}) reached. Stopping loop.` });
      emit('done', { summary: 'Reached max step limit.' });
    } else if (!finishedSummary) {
      emit('done', { summary: 'Turn complete.' });
    }
  } catch (err) {
    if (!abortController.signal.aborted) {
      console.error('Agent loop encountered error:', err);
      emit('error', { message: err.message || 'Unknown error occurred in agent loop.' });
      emit('done', { summary: 'Error terminated the run.' });
    }
  } finally {
    activeRunControllers.delete(runId);
    if (activeSessionRuns.get(sessionId)?.runId === runId) {
      activeSessionRuns.delete(sessionId);
    }
  }
}
