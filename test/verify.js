import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('--- Running Discord Architect Unit Verification ---');

// 1. Test Permissions
import { namesToBitfield, bitfieldToNames, validatePermissions, WHITELISTED_PERMISSIONS } from '../src/discord/permissions.js';

console.log('1. Testing permissions mapping...');
const testBitfield = namesToBitfield(['ViewChannel', 'SendMessages', 'ManageRoles']);
const names = bitfieldToNames(testBitfield);
assert(names.includes('ViewChannel'), 'ViewChannel must be in names');
assert(names.includes('SendMessages'), 'SendMessages must be in names');
assert(names.includes('ManageRoles'), 'ManageRoles must be in names');
assert(!names.includes('Administrator'), 'Administrator should not be present');

// Test invalid perm error
assert.throws(() => {
  namesToBitfield(['NonExistentPerm']);
}, /Invalid permission/);
console.log('   ✓ Permissions logic verified.');

// 2. Test Tools Registry and Zod Schemas
import { toolsRegistry, getOpenAITools } from '../src/agent/tools.js';

console.log('2. Testing tools registry & validation schemas...');
assert.strictEqual(toolsRegistry.size, 62, `Expected 62 tools, found ${toolsRegistry.size}`);

const openAITools = getOpenAITools();
assert.strictEqual(openAITools.length, 62);
for (const t of openAITools) {
  assert(t.type === 'function');
  assert(t.function.name);
  assert(t.function.description);
  assert(t.function.parameters);
}

// Check destructive tools count
const destructiveTools = Array.from(toolsRegistry.values()).filter(t => t.destructive).map(t => t.name);
assert.strictEqual(destructiveTools.length, 14, `Expected 14 destructive tools, found ${destructiveTools.length}`);
assert(destructiveTools.includes('kick_member'));
assert(destructiveTools.includes('ban_member'));
assert(destructiveTools.includes('timeout_member'));
assert(destructiveTools.includes('delete_message'));
assert(destructiveTools.includes('purge_messages'));
assert(destructiveTools.includes('delete_emoji'));
assert(destructiveTools.includes('delete_sticker'));
assert(destructiveTools.includes('delete_soundboard_sound'));
assert(destructiveTools.includes('delete_automod_rule'));
assert(destructiveTools.includes('delete_webhook'));

// Test channel validation
const channelTool = toolsRegistry.get('create_channel');
const validRes = channelTool.schema.safeParse({
  name: 'general',
  type: 'text',
  parent_id: '123456789012345678'
});
assert.strictEqual(validRes.success, true);

// Invalid channel (empty name)
const invalidChannel = channelTool.schema.safeParse({
  name: '',
  type: 'text'
});
assert.strictEqual(invalidChannel.success, false);

// Test role creation with hex color and permissions
const roleTool = toolsRegistry.get('create_role');
const validRole = roleTool.schema.safeParse({
  name: 'Moderator',
  color: '#5865F2',
  hoist: true,
  permissions: ['ManageMessages', 'KickMembers']
});
assert.strictEqual(validRole.success, true);

const invalidRoleColor = roleTool.schema.safeParse({
  name: 'Moderator',
  color: 'invalid-color'
});
assert.strictEqual(invalidRoleColor.success, false);

// Test member moderation schemas
const assignRoleTool = toolsRegistry.get('assign_member_role');
assert.strictEqual(assignRoleTool.schema.safeParse({ member_id: '123', role_id: '456' }).success, true);

const timeoutTool = toolsRegistry.get('timeout_member');
assert.strictEqual(timeoutTool.schema.safeParse({ member_id: '123', duration_minutes: 60 }).success, true);

const kickTool = toolsRegistry.get('kick_member');
assert.strictEqual(kickTool.schema.safeParse({ member_id: '123', reason: 'Rule violation' }).success, true);

const banTool = toolsRegistry.get('ban_member');
assert.strictEqual(banTool.schema.safeParse({ user_id: '123', delete_message_seconds: 86400 }).success, true);

// Test message schemas
const getMsgTool = toolsRegistry.get('get_channel_messages');
assert.strictEqual(getMsgTool.schema.safeParse({ channel_id: '123', limit: 25 }).success, true);

const editMsgTool = toolsRegistry.get('edit_message');
assert.strictEqual(editMsgTool.schema.safeParse({ channel_id: '123', message_id: '456', content: 'Updated content' }).success, true);

const purgeMsgTool = toolsRegistry.get('purge_messages');
assert.strictEqual(purgeMsgTool.schema.safeParse({ channel_id: '123', count: 15 }).success, true);

// Test emoji, sticker, soundboard, automod, webhook schemas
const createEmojiTool = toolsRegistry.get('create_emoji');
assert.strictEqual(createEmojiTool.schema.safeParse({ name: 'cool_emoji', image: 'https://example.com/icon.png' }).success, true);

const createStickerTool = toolsRegistry.get('create_sticker');
assert.strictEqual(createStickerTool.schema.safeParse({ name: 'cool_sticker', file: 'https://example.com/sticker.png', tags: '👍' }).success, true);

const createSoundTool = toolsRegistry.get('create_soundboard_sound');
assert.strictEqual(createSoundTool.schema.safeParse({ name: 'cool_sound', sound: 'https://example.com/sound.mp3' }).success, true);

const createAutomodTool = toolsRegistry.get('create_automod_rule');
assert.strictEqual(createAutomodTool.schema.safeParse({
  name: 'Anti-phishing',
  trigger_type: 'keyword',
  keyword_filter: ['*scam*'],
  actions: [{ type: 'block_message' }]
}).success, true);

const createWebhookTool = toolsRegistry.get('create_webhook');
assert.strictEqual(createWebhookTool.schema.safeParse({ channel_id: '123', name: 'Alerts Webhook' }).success, true);

// Test batch_create_channels schema
const batchCreateChannelsTool = toolsRegistry.get('batch_create_channels');
const validBatchCh = batchCreateChannelsTool.schema.safeParse({
  channels: [
    { name: 'chat-1', type: 'text' },
    { name: 'voice-1', type: 'voice', slowmode_seconds: 5 }
  ]
});
assert.strictEqual(validBatchCh.success, true);

// Test batch_create_categories schema
const batchCreateCatsTool = toolsRegistry.get('batch_create_categories');
const validBatchCats = batchCreateCatsTool.schema.safeParse({
  categories: [
    { name: 'INFO', private: false },
    { name: 'STAFF', private: true, visible_to_role_ids: ['Admin'] }
  ]
});
assert.strictEqual(validBatchCats.success, true);

// Test batch_create_roles schema
const batchCreateRolesTool = toolsRegistry.get('batch_create_roles');
const validBatchRoles = batchCreateRolesTool.schema.safeParse({
  roles: [
    { name: 'Admin', color: '#E74C3C', permissions: ['Administrator'] },
    { name: 'Member', color: '#2ECC71' }
  ]
});
assert.strictEqual(validBatchRoles.success, true);

// Test batch_set_channel_permissions schema
const batchPermsTool = toolsRegistry.get('batch_set_channel_permissions');
const validBatchPerms = batchPermsTool.schema.safeParse({
  overwrites: [
    { channel_id: '123456789012345678', target_id: '987654321098765432', target_type: 'role', allow: ['ViewChannel'], deny: ['SendMessages'] }
  ]
});
assert.strictEqual(validBatchPerms.success, true);

// Test batch_send_messages schema
const batchMsgTool = toolsRegistry.get('batch_send_messages');
const validBatchMsg = batchMsgTool.schema.safeParse({
  messages: [
    { channel_id: '123456789012345678', content: 'Welcome to the server!', pin: true }
  ]
});
assert.strictEqual(validBatchMsg.success, true);

console.log('   ✓ Tools and Zod schemas verified.');

// 3. Test Dry-Run Operations
import {
  isDryRun,
  setDryRun,
  createCategoryOp,
  createChannelOp,
  createRoleOp,
  deleteChannelOp,
  editChannelOp,
  deleteRoleOp,
  setChannelPermissionsOp,
  sendMessageOp,
  editGuildOp,
  batchCreateStructureOp,
  batchCreateCategoriesOp,
  batchCreateChannelsOp,
  batchCreateRolesOp,
  batchEditChannelsOp,
  batchDeleteChannelsOp,
  batchMoveChannelsOp,
  batchEditRolesOp,
  batchDeleteRolesOp,
  batchSetChannelPermissionsOp,
  batchSendMessagesOp,
  listMembersOp,
  assignMemberRoleOp,
  removeMemberRoleOp,
  setMemberNicknameOp,
  timeoutMemberOp,
  kickMemberOp,
  banMemberOp,
  unbanMemberOp,
  listBansOp,
  getChannelMessagesOp,
  editMessageOp,
  deleteMessageOp,
  purgeMessagesOp,
  pinMessageOp,
  listEmojisOp,
  createEmojiOp,
  editEmojiOp,
  deleteEmojiOp,
  listStickersOp,
  createStickerOp,
  editStickerOp,
  deleteStickerOp,
  listSoundboardSoundsOp,
  createSoundboardSoundOp,
  editSoundboardSoundOp,
  deleteSoundboardSoundOp,
  listAutomodRulesOp,
  createAutomodRuleOp,
  editAutomodRuleOp,
  deleteAutomodRuleOp,
  listWebhooksOp,
  createWebhookOp,
  editWebhookOp,
  deleteWebhookOp,
  sendWebhookMessageOp,
  listIntegrationsOp
} from '../src/discord/ops.js';

console.log('3. Testing Dry-Run Operations...');
setDryRun(true);
assert.strictEqual(isDryRun(), true);

const catRes = await createCategoryOp({ name: 'GAMING', private: false });
assert.strictEqual(catRes.dryRun, true);
assert(typeof catRes.id === 'string' && catRes.id.length >= 17);

const chRes = await createChannelOp({ name: 'general', type: 'text', parent_id: catRes.id });
assert.strictEqual(chRes.dryRun, true);
assert(typeof chRes.id === 'string');

const roleRes = await createRoleOp({ name: 'Member', color: '#00FF00', permissions: ['ViewChannel', 'SendMessages'] });
assert.strictEqual(roleRes.dryRun, true);

const delChRes = await deleteChannelOp({ channel_id: chRes.id });
assert.strictEqual(delChRes.dryRun, true);
assert.strictEqual(delChRes.deleted, true);

// Test Member & Moderation operations
const membersRes = await listMembersOp({ query: 'Server' });
assert.strictEqual(membersRes.dryRun, true);
assert.strictEqual(membersRes.count, 3);

const assignRes = await assignMemberRoleOp({ member_id: '100000000000000003', role_id: roleRes.id });
assert.strictEqual(assignRes.dryRun, true);
assert.strictEqual(assignRes.assigned, true);

const removeRes = await removeMemberRoleOp({ member_id: '100000000000000003', role_id: roleRes.id });
assert.strictEqual(removeRes.dryRun, true);
assert.strictEqual(removeRes.removed, true);

const nickRes = await setMemberNicknameOp({ member_id: '100000000000000003', nickname: 'NewNick' });
assert.strictEqual(nickRes.dryRun, true);

const timeoutRes = await timeoutMemberOp({ member_id: '100000000000000003', duration_minutes: 30 });
assert.strictEqual(timeoutRes.dryRun, true);
assert.strictEqual(timeoutRes.timed_out, true);

const kickRes = await kickMemberOp({ member_id: '100000000000000003', reason: 'Test kick' });
assert.strictEqual(kickRes.dryRun, true);
assert.strictEqual(kickRes.kicked, true);

const banRes = await banMemberOp({ user_id: '999000000000000001', delete_message_seconds: 3600 });
assert.strictEqual(banRes.dryRun, true);
assert.strictEqual(banRes.banned, true);

const unbanRes = await unbanMemberOp({ user_id: '999000000000000001' });
assert.strictEqual(unbanRes.dryRun, true);
assert.strictEqual(unbanRes.unbanned, true);

const bansRes = await listBansOp();
assert.strictEqual(bansRes.dryRun, true);
assert.strictEqual(bansRes.count, 1);

// Test Message operations
const msgsRes = await getChannelMessagesOp({ channel_id: chRes.id, limit: 10 });
assert.strictEqual(msgsRes.dryRun, true);
assert.strictEqual(msgsRes.count, 2);

const editMsgRes = await editMessageOp({ channel_id: chRes.id, message_id: '100000000000000010', content: 'Edited message content' });
assert.strictEqual(editMsgRes.dryRun, true);
assert.strictEqual(editMsgRes.edited, true);

const pinMsgRes = await pinMessageOp({ channel_id: chRes.id, message_id: '100000000000000010', pinned: true });
assert.strictEqual(pinMsgRes.dryRun, true);
assert.strictEqual(pinMsgRes.pinned, true);

const deleteMsgRes = await deleteMessageOp({ channel_id: chRes.id, message_id: '100000000000000011' });
assert.strictEqual(deleteMsgRes.dryRun, true);
assert.strictEqual(deleteMsgRes.deleted, true);

const purgeMsgRes = await purgeMessagesOp({ channel_id: chRes.id, count: 5 });
assert.strictEqual(purgeMsgRes.dryRun, true);
assert.strictEqual(purgeMsgRes.purged_count, 5);

// Test Guild Assets & Settings
const editGuildRes = await editGuildOp({ name: 'Renamed Community', description: 'Awesome server', icon: 'https://example.com/icon.png' });
assert.strictEqual(editGuildRes.dryRun, true);
assert.strictEqual(editGuildRes.name, 'Renamed Community');

// Test Emojis
const listEmojisRes = await listEmojisOp();
assert.strictEqual(listEmojisRes.dryRun, true);
assert.strictEqual(listEmojisRes.count, 1);

const createEmojiRes = await createEmojiOp({ name: 'fire', image: 'https://example.com/fire.png' });
assert.strictEqual(createEmojiRes.dryRun, true);

const editEmojiRes = await editEmojiOp({ emoji_id: createEmojiRes.id, name: 'super_fire' });
assert.strictEqual(editEmojiRes.dryRun, true);

const deleteEmojiRes = await deleteEmojiOp({ emoji_id: createEmojiRes.id });
assert.strictEqual(deleteEmojiRes.dryRun, true);

// Test Stickers
const listStickersRes = await listStickersOp();
assert.strictEqual(listStickersRes.dryRun, true);

const createStickerRes = await createStickerOp({ name: 'hype', file: 'https://example.com/hype.png', tags: '🎉' });
assert.strictEqual(createStickerRes.dryRun, true);

const editStickerRes = await editStickerOp({ sticker_id: createStickerRes.id, name: 'super_hype' });
assert.strictEqual(editStickerRes.dryRun, true);

const deleteStickerRes = await deleteStickerOp({ sticker_id: createStickerRes.id });
assert.strictEqual(deleteStickerRes.dryRun, true);

// Test Soundboard
const listSoundsRes = await listSoundboardSoundsOp();
assert.strictEqual(listSoundsRes.dryRun, true);

const createSoundRes = await createSoundboardSoundOp({ name: 'cheer', sound: 'https://example.com/cheer.mp3', volume: 0.9 });
assert.strictEqual(createSoundRes.dryRun, true);

const editSoundRes = await editSoundboardSoundOp({ sound_id: createSoundRes.id, name: 'loud_cheer', volume: 1.0 });
assert.strictEqual(editSoundRes.dryRun, true);

const deleteSoundRes = await deleteSoundboardSoundOp({ sound_id: createSoundRes.id });
assert.strictEqual(deleteSoundRes.dryRun, true);

// Test AutoMod
const listAutomodRes = await listAutomodRulesOp();
assert.strictEqual(listAutomodRes.dryRun, true);

const createAutomodRes = await createAutomodRuleOp({ name: 'Block Invites', trigger_type: 'keyword', keyword_filter: ['discord.gg/*'] });
assert.strictEqual(createAutomodRes.dryRun, true);

const editAutomodRes = await editAutomodRuleOp({ rule_id: createAutomodRes.id, enabled: false });
assert.strictEqual(editAutomodRes.dryRun, true);

const deleteAutomodRes = await deleteAutomodRuleOp({ rule_id: createAutomodRes.id });
assert.strictEqual(deleteAutomodRes.dryRun, true);

// Test Webhooks & Integrations
const listWebhooksRes = await listWebhooksOp();
assert.strictEqual(listWebhooksRes.dryRun, true);

const createWebhookRes = await createWebhookOp({ channel_id: chRes.id, name: 'GitHub Integration' });
assert.strictEqual(createWebhookRes.dryRun, true);

const editWebhookRes = await editWebhookOp({ webhook_id: createWebhookRes.id, name: 'GitHub CI' });
assert.strictEqual(editWebhookRes.dryRun, true);

const sendWebhookMsgRes = await sendWebhookMessageOp({ webhook_id: createWebhookRes.id, content: 'Deployment successful!' });
assert.strictEqual(sendWebhookMsgRes.dryRun, true);

const deleteWebhookRes = await deleteWebhookOp({ webhook_id: createWebhookRes.id });
assert.strictEqual(deleteWebhookRes.dryRun, true);

const listIntegrationsRes = await listIntegrationsOp();
assert.strictEqual(listIntegrationsRes.dryRun, true);
assert.strictEqual(listIntegrationsRes.count, 1);

// Test Batch Create Categories
const batchCatsRes = await batchCreateCategoriesOp({
  categories: [
    { name: 'COMMUNITY', private: false },
    { name: 'ADMINISTRATION', private: true }
  ]
});
assert.strictEqual(batchCatsRes.dryRun, true);
assert.strictEqual(batchCatsRes.count, 2);

// Test Batch Create Channels
const batchChsRes = await batchCreateChannelsOp({
  channels: [
    { name: 'general-chat', type: 'text', parent_id: batchCatsRes.categories[0].id },
    { name: 'gaming-voice', type: 'voice', parent_id: batchCatsRes.categories[0].id }
  ]
});
assert.strictEqual(batchChsRes.dryRun, true);
assert.strictEqual(batchChsRes.count, 2);

// Test Batch Create Roles
const batchRolesRes = await batchCreateRolesOp({
  roles: [
    { name: 'Moderator', color: '#3498DB', permissions: ['KickMembers', 'BanMembers'] },
    { name: 'VIP', color: '#F1C40F' }
  ]
});
assert.strictEqual(batchRolesRes.dryRun, true);
assert.strictEqual(batchRolesRes.count, 2);

// Test Batch Set Channel Permissions
const batchPermsRes = await batchSetChannelPermissionsOp({
  overwrites: [
    { channel_id: batchChsRes.channels[0].id, target_id: batchRolesRes.roles[0].id, target_type: 'role', allow: ['ManageMessages'] }
  ]
});
assert.strictEqual(batchPermsRes.dryRun, true);
assert.strictEqual(batchPermsRes.count, 1);

// Test Batch Send Messages
const batchMsgsRes = await batchSendMessagesOp({
  messages: [
    { channel_id: batchChsRes.channels[0].id, content: '# Welcome!', pin: true }
  ]
});
assert.strictEqual(batchMsgsRes.dryRun, true);
assert.strictEqual(batchMsgsRes.count, 1);

// Test Batch Edit Channels
const batchEditRes = await batchEditChannelsOp({
  channels: [
    { channel_id: '123456789012345678', name: 'chat-1' },
    { channel_id: '123456789012345679', name: 'chat-2' }
  ]
});
assert.strictEqual(batchEditRes.dryRun, true);
assert.strictEqual(batchEditRes.count, 2);

// Test Batch Full Server Creation
const batchRes = await batchCreateStructureOp({
  roles: [{ name: 'Modérateur', color: '#3498DB' }, { name: 'Gamer', color: '#9B59B6' }],
  categories: [
    {
      name: 'MAIN',
      channels: [{ name: 'annonces', type: 'text' }, { name: 'general', type: 'text' }]
    },
    {
      name: 'VOICE',
      channels: [{ name: 'General Voice', type: 'voice' }]
    }
  ]
});
assert.strictEqual(batchRes.dryRun, true);
assert.strictEqual(batchRes.count.roles, 2);
assert.strictEqual(batchRes.count.categories, 2);
assert.strictEqual(batchRes.count.channels, 3);

console.log('   ✓ Dry-run operations executed successfully.');

// 4. Test Audit Logging
console.log('4. Testing Audit Logger...');
const today = new Date();
const y = today.getFullYear();
const m = String(today.getMonth() + 1).padStart(2, '0');
const d = String(today.getDate()).padStart(2, '0');
const logFile = path.resolve(__dirname, `../logs/audit-${y}-${m}-${d}.jsonl`);

assert(fs.existsSync(logFile), `Audit log file ${logFile} should exist`);
const logLines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
assert(logLines.length >= 4, `Expected at least 4 log entries, found ${logLines.length}`);

const lastLog = JSON.parse(logLines[logLines.length - 1]);
assert.strictEqual(lastLog.tool, 'batch_create_structure');
assert.strictEqual(lastLog.dryRun, true);
console.log('   ✓ Audit logging verified.');

// 5. Test System Prompt Construction
import { buildSystemPrompt } from '../src/agent/systemPrompt.js';

console.log('5. Testing System Prompt builder...');
const sampleSnapshot = {
  guild: { id: '999999999999999999', name: 'Test Server', memberCount: 15, community: false },
  roles: [{ id: '999999999999999999', name: '@everyone', position: 0, color: '#000000', hoist: false, keyPerms: [] }],
  botHighestRolePosition: 5,
  categories: [],
  uncategorized: []
};

const prompt = await buildSystemPrompt(sampleSnapshot);
assert(prompt.includes('You are Discord Architect'));
assert(prompt.includes('DRY RUN MODE: ON'));
assert(prompt.includes('999999999999999999'));
assert(prompt.includes('Test Server'));
console.log('   ✓ System prompt builder verified.');

// 6. Test SSE Manager
import { sseManager } from '../src/util/sse.js';

console.log('6. Testing SSE Manager...');
const run = sseManager.createRun('test-run-123');
assert(run);
sseManager.emit('test-run-123', 'test_event', { hello: 'world' });
assert.strictEqual(run.buffer.length, 1);
assert(run.buffer[0].includes('event: test_event'));
assert(run.buffer[0].includes('{"hello":"world"}'));
sseManager.cleanup('test-run-123');
console.log('   ✓ SSE manager verified.');

// 7. Test AI Provider Configuration
import { getAIConfig, setAIConfig, getOpenAIClient } from '../src/agent/config.js';

console.log('7. Testing AI Provider & Proxy Config...');
setAIConfig({
  baseURL: 'https://openrouter.ai/api/v1',
  model: 'anthropic/claude-3.7-sonnet',
  apiKey: 'sk-test-key-123'
});

const config = getAIConfig();
assert.strictEqual(config.baseURL, 'https://openrouter.ai/api/v1');
assert.strictEqual(config.model, 'anthropic/claude-3.7-sonnet');
assert.strictEqual(config.hasApiKey, true);

const client = getOpenAIClient();
assert.strictEqual(client.baseURL, 'https://openrouter.ai/api/v1');
assert.strictEqual(client.apiKey, 'sk-test-key-123');

// Test Keyless / Local Provider & Reasoning Tiers (e.g. Ollama, DeepSeek-R1, o3-mini)
setAIConfig({
  baseURL: 'http://localhost:11434/v1',
  model: 'deepseek-r1:7b',
  apiKey: '',
  reasoningEffort: 'high'
});
const localClient = getOpenAIClient();
assert.strictEqual(localClient.baseURL, 'http://localhost:11434/v1');
assert.strictEqual(localClient.apiKey, 'not-needed');
assert.strictEqual(getAIConfig().reasoningEffort, 'high');

console.log('   ✓ AI provider configuration & reasoning tiers verified.');

// 8. Test Cancellation & Mid-flight Steering
import { cancelRun, isSessionRunning, sendUserSteeringMessage, getConversation, resetConversation } from '../src/agent/loop.js';
console.log('8. Testing Run Cancellation & Steering...');
const cancelResult = cancelRun('non-existent-run');
assert.strictEqual(cancelResult, false);

assert.strictEqual(isSessionRunning('test-session'), false);
resetConversation('test-session');
const steerRes = sendUserSteeringMessage('test-session', 'steer instruction');
assert.strictEqual(steerRes.steered, false);
const history = getConversation('test-session');
assert.strictEqual(history.length, 1);
assert.strictEqual(history[0].content, 'steer instruction');

console.log('   ✓ Run cancellation & mid-flight steering verified.');

console.log('\n========================================');
console.log('✅ ALL DISCORD ARCHITECT CHECKS PASSED!');
console.log('========================================\n');
process.exit(0);
