/**
 * Discord Architect Frontend Application
 */

// State
let currentRunId = null;
let activeEventSource = null;
let pendingApprovalData = null;

// DOM Elements
const serverNameEl = document.getElementById('serverName');
const serverMetaEl = document.getElementById('serverMeta');
const serverAvatarEl = document.getElementById('serverAvatar');
const modelInput = document.getElementById('modelInput');
const modelList = document.getElementById('modelList');
const btnRefreshModels = document.getElementById('btnRefreshModels');
const reasoningSelect = document.getElementById('reasoningSelect');
const btnOpenSetup = document.getElementById('btnOpenSetup');
const setupBtnLabel = document.getElementById('setupBtnLabel');
const roleWarningBanner = document.getElementById('roleWarningBanner');
const dryRunToggle = document.getElementById('dryRunToggle');
const btnReset = document.getElementById('btnReset');
const btnRefreshTree = document.getElementById('btnRefreshTree');
const guildTreeContainer = document.getElementById('guildTreeContainer');
const rolesListContainer = document.getElementById('rolesListContainer');
const rolesCountEl = document.getElementById('rolesCount');
const rolesHeaderToggle = document.getElementById('rolesHeaderToggle');
const rolesToggleArrow = document.getElementById('rolesToggleArrow');
const messagesContainer = document.getElementById('messagesContainer');
const chatInput = document.getElementById('chatInput');
const btnSend = document.getElementById('btnSend');
const btnCancelRun = document.getElementById('btnCancelRun');
const runStatusIndicator = document.getElementById('runStatusIndicator');
const connectionStatus = document.getElementById('connectionStatus');

// Setup Modal Elements
const setupModal = document.getElementById('setupModal');
const setupDiscordToken = document.getElementById('setupDiscordToken');
const setupDiscordGuildId = document.getElementById('setupDiscordGuildId');
const btnTestDiscord = document.getElementById('btnTestDiscord');
const discordTestFeedback = document.getElementById('discordTestFeedback');
const setupAIBaseURL = document.getElementById('setupAIBaseURL');
const setupAIApiKey = document.getElementById('setupAIApiKey');
const setupAIModel = document.getElementById('setupAIModel');
const setupAIReasoning = document.getElementById('setupAIReasoning');
const btnSaveSetup = document.getElementById('btnSaveSetup');
const btnSetupClose = document.getElementById('btnSetupClose');

// Approval Modal Elements
const approvalModal = document.getElementById('approvalModal');
const modalToolName = document.getElementById('modalToolName');
const modalToolArgs = document.getElementById('modalToolArgs');
const btnModalApprove = document.getElementById('btnModalApprove');
const btnModalDeny = document.getElementById('btnModalDeny');

// -------------------------------------------------------------
// Initialization
// -------------------------------------------------------------
async function init() {
  await fetchState();
  await fetchSnapshot();
  await fetchModels();
  setupEventListeners();
  autoResizeTextarea(chatInput);
}

// -------------------------------------------------------------
// API Calls
// -------------------------------------------------------------
async function fetchState() {
  try {
    const res = await fetch('/api/state');
    const data = await res.json();
    if (!data.ok) {
      console.error('Failed to load server state:', data.error);
      serverNameEl.textContent = 'Setup Required';
      serverMetaEl.textContent = data.error || 'Click Setup to configure';
      connectionStatus.className = 'connection-status offline';
      connectionStatus.querySelector('.status-label').textContent = 'Setup';
      btnOpenSetup.classList.add('unconfigured');
      setupBtnLabel.textContent = '⚡ Run Setup';
      // Auto open setup wizard if not configured
      openSetupModal();
      return;
    }

    if (data.configured === false) {
      serverNameEl.textContent = 'Setup Required';
      serverMetaEl.textContent = 'Click Setup & Config';
      btnOpenSetup.classList.add('unconfigured');
      setupBtnLabel.textContent = '⚡ Run Setup';
      connectionStatus.className = 'connection-status offline';
      connectionStatus.querySelector('.status-label').textContent = 'Setup';
      openSetupModal();
      return;
    }

    btnOpenSetup.classList.remove('unconfigured');
    setupBtnLabel.textContent = 'Setup & Config';
    serverNameEl.textContent = data.guild.name;
    serverMetaEl.textContent = `${data.guild.memberCount} members • ${data.channelCount}/${data.maxChannels} channels`;
    
    if (data.model && !modelInput.value) {
      modelInput.value = data.model;
    }

    if (data.reasoningEffort && reasoningSelect) {
      reasoningSelect.value = data.reasoningEffort;
    }
    
    dryRunToggle.checked = data.dryRun;

    if (data.guild.iconURL) {
      serverAvatarEl.innerHTML = `<img src="${data.guild.iconURL}" alt="Server Icon" />`;
    } else {
      serverAvatarEl.textContent = data.guild.name ? data.guild.name.slice(0, 2).toUpperCase() : '🏰';
    }

    if (data.roleHierarchyWarning) {
      roleWarningBanner.style.display = 'flex';
    } else {
      roleWarningBanner.style.display = 'none';
    }

    connectionStatus.className = 'connection-status';
    connectionStatus.querySelector('.status-label').textContent = 'Online';
  } catch (err) {
    console.error('Error fetching state:', err);
    connectionStatus.className = 'connection-status offline';
    connectionStatus.querySelector('.status-label').textContent = 'Offline';
  }
}

async function fetchSnapshot() {
  try {
    const res = await fetch('/api/snapshot');
    const data = await res.json();
    if (data.ok && data.snapshot) {
      renderGuildTree(data.snapshot);
      renderRoles(data.snapshot.roles || []);
    }
  } catch (err) {
    console.error('Error fetching snapshot:', err);
  }
}

async function fetchModels() {
  btnRefreshModels.classList.add('spinning');
  try {
    const res = await fetch('/api/models');
    const data = await res.json();

    const models = data.models || data.fallbackModels || [];
    if (models.length > 0) {
      modelList.innerHTML = '';
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m;
        modelList.appendChild(opt);
      }
    }

    if (data.currentModel && !modelInput.value) {
      modelInput.value = data.currentModel;
    }
  } catch (err) {
    console.warn('Failed to load models list from server:', err);
  } finally {
    btnRefreshModels.classList.remove('spinning');
  }
}

async function openSetupModal() {
  try {
    const res = await fetch('/api/setup');
    const data = await res.json();
    if (data.ok) {
      setupDiscordGuildId.value = data.discordGuildId || '';
      setupDiscordToken.value = '';
      setupDiscordToken.placeholder = data.hasDiscordToken ? '•••••••••••••••• (configured in .env)' : 'Paste Discord bot token...';
      setupAIBaseURL.value = data.baseURL || '';
      setupAIModel.value = data.model || modelInput.value || 'gemini-3.7-flash';
      if (setupAIReasoning) {
        setupAIReasoning.value = data.reasoningEffort || 'none';
      }
      setupAIApiKey.value = '';
      setupAIApiKey.placeholder = data.aiConfigured ? '•••••••••••••••• (configured in .env)' : 'Paste API key (leave blank for local models)...';
      discordTestFeedback.textContent = '';
      discordTestFeedback.className = 'test-feedback';
    }
  } catch (err) {
    console.error('Failed to load setup info:', err);
  }
  setupModal.style.display = 'flex';
}

async function testDiscordConnection() {
  const token = setupDiscordToken.value.trim();
  const guildId = setupDiscordGuildId.value.trim();

  discordTestFeedback.className = 'test-feedback';
  discordTestFeedback.textContent = 'Connecting to Discord...';

  try {
    const res = await fetch('/api/setup/test-discord', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, guildId })
    });

    const data = await res.json();
    if (data.ok) {
      discordTestFeedback.className = 'test-feedback success';
      discordTestFeedback.textContent = `✓ Connected to "${data.result?.guild?.name || 'Guild'}"!`;
    } else {
      discordTestFeedback.className = 'test-feedback error';
      discordTestFeedback.textContent = `✗ ${data.error || 'Connection failed'}`;
    }
  } catch (err) {
    discordTestFeedback.className = 'test-feedback error';
    discordTestFeedback.textContent = `✗ Network error: ${err.message}`;
  }
}

async function saveFullSetup() {
  const discordBotToken = setupDiscordToken.value.trim();
  const discordGuildId = setupDiscordGuildId.value.trim();
  const openAiBaseUrl = setupAIBaseURL.value.trim();
  const openAiApiKey = setupAIApiKey.value.trim();
  const openAiModel = setupAIModel.value.trim() || modelInput.value.trim() || 'gemini-3.7-flash';
  const reasoningEffort = setupAIReasoning ? setupAIReasoning.value : 'none';

  btnSaveSetup.textContent = 'Saving & Connecting...';
  btnSaveSetup.disabled = true;

  try {
    const payload = {
      openAiBaseUrl,
      openAiModel,
      reasoningEffort
    };
    if (discordBotToken) payload.discordBotToken = discordBotToken;
    if (discordGuildId) payload.discordGuildId = discordGuildId;
    if (openAiApiKey) payload.openAiApiKey = openAiApiKey;

    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (data.ok) {
      modelInput.value = openAiModel;
      if (reasoningSelect) reasoningSelect.value = reasoningEffort;
      setupModal.style.display = 'none';
      await fetchState();
      await fetchSnapshot();
      await fetchModels();
    } else {
      alert(`Setup error: ${data.error}`);
    }
  } catch (err) {
    alert(`Failed to save setup: ${err.message}`);
  } finally {
    btnSaveSetup.textContent = 'Save Configuration & Connect';
    btnSaveSetup.disabled = false;
  }
}

// -------------------------------------------------------------
// Guild Tree & Roles Rendering
// -------------------------------------------------------------
function getChannelIcon(type) {
  switch (type) {
    case 'text':
      return '#';
    case 'voice':
      return '🔊';
    case 'announcement':
      return '📢';
    case 'forum':
      return '��';
    case 'stage':
      return '🎙️';
    default:
      return '#';
  }
}

function renderGuildTree(snapshot) {
  let html = '';

  // Uncategorized Channels
  if (snapshot.uncategorized && snapshot.uncategorized.length > 0) {
    html += `<div class="tree-category">
      <div class="category-header">
        <span>UNCATEGORIZED</span>
      </div>
      <div class="category-channels">`;
    for (const ch of snapshot.uncategorized) {
      html += renderChannelItem(ch);
    }
    html += `</div></div>`;
  }

  // Categories
  if (snapshot.categories && snapshot.categories.length > 0) {
    for (const cat of snapshot.categories) {
      html += `<div class="tree-category">
        <div class="category-header">
          ${cat.private ? '<span class="lock-icon" title="Private category">🔒</span>' : ''}
          <span>${escapeHtml(cat.name)}</span>
        </div>
        <div class="category-channels">`;
      for (const ch of cat.channels) {
        html += renderChannelItem(ch);
      }
      html += `</div></div>`;
    }
  }

  if (!html) {
    html = '<div class="loading-placeholder">No channels found in this server.</div>';
  }

  guildTreeContainer.innerHTML = html;
}

function renderChannelItem(ch) {
  return `
    <div class="channel-item" title="ID: ${ch.id}">
      <div class="channel-left">
        <span class="channel-icon">${getChannelIcon(ch.type)}</span>
        <span class="channel-name">${escapeHtml(ch.name)}</span>
      </div>
      <div class="channel-badges">
        ${ch.private ? '<span class="badge-lock" title="Private">🔒</span>' : ''}
      </div>
    </div>
  `;
}

function renderRoles(roles) {
  rolesCountEl.textContent = roles.length;
  let html = '';

  for (const role of roles) {
    const color = role.color && role.color !== '#000000' ? role.color : '#99aab5';
    const keyPermsStr = role.keyPerms && role.keyPerms.length > 0 ? role.keyPerms.join(', ') : 'No key permissions';

    html += `
      <div class="role-chip" title="${keyPermsStr}">
        <div class="role-left">
          <span class="role-color-dot" style="background-color: ${color}"></span>
          <span class="role-name">${escapeHtml(role.name)}</span>
        </div>
        <span class="role-perms">${role.position}</span>
      </div>
    `;
  }

  rolesListContainer.innerHTML = html;
}

// -------------------------------------------------------------
// Chat & SSE Streaming
// -------------------------------------------------------------
async function sendMessage(text) {
  const message = text || chatInput.value.trim();
  if (!message) return;

  const activeModel = modelInput.value.trim() || 'gemini-3.7-flash';
  const reasoningEffort = reasoningSelect ? reasoningSelect.value : 'none';

  chatInput.value = '';
  autoResizeTextarea(chatInput);
  setInputState(false, `Architect (${activeModel}) is working...`);

  // Render User Message
  appendUserMessage(message);

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        model: activeModel,
        reasoningEffort
      })
    });

    const data = await res.json();
    if (!data.ok) {
      appendErrorMessage(data.error || 'Failed to start run');
      setInputState(true);
      return;
    }

    if (data.steered) {
      runStatusIndicator.textContent = 'Steered agent with new instruction...';
      return;
    }

    currentRunId = data.runId;
    listenToStream(currentRunId);
  } catch (err) {
    console.error('Chat request failed:', err);
    appendErrorMessage(`Network error: ${err.message}`);
    setInputState(true);
  }
}

function listenToStream(runId) {
  if (activeEventSource) {
    activeEventSource.close();
  }

  let activeAssistantBubble = null;
  let activeThinkingCard = null;
  let accumulatedThought = '';
  let accumulatedText = '';
  const activeToolCards = new Map(); // callId -> element

  const es = new EventSource(`/api/stream/${runId}`);
  activeEventSource = es;

  es.addEventListener('reasoning_delta', (e) => {
    const data = JSON.parse(e.data);
    if (!activeThinkingCard) {
      activeThinkingCard = createThinkingCard();
      messagesContainer.appendChild(activeThinkingCard);
    }
    accumulatedThought += data.chunk;
    const bodyEl = activeThinkingCard.querySelector('.thinking-body');
    if (bodyEl) {
      bodyEl.textContent = accumulatedThought;
    }
    scrollToBottom();
  });

  es.addEventListener('assistant_delta', (e) => {
    const data = JSON.parse(e.data);
    if (activeThinkingCard) {
      activeThinkingCard.classList.remove('streaming');
      const icon = activeThinkingCard.querySelector('.thinking-icon');
      if (icon) icon.classList.remove('pulsing');
    }

    if (!activeAssistantBubble) {
      activeAssistantBubble = createAssistantMessageElement();
    }
    accumulatedText += data.chunk;
    activeAssistantBubble.innerHTML = renderMarkdown(accumulatedText);
    scrollToBottom();
  });

  es.addEventListener('tool_call', (e) => {
    const data = JSON.parse(e.data);
    if (activeThinkingCard) {
      activeThinkingCard.classList.remove('streaming');
    }
    activeAssistantBubble = null; // Next text creates a new bubble after the tool card
    const card = createToolCard(data.name, data.args, data.callId);
    activeToolCards.set(data.callId, card);
    messagesContainer.appendChild(card);
    scrollToBottom();
  });

  es.addEventListener('tool_progress', (e) => {
    const data = JSON.parse(e.data);
    const card = activeToolCards.get(data.callId);
    if (card) {
      updateToolCardProgress(card, data);
    }
    scrollToBottom();
  });

  es.addEventListener('tool_result', (e) => {
    const data = JSON.parse(e.data);
    const card = activeToolCards.get(data.callId);
    if (card) {
      updateToolCardResult(card, data.name, data.ok, data.summary);
    }
    scrollToBottom();
  });

  es.addEventListener('approval_required', (e) => {
    const data = JSON.parse(e.data);
    showApprovalModal(data);
  });

  es.addEventListener('snapshot_updated', () => {
    fetchSnapshot();
    fetchState();
  });

  es.addEventListener('steer', (e) => {
    runStatusIndicator.textContent = 'Instruction received mid-flight...';
    activeAssistantBubble = null;
    accumulatedText = '';
  });

  es.addEventListener('done', (e) => {
    const data = JSON.parse(e.data);
    if (activeThinkingCard) {
      activeThinkingCard.classList.remove('streaming');
      const icon = activeThinkingCard.querySelector('.thinking-icon');
      if (icon) icon.classList.remove('pulsing');
    }
    setInputState(true);
    if (data.summary && data.summary !== 'Turn complete.') {
      runStatusIndicator.textContent = 'Finished';
    } else {
      runStatusIndicator.textContent = '';
    }
    es.close();
    activeEventSource = null;
  });

  es.addEventListener('error', (e) => {
    try {
      const data = JSON.parse(e.data);
      appendErrorMessage(data.message || 'Error occurred in stream');
    } catch (_) {
      // EventSource generic error
    }
    if (activeThinkingCard) {
      activeThinkingCard.classList.remove('streaming');
    }
    setInputState(true);
    es.close();
    activeEventSource = null;
  });
}

// -------------------------------------------------------------
// Message DOM Helpers
// -------------------------------------------------------------
function appendUserMessage(text) {
  const row = document.createElement('div');
  row.className = 'message-row user';
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = text;
  row.appendChild(bubble);
  messagesContainer.appendChild(row);
  scrollToBottom();
}

function createAssistantMessageElement() {
  const row = document.createElement('div');
  row.className = 'message-row assistant';
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  row.appendChild(bubble);
  messagesContainer.appendChild(row);
  return bubble;
}

function createThinkingCard() {
  const card = document.createElement('div');
  card.className = 'thinking-card expanded streaming';
  card.innerHTML = `
    <div class="thinking-header">
      <div class="thinking-header-left">
        <span class="thinking-icon pulsing">🧠</span>
        <span class="thinking-title">Chain of Thought / Reasoning</span>
      </div>
      <span class="thinking-chevron">▼</span>
    </div>
    <div class="thinking-body"></div>
  `;

  card.querySelector('.thinking-header').addEventListener('click', () => {
    card.classList.toggle('expanded');
  });

  return card;
}

function appendErrorMessage(text) {
  const row = document.createElement('div');
  row.className = 'message-row assistant';
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.style.borderColor = 'var(--red-danger)';
  bubble.style.color = 'var(--red-danger)';
  bubble.innerHTML = `<strong>Error:</strong> ${escapeHtml(text)}`;
  row.appendChild(bubble);
  messagesContainer.appendChild(row);
  scrollToBottom();
}

function extractBatchItems(name, args) {
  if (!args) return [];
  if (name === 'batch_create_structure') {
    const list = [];
    (args.roles || []).forEach((r) => list.push({ key: `@${r.name}`, label: `@${r.name}`, type: 'role' }));
    (args.categories || []).forEach((cat) => {
      list.push({ key: `📁 ${cat.name}`, label: `📁 ${cat.name}`, type: 'category' });
      (cat.channels || []).forEach((ch) => list.push({ key: `#${ch.name}`, label: `#${ch.name}`, type: 'channel' }));
    });
    (args.uncategorized_channels || []).forEach((ch) => list.push({ key: `#${ch.name}`, label: `#${ch.name}`, type: 'channel' }));
    return list;
  }
  if (name === 'batch_create_channels') {
    return (args.channels || []).map((ch) => ({ key: `#${ch.name}`, label: `#${ch.name}`, type: 'channel' }));
  }
  if (name === 'batch_create_categories') {
    return (args.categories || []).map((cat) => ({ key: `📁 ${cat.name}`, label: `📁 ${cat.name}`, type: 'category' }));
  }
  if (name === 'batch_create_roles') {
    return (args.roles || []).map((r) => ({ key: `@${r.name}`, label: `@${r.name}`, type: 'role' }));
  }
  if (name === 'batch_edit_channels') {
    return (args.channels || []).map((ch) => ({ key: `#${ch.name || ch.channel_id}`, label: `#${ch.name || ch.channel_id}`, type: 'channel' }));
  }
  if (name === 'batch_delete_channels') {
    return (args.channel_ids || []).map((id) => ({ key: id, label: `Channel ${id}`, type: 'channel' }));
  }
  if (name === 'batch_move_channels') {
    return (args.moves || []).map((m) => ({ key: m.channel_id, label: `Move ${m.channel_id}`, type: 'channel' }));
  }
  if (name === 'batch_edit_roles') {
    return (args.roles || []).map((r) => ({ key: `@${r.name || r.role_id}`, label: `@${r.name || r.role_id}`, type: 'role' }));
  }
  if (name === 'batch_delete_roles') {
    return (args.role_ids || []).map((id) => ({ key: id, label: `Role ${id}`, type: 'role' }));
  }
  if (name === 'batch_set_channel_permissions') {
    return (args.overwrites || []).map((ow) => ({ key: `${ow.channel_id} / ${ow.target_id}`, label: `Perm: ${ow.channel_id}`, type: 'permission' }));
  }
  if (name === 'batch_send_messages') {
    return (args.messages || []).map((m) => ({ key: m.channel_id, label: `Msg: ${m.channel_id}`, type: 'message' }));
  }
  return [];
}

function createToolCard(name, args, callId) {
  const card = document.createElement('div');
  card.className = 'tool-card running';
  card.id = `tool-${callId}`;

  const summary = formatToolArgsSummary(name, args);
  const items = extractBatchItems(name, args);
  const isBatch = items.length > 0;

  let itemsHtml = '';
  if (isBatch) {
    itemsHtml = items
      .map(
        (item, idx) => `
      <span class="tool-progress-item" data-key="${escapeHtml(item.key)}" id="item-${callId}-${idx}">
        <span class="item-icon">·</span>
        <span class="item-label">${escapeHtml(item.label)}</span>
      </span>
    `
      )
      .join('');
  }

  card.innerHTML = `
    <div class="tool-card-header">
      <div class="tool-header-left">
        <span class="tool-status-icon running">⏳</span>
        <span class="tool-name">${escapeHtml(name)}</span>
        <span class="tool-summary">${escapeHtml(summary)}</span>
      </div>
      <div class="tool-header-right">
        ${isBatch ? `<span class="tool-progress-badge">0/${items.length}</span>` : ''}
        <span class="tool-chevron">▼</span>
      </div>
    </div>
    ${
      isBatch
        ? `
    <div class="tool-live-progress">
      <div class="tool-progress-bar-wrapper">
        <div class="tool-progress-bar-fill" style="width: 0%;"></div>
      </div>
      <div class="tool-progress-info">
        <span class="tool-progress-status">⏳ Processing ${items.length} items...</span>
        <span class="tool-progress-counter">0 / ${items.length} (0%)</span>
      </div>
      <div class="tool-progress-items-list">${itemsHtml}</div>
    </div>
    `
        : ''
    }
    <div class="tool-card-body">
      <div class="tool-json-section">
        <div class="tool-json-label">Arguments</div>
        <pre class="tool-json-content">${escapeHtml(JSON.stringify(args, null, 2))}</pre>
      </div>
      <div class="tool-json-section result-section" style="display: none;">
        <div class="tool-json-label">Result</div>
        <pre class="tool-json-content result-content"></pre>
      </div>
    </div>
  `;

  // Toggle accordion expand
  card.querySelector('.tool-card-header').addEventListener('click', () => {
    card.classList.toggle('expanded');
  });

  return card;
}

function updateToolCardProgress(card, data) {
  const { current, total, item, status, message } = data;
  const percentage = Math.min(100, Math.round((current / (total || 1)) * 100));

  const badge = card.querySelector('.tool-progress-badge');
  if (badge) {
    badge.textContent = `${current}/${total}`;
  }

  const fill = card.querySelector('.tool-progress-bar-fill');
  if (fill) {
    fill.style.width = `${percentage}%`;
  }

  const statusEl = card.querySelector('.tool-progress-status');
  if (statusEl) {
    statusEl.innerHTML = escapeHtml(message || `Processing ${item || ''}...`);
  }

  const counter = card.querySelector('.tool-progress-counter');
  if (counter) {
    counter.textContent = `${current} / ${total} (${percentage}%)`;
  }

  // Update specific item in items list
  if (item) {
    const itemsList = card.querySelector('.tool-progress-items-list');
    if (itemsList) {
      const allItems = itemsList.querySelectorAll('.tool-progress-item');
      let matchedItem = null;

      // Try exact key match or name match
      for (const el of allItems) {
        const key = el.getAttribute('data-key');
        if (key === item || key.replace(/^[@#📁\s]/, '') === item.replace(/^[@#📁\s]/, '') || key.includes(item)) {
          matchedItem = el;
          break;
        }
      }

      // If not matched, try by index
      if (!matchedItem && allItems[current - 1]) {
        matchedItem = allItems[current - 1];
      }

      if (matchedItem) {
        matchedItem.classList.remove('active');
        if (status === 'failed') {
          matchedItem.classList.add('failed');
          const iconEl = matchedItem.querySelector('.item-icon');
          if (iconEl) iconEl.textContent = '✗';
        } else {
          matchedItem.classList.add('done');
          const iconEl = matchedItem.querySelector('.item-icon');
          if (iconEl) iconEl.textContent = '✓';
        }
      }

      // Mark the next item active
      if (allItems[current]) {
        allItems[current].classList.add('active');
        const iconEl = allItems[current].querySelector('.item-icon');
        if (iconEl) iconEl.textContent = '⏳';
      }
    }
  }
}

function updateToolCardResult(card, name, ok, summary) {
  card.classList.remove('running');
  card.classList.add(ok ? 'success' : 'failed');

  const statusIcon = card.querySelector('.tool-status-icon');
  if (statusIcon) {
    statusIcon.className = 'tool-status-icon';
    statusIcon.textContent = ok ? '✓' : '✗';
    statusIcon.style.color = ok ? 'var(--green-safe)' : 'var(--red-danger)';
  }

  const fill = card.querySelector('.tool-progress-bar-fill');
  if (fill && ok) {
    fill.style.width = '100%';
  }

  const badge = card.querySelector('.tool-progress-badge');
  if (badge && ok) {
    badge.textContent = 'Done ✓';
  }

  const progressStatus = card.querySelector('.tool-progress-status');
  if (progressStatus) {
    progressStatus.innerHTML = ok ? '✓ All batch operations completed successfully' : '✗ Batch operation finished with errors';
  }

  const toolSummary = card.querySelector('.tool-summary');
  if (toolSummary) {
    if (!ok) {
      const errorText = typeof summary === 'object' ? (summary.error || JSON.stringify(summary)) : String(summary);
      toolSummary.textContent = `✗ ${errorText}`;
      toolSummary.classList.add('error-summary');
      // Auto-expand failed tool cards so the user can inspect the failure immediately
      card.classList.add('expanded');
    }
  }

  const resultSection = card.querySelector('.result-section');
  const resultContent = card.querySelector('.result-content');
  if (resultSection && resultContent) {
    resultSection.style.display = 'block';
    const label = card.querySelector('.tool-json-section.result-section .tool-json-label');
    if (label) {
      label.textContent = ok ? 'Result' : 'Error Details';
      label.style.color = ok ? 'var(--text-dim)' : 'var(--red-danger)';
    }
    resultContent.textContent = typeof summary === 'object' ? JSON.stringify(summary, null, 2) : String(summary);
  }
}

function formatToolArgsSummary(name, args) {
  if (!args) return '';
  if (name === 'batch_create_structure') {
    const rCount = args.roles?.length || 0;
    const cCount = args.categories?.length || 0;
    return `🚀 Deploy full server (${cCount} categories, ${rCount} roles)`;
  }
  if (name === 'batch_create_categories') return `📁 Batch create ${args.categories?.length || 0} categories`;
  if (name === 'batch_create_channels') return `📺 Batch create ${args.channels?.length || 0} channels`;
  if (name === 'batch_create_roles') return `🎭 Batch create ${args.roles?.length || 0} roles`;
  if (name === 'batch_edit_channels') return `✏️ Batch rename/edit ${args.channels?.length || 0} channels`;
  if (name === 'batch_delete_channels') return `🗑️ Batch delete ${args.channel_ids?.length || 0} channels`;
  if (name === 'batch_move_channels') return `📦 Batch move ${args.moves?.length || 0} channels`;
  if (name === 'batch_edit_roles') return `🎭 Batch edit ${args.roles?.length || 0} roles`;
  if (name === 'batch_delete_roles') return `��️ Batch delete ${args.role_ids?.length || 0} roles`;
  if (name === 'batch_set_channel_permissions') return `🔐 Batch set permissions on ${args.overwrites?.length || 0} targets`;
  if (name === 'batch_send_messages') return `💬 Batch send ${args.messages?.length || 0} messages`;
  if (name === 'create_channel') return `#${args.name} (${args.type})`;
  if (name === 'create_category') return `📁 ${args.name}${args.private ? ' [Private]' : ''}`;
  if (name === 'create_role') return `🎭 ${args.name}`;
  if (name === 'edit_channel') return `ID: ${args.channel_id} (name: ${args.name || 'unaltered'})`;
  if (name === 'delete_channel') return `ID: ${args.channel_id}`;
  if (name === 'delete_role') return `ID: ${args.role_id}`;
  if (name === 'set_channel_permissions') return `Target: ${args.target_id}`;
  if (name === 'send_message') return `Channel: ${args.channel_id}`;
  if (name === 'list_members') return args.query ? `Search: "${args.query}"` : 'All members';
  if (name === 'assign_member_role') return `Member: ${args.member_id} -> Role: ${args.role_id}`;
  if (name === 'remove_member_role') return `Member: ${args.member_id} -x Role: ${args.role_id}`;
  if (name === 'set_member_nickname') return `Member: ${args.member_id} -> Nick: "${args.nickname || 'reset'}"`;
  if (name === 'timeout_member') return `Member: ${args.member_id} (${args.duration_minutes ? args.duration_minutes + ' min' : 'remove timeout'})`;
  if (name === 'kick_member') return `Kick: ${args.member_id}`;
  if (name === 'ban_member') return `Ban: ${args.user_id}`;
  if (name === 'unban_member') return `Unban: ${args.user_id}`;
  if (name === 'list_bans') return 'List server bans';
  if (name === 'get_channel_messages') return `Channel: ${args.channel_id} (limit: ${args.limit || 50})`;
  if (name === 'edit_message') return `Msg: ${args.message_id} in ${args.channel_id}`;
  if (name === 'delete_message') return `Delete Msg: ${args.message_id} in ${args.channel_id}`;
  if (name === 'purge_messages') return `Purge ${args.count} msgs in ${args.channel_id}`;
  if (name === 'pin_message') return `${args.pinned !== false ? 'Pin' : 'Unpin'} Msg: ${args.message_id}`;
  if (name === 'edit_guild') return `Server settings: ${args.name || 'assets/config'}`;
  if (name === 'list_emojis') return 'List custom emojis';
  if (name === 'create_emoji') return `Emoji: :${args.name}:`;
  if (name === 'edit_emoji') return `Edit emoji: ${args.emoji_id}`;
  if (name === 'delete_emoji') return `Delete emoji: ${args.emoji_id}`;
  if (name === 'list_stickers') return 'List stickers';
  if (name === 'create_sticker') return `Sticker: ${args.name}`;
  if (name === 'edit_sticker') return `Edit sticker: ${args.sticker_id}`;
  if (name === 'delete_sticker') return `Delete sticker: ${args.sticker_id}`;
  if (name === 'list_soundboard_sounds') return 'List soundboard sounds';
  if (name === 'create_soundboard_sound') return `Sound: ${args.name}`;
  if (name === 'edit_soundboard_sound') return `Edit sound: ${args.sound_id}`;
  if (name === 'delete_soundboard_sound') return `Delete sound: ${args.sound_id}`;
  if (name === 'list_automod_rules') return 'List auto-mod rules';
  if (name === 'create_automod_rule') return `AutoMod: ${args.name} (${args.trigger_type})`;
  if (name === 'edit_automod_rule') return `Edit AutoMod: ${args.rule_id}`;
  if (name === 'delete_automod_rule') return `Delete AutoMod: ${args.rule_id}`;
  if (name === 'list_webhooks') return args.channel_id ? `Webhooks in ${args.channel_id}` : 'All webhooks';
  if (name === 'create_webhook') return `Webhook: "${args.name}" in ${args.channel_id}`;
  if (name === 'edit_webhook') return `Edit webhook: ${args.webhook_id}`;
  if (name === 'delete_webhook') return `Delete webhook: ${args.webhook_id}`;
  if (name === 'send_webhook_message') return `Send via webhook ${args.webhook_id}`;
  if (name === 'list_integrations') return 'List integrations & bots';
  if (name === 'finish') return args.summary ? args.summary.slice(0, 60) + '...' : 'Complete';
  return JSON.stringify(args);
}

// -------------------------------------------------------------
// Approval Modal Handling
// -------------------------------------------------------------
function showApprovalModal(data) {
  pendingApprovalData = data;
  modalToolName.textContent = data.name;
  modalToolArgs.textContent = JSON.stringify(data.args, null, 2);
  approvalModal.style.display = 'flex';
}

async function respondApproval(approved) {
  if (!pendingApprovalData) return;
  const { runId, callId } = pendingApprovalData;

  approvalModal.style.display = 'none';
  pendingApprovalData = null;

  try {
    await fetch('/api/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId, callId, approved })
    });
  } catch (err) {
    console.error('Failed to submit approval:', err);
  }
}

// -------------------------------------------------------------
// Event Listeners
// -------------------------------------------------------------
function setupEventListeners() {
  // Chat input
  chatInput.addEventListener('input', () => {
    autoResizeTextarea(chatInput);
    btnSend.disabled = chatInput.value.trim() === '';
  });

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!btnSend.disabled) {
        sendMessage();
      }
    }
  });

  btnSend.addEventListener('click', () => sendMessage());

  // Cancel Run button
  btnCancelRun.addEventListener('click', async () => {
    if (currentRunId) {
      try {
        await fetch('/api/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId: currentRunId })
        });
      } catch (err) {
        console.error('Failed to cancel run:', err);
      }
    }
    if (activeEventSource) {
      activeEventSource.close();
      activeEventSource = null;
    }
    setInputState(true, 'Run stopped by user');
  });

  // Model refresh button
  btnRefreshModels.addEventListener('click', () => fetchModels());

  // Model input change
  modelInput.addEventListener('change', () => {
    const val = modelInput.value.trim();
    if (val) {
      fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: val })
      }).catch(console.error);
    }
  });

  // Reasoning Select change
  if (reasoningSelect) {
    reasoningSelect.addEventListener('change', () => {
      const val = reasoningSelect.value;
      fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reasoningEffort: val })
      }).catch(console.error);
    });
  }

  // Setup / Settings Modal
  btnOpenSetup.addEventListener('click', () => openSetupModal());
  btnSetupClose.addEventListener('click', () => {
    setupModal.style.display = 'none';
  });

  btnTestDiscord.addEventListener('click', () => testDiscordConnection());
  btnSaveSetup.addEventListener('click', () => saveFullSetup());

  // Tab switching inside Setup Modal
  document.querySelectorAll('.tab-btn').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
      tab.classList.add('active');
      const target = document.getElementById(tab.getAttribute('data-tab'));
      if (target) target.classList.add('active');
    });
  });

  // Preset chips in Setup Modal
  document.querySelectorAll('.preset-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const base = chip.getAttribute('data-base');
      const model = chip.getAttribute('data-model');
      setupAIBaseURL.value = base;
      setupAIModel.value = model;
    });
  });

  // Suggestion chips
  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const prompt = chip.getAttribute('data-prompt');
      if (prompt) {
        sendMessage(prompt);
      }
    });
  });

  // DRY RUN Toggle
  dryRunToggle.addEventListener('change', async () => {
    const enabled = dryRunToggle.checked;
    try {
      const res = await fetch('/api/dry-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
      const data = await res.json();
      dryRunToggle.checked = data.dryRun;
    } catch (err) {
      console.error('Error toggling dry run:', err);
    }
  });

  // Reset Button
  btnReset.addEventListener('click', async () => {
    if (confirm('Reset conversation history with the agent?')) {
      try {
        if (activeEventSource) {
          activeEventSource.close();
          activeEventSource = null;
        }
        if (currentRunId) {
          fetch('/api/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ runId: currentRunId })
          }).catch(() => {});
          currentRunId = null;
        }

        const res = await fetch('/api/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: 'default' })
        });
        const data = await res.json();
        if (data.ok) {
          setInputState(true);
          messagesContainer.innerHTML = `
            <div class="welcome-card">
              <h2>Conversation Reset</h2>
              <p>History cleared. Enter a new command or choose a template below to start restructuring.</p>
              <div class="suggestion-chips">
                <button class="chip" data-prompt="This server is a mess, set it up properly for a ~30 person gaming group.">🎮 30-Person Gaming Group</button>
                <button class="chip" data-prompt="Analyze the current server structure and propose improvements.">🔍 Analyze Current Structure</button>
                <button class="chip" data-prompt="Create an onboarding category with welcome, rules, and announcements channels.">📌 Create Onboarding Category</button>
              </div>
            </div>
          `;
          // Reattach chip listeners
          document.querySelectorAll('.chip').forEach((chip) => {
            chip.addEventListener('click', () => {
              const prompt = chip.getAttribute('data-prompt');
              if (prompt) sendMessage(prompt);
            });
          });
        }
      } catch (err) {
        console.error('Error resetting conversation:', err);
      }
    }
  });

  // Refresh Tree Button
  btnRefreshTree.addEventListener('click', () => {
    fetchSnapshot();
    fetchState();
  });

  // Roles Drawer Toggle
  let rolesOpen = true;
  rolesHeaderToggle.addEventListener('click', () => {
    rolesOpen = !rolesOpen;
    rolesListContainer.style.display = rolesOpen ? 'flex' : 'none';
    rolesToggleArrow.textContent = rolesOpen ? '▾' : '▸';
  });

  // Approval Modal Actions
  btnModalApprove.addEventListener('click', () => respondApproval(true));
  btnModalDeny.addEventListener('click', () => respondApproval(false));

  window.addEventListener('keydown', (e) => {
    if (approvalModal.style.display === 'flex') {
      if (e.key === 'Escape') {
        respondApproval(false);
      } else if (e.key === 'Enter') {
        respondApproval(true);
      }
    } else if (setupModal.style.display === 'flex') {
      if (e.key === 'Escape') {
        setupModal.style.display = 'none';
      }
    }
  });
}

// -------------------------------------------------------------
// Utilities
// -------------------------------------------------------------
function setInputState(enabled, statusText = '') {
  // Keep chat input enabled so user can steer the agent with messages anytime
  chatInput.disabled = false;
  btnSend.disabled = chatInput.value.trim() === '';

  if (enabled) {
    chatInput.placeholder = 'Describe your server goals (e.g. "restructure for 50 tech enthusiasts")...';
    btnCancelRun.style.display = 'none';
    btnSend.style.display = 'flex';
    chatInput.focus();
  } else {
    chatInput.placeholder = 'Type a message to steer the agent mid-run, or click Stop...';
    btnCancelRun.style.display = 'flex';
    btnSend.style.display = 'flex';
  }
  runStatusIndicator.textContent = statusText;
}

function autoResizeTextarea(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px';
}

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Lightweight Markdown Parser
 */
function renderMarkdown(md) {
  if (!md) return '';
  let html = escapeHtml(md);

  // Triple backtick Code blocks
  html = html.replace(/```([a-z]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code>${code}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Headers
  html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

  // Unordered list items
  html = html.replace(/^\s*[-*]\s+(.*$)/gim, '<li>$1</li>');

  // Ordered list items
  html = html.replace(/^\s*(\d+)\.\s+(.*$)/gim, '<li>$1</li>');

  // Wrap loose lines in paragraphs
  const paragraphs = html.split(/\n\n+/);
  html = paragraphs
    .map((p) => {
      p = p.trim();
      if (!p) return '';
      if (p.startsWith('<h1>') || p.startsWith('<h2>') || p.startsWith('<h3>') || p.startsWith('<pre>') || p.startsWith('<li>')) {
        return p;
      }
      return `<p>${p.replace(/\n/g, '<br>')}</p>`;
    })
    .join('');

  return html;
}

// Start app on DOMContentLoaded
document.addEventListener('DOMContentLoaded', init);
