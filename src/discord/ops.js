import {
  ChannelType,
  OverwriteType,
  PermissionsBitField,
  AutoModerationRuleEventType,
  AutoModerationRuleTriggerType,
  AutoModerationActionType
} from 'discord.js';
import { getGuild, getDiscordClient } from './client.js';
import { opQueue } from './queue.js';
import { namesToBitfield } from './permissions.js';
import { stringToChannelType, channelTypeToString } from './snapshot.js';
import { auditLog } from '../util/log.js';

let dryRunMode = true; // Default ON at boot
let fakeSnowflakeCounter = 100000000000000001n;

export function isDryRun() {
  return dryRunMode;
}

export function setDryRun(enabled) {
  dryRunMode = Boolean(enabled);
  console.log(`[Config] Dry run mode set to: ${dryRunMode ? 'ON' : 'OFF (ARMED)'}`);
  return dryRunMode;
}

function nextFakeSnowflake() {
  const sf = String(fakeSnowflakeCounter);
  fakeSnowflakeCounter += 1n;
  return sf;
}

/**
 * Check if the guild can accept a new channel (limit 500)
 */
async function checkGuildChannelLimit(guild) {
  const channels = await guild.channels.fetch();
  const count = channels.filter(
    (c) => c && c.type !== ChannelType.PublicThread && c.type !== ChannelType.PrivateThread && c.type !== ChannelType.AnnouncementThread
  ).size;
  if (count >= 500) {
    throw new Error(`Guild channel limit reached (500 channels maximum). Current count: ${count}`);
  }
}

/**
 * Check if a category can accept a new channel (limit 50)
 */
async function checkCategoryChannelLimit(guild, parentId) {
  if (!parentId) return;
  const channels = await guild.channels.fetch();
  const catChannels = channels.filter((c) => c && c.parentId === parentId);
  if (catChannels.size >= 50) {
    throw new Error(`Category ${parentId} has reached the maximum limit of 50 channels.`);
  }
}

/**
 * Check if the guild can accept a new role (limit 250)
 */
async function checkGuildRoleLimit(guild) {
  const roles = await guild.roles.fetch();
  if (roles.size >= 250) {
    throw new Error(`Guild role limit reached (250 roles maximum). Current count: ${roles.size}`);
  }
}

/**
 * Validate that bot's role can manage the target role.
 */
async function checkRoleHierarchy(guild, targetRoleId) {
  const client = getDiscordClient();
  const botMember = await guild.members.fetch(client.user.id);
  const targetRole = await guild.roles.fetch(targetRoleId);

  if (!targetRole) {
    throw new Error(`Role with ID ${targetRoleId} not found.`);
  }

  if (targetRole.id === guild.id) {
    // @everyone role
    return targetRole;
  }

  if (botMember.roles.highest.position <= targetRole.position) {
    throw new Error(
      `Cannot manage role "${targetRole.name}" (position ${targetRole.position}) because it is higher than or equal to the bot's highest role "${botMember.roles.highest.name}" (position ${botMember.roles.highest.position}). Discord security strictly prohibits modifying roles at or above the bot's highest role, even with Administrator permission.`
    );
  }

  return targetRole;
}

/**
 * Smart resolver for role ID or role name to Discord snowflake.
 */
async function resolveRoleId(guild, roleIdentifier) {
  if (!roleIdentifier) return null;
  const cleaned = String(roleIdentifier).trim();

  if (cleaned === '@everyone' || cleaned === guild.id) {
    return guild.id;
  }

  if (/^\d{17,20}$/.test(cleaned)) {
    return cleaned;
  }

  const roles = await guild.roles.fetch();
  const matched = roles.find(
    (r) => r.name.toLowerCase() === cleaned.toLowerCase() || r.name.toLowerCase() === cleaned.replace(/^@/, '').toLowerCase()
  );

  if (matched) {
    return String(matched.id);
  }

  return cleaned;
}

/**
 * Smart resolver for category ID or category name to Discord snowflake.
 */
async function resolveCategoryId(guild, categoryIdentifier) {
  if (!categoryIdentifier) return null;
  const cleaned = String(categoryIdentifier).trim();

  if (/^\d{17,20}$/.test(cleaned)) {
    return cleaned;
  }

  const channels = await guild.channels.fetch();
  const matched = channels.find(
    (c) => c && c.type === ChannelType.GuildCategory && c.name.toLowerCase() === cleaned.toLowerCase()
  );

  if (matched) {
    return String(matched.id);
  }

  return cleaned;
}

/**
 * Smart resolver for channel ID or channel name to Discord snowflake.
 */
async function resolveChannelId(guild, channelIdentifier) {
  if (!channelIdentifier) return null;
  const cleaned = String(channelIdentifier).trim();

  if (/^\d{17,20}$/.test(cleaned)) {
    return cleaned;
  }

  const normalized = cleaned.replace(/^#/, '').toLowerCase();
  const channels = await guild.channels.fetch();
  const matched = channels.find(
    (c) => c && (c.name.toLowerCase() === normalized || c.name.toLowerCase() === cleaned.toLowerCase())
  );

  if (matched) {
    return String(matched.id);
  }

  return cleaned;
}

/**
 * Smart resolver for member ID, username, or nickname to Discord snowflake.
 */
async function resolveMemberId(guild, memberIdentifier) {
  if (!memberIdentifier) return null;
  const cleaned = String(memberIdentifier).trim();

  if (/^\d{17,20}$/.test(cleaned)) {
    return cleaned;
  }

  const searchName = cleaned.replace(/^@/, '').toLowerCase();
  const members = await guild.members.fetch({ query: searchName, limit: 10 }).catch(() => null);
  if (members && members.size > 0) {
    const exact = members.find(
      (m) =>
        m.user.username.toLowerCase() === searchName ||
        (m.nickname && m.nickname.toLowerCase() === searchName) ||
        (m.user.globalName && m.user.globalName.toLowerCase() === searchName)
    );
    if (exact) return String(exact.id);
    return String(members.first().id);
  }

  return cleaned;
}

/**
 * Validate that bot can perform moderation actions on target member.
 */
async function checkMemberHierarchy(guild, targetMember) {
  if (!targetMember) return;
  const client = getDiscordClient();
  const botMember = await guild.members.fetch(client.user.id);

  if (targetMember.id === guild.ownerId) {
    throw new Error(
      `Cannot moderate or modify server owner (${targetMember.user?.tag || targetMember.id}). Server owners are immune to bot moderation actions.`
    );
  }

  if (targetMember.id === client.user.id) {
    throw new Error(`Cannot execute moderation actions on the bot itself.`);
  }

  if (botMember.roles.highest.position <= targetMember.roles.highest.position) {
    throw new Error(
      `Cannot moderate member "${targetMember.user?.tag || targetMember.id}" because their highest role "${targetMember.roles.highest.name}" (position ${targetMember.roles.highest.position}) is higher than or equal to the bot's highest role "${botMember.roles.highest.name}" (position ${botMember.roles.highest.position}).`
    );
  }
}

/**
 * Smart resolver for emoji ID or emoji name.
 */
async function resolveEmojiId(guild, emojiIdentifier) {
  if (!emojiIdentifier) return null;
  const cleaned = String(emojiIdentifier).trim();
  if (/^\d{17,20}$/.test(cleaned)) {
    return cleaned;
  }
  const emojis = await guild.emojis.fetch().catch(() => new Map());
  const searchName = cleaned.replace(/^:/, '').replace(/:$/, '').toLowerCase();
  const matched = emojis.find((e) => e.name.toLowerCase() === searchName);
  if (matched) return String(matched.id);
  return cleaned;
}

/**
 * Smart resolver for sticker ID or sticker name.
 */
async function resolveStickerId(guild, stickerIdentifier) {
  if (!stickerIdentifier) return null;
  const cleaned = String(stickerIdentifier).trim();
  if (/^\d{17,20}$/.test(cleaned)) {
    return cleaned;
  }
  const stickers = await guild.stickers.fetch().catch(() => new Map());
  const matched = stickers.find((s) => s.name.toLowerCase() === cleaned.toLowerCase());
  if (matched) return String(matched.id);
  return cleaned;
}

/**
 * Smart resolver for soundboard sound ID or name.
 */
async function resolveSoundboardSoundId(guild, soundIdentifier) {
  if (!soundIdentifier) return null;
  const cleaned = String(soundIdentifier).trim();
  if (/^\d{17,20}$/.test(cleaned)) {
    return cleaned;
  }
  const sounds = await guild.soundboardSounds?.fetch().catch(() => new Map());
  if (sounds) {
    const matched = sounds.find((s) => s.name.toLowerCase() === cleaned.toLowerCase());
    if (matched) return String(matched.id);
  }
  return cleaned;
}

/**
 * Smart resolver for auto-moderation rule ID or name.
 */
async function resolveAutomodRuleId(guild, ruleIdentifier) {
  if (!ruleIdentifier) return null;
  const cleaned = String(ruleIdentifier).trim();
  if (/^\d{17,20}$/.test(cleaned)) {
    return cleaned;
  }
  const rules = await guild.autoModerationRules?.fetch().catch(() => new Map());
  if (rules) {
    const matched = rules.find((r) => r.name.toLowerCase() === cleaned.toLowerCase());
    if (matched) return String(matched.id);
  }
  return cleaned;
}

/**
 * Smart resolver for webhook ID or name.
 */
async function resolveWebhookId(guild, webhookIdentifier) {
  if (!webhookIdentifier) return null;
  const cleaned = String(webhookIdentifier).trim();
  if (/^\d{17,20}$/.test(cleaned)) {
    return cleaned;
  }
  const webhooks = await guild.fetchWebhooks().catch(() => new Map());
  const matched = webhooks.find((w) => w.name.toLowerCase() === cleaned.toLowerCase());
  if (matched) return String(matched.id);
  return cleaned;
}

// -------------------------------------------------------------
// Discord Operation Implementations
// -------------------------------------------------------------

export async function createCategoryOp(args) {
  const { name, position, private: isPrivate, visible_to_role_ids = [] } = args;

  if (dryRunMode) {
    const fakeId = nextFakeSnowflake();
    const result = {
      dryRun: true,
      id: fakeId,
      name,
      position: position ?? 0,
      private: Boolean(isPrivate),
      visible_to_role_ids
    };
    auditLog({ tool: 'create_category', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      await checkGuildChannelLimit(guild);

      const permissionOverwrites = [];
      if (isPrivate) {
        // Deny ViewChannel for @everyone
        permissionOverwrites.push({
          id: guild.id,
          deny: [PermissionsBitField.Flags.ViewChannel]
        });

        // Allow ViewChannel for specified roles (resolve IDs if names provided)
        for (const roleIdent of visible_to_role_ids) {
          const resolvedId = await resolveRoleId(guild, roleIdent);
          permissionOverwrites.push({
            id: resolvedId,
            allow: [PermissionsBitField.Flags.ViewChannel]
          });
        }
      }

      const category = await guild.channels.create({
        name,
        type: ChannelType.GuildCategory,
        position: position !== undefined ? position : undefined,
        permissionOverwrites: permissionOverwrites.length > 0 ? permissionOverwrites : undefined
      });

      return {
        id: String(category.id),
        name: category.name,
        position: category.position,
        private: Boolean(isPrivate)
      };
    }, `Create category "${name}"`);

    auditLog({ tool: 'create_category', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'create_category', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function createChannelOp(args) {
  const { name, type, parent_id, topic, slowmode_seconds, nsfw, position } = args;

  if (dryRunMode) {
    const fakeId = nextFakeSnowflake();
    const result = {
      dryRun: true,
      id: fakeId,
      name,
      type,
      parent_id: parent_id || null,
      topic: topic || null,
      slowmode_seconds: slowmode_seconds || 0,
      nsfw: Boolean(nsfw),
      position: position ?? 0
    };
    auditLog({ tool: 'create_channel', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      await checkGuildChannelLimit(guild);

      const resolvedParentId = parent_id ? await resolveCategoryId(guild, parent_id) : undefined;

      if (resolvedParentId) {
        await checkCategoryChannelLimit(guild, resolvedParentId);
      }

      const isCommunity = guild.features.includes('COMMUNITY');
      if (['announcement', 'forum', 'stage'].includes(type) && !isCommunity) {
        throw new Error(`Channel type "${type}" requires the Community feature to be enabled on this server. Please use "text" instead.`);
      }

      const discordChannelType = stringToChannelType(type);

      const channelData = {
        name,
        type: discordChannelType,
        parent: resolvedParentId,
        topic: topic || undefined,
        rateLimitPerUser: slowmode_seconds !== undefined ? slowmode_seconds : undefined,
        nsfw: nsfw !== undefined ? nsfw : undefined,
        position: position !== undefined ? position : undefined
      };

      const channel = await guild.channels.create(channelData);
      return {
        id: String(channel.id),
        name: channel.name,
        type: channelTypeToString(channel.type),
        parent_id: channel.parentId ? String(channel.parentId) : null,
        position: channel.position
      };
    }, `Create channel "${name}" (${type})`);

    auditLog({ tool: 'create_channel', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'create_channel', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function editChannelOp(args) {
  const { channel_id, name, topic, slowmode_seconds, nsfw } = args;

  if (dryRunMode) {
    const result = {
      dryRun: true,
      id: channel_id,
      name,
      topic,
      slowmode_seconds,
      nsfw
    };
    auditLog({ tool: 'edit_channel', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedChannelId = await resolveChannelId(guild, channel_id);
      const channel = await guild.channels.fetch(resolvedChannelId).catch(() => null);
      if (!channel) {
        throw new Error(`Channel with ID or name "${channel_id}" was not found.`);
      }

      const editData = {};
      if (name !== undefined) editData.name = name;
      if (topic !== undefined) editData.topic = topic;
      if (slowmode_seconds !== undefined) editData.rateLimitPerUser = slowmode_seconds;
      if (nsfw !== undefined) editData.nsfw = nsfw;

      const updated = await channel.edit(editData);
      return {
        id: String(updated.id),
        name: updated.name,
        topic: updated.topic,
        slowmode_seconds: updated.rateLimitPerUser,
        nsfw: updated.nsfw
      };
    }, `Edit channel ${channel_id}`);

    auditLog({ tool: 'edit_channel', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'edit_channel', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function deleteChannelOp(args) {
  const { channel_id } = args;

  if (dryRunMode) {
    const result = { dryRun: true, id: channel_id, deleted: true };
    auditLog({ tool: 'delete_channel', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedChannelId = await resolveChannelId(guild, channel_id);
      const channel = await guild.channels.fetch(resolvedChannelId).catch(() => null);
      if (!channel) {
        throw new Error(`Channel with ID or name "${channel_id}" was not found.`);
      }

      const channelName = channel.name;
      await channel.delete();
      return { id: resolvedChannelId, name: channelName, deleted: true };
    }, `Delete channel ${channel_id}`);

    auditLog({ tool: 'delete_channel', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'delete_channel', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function moveChannelOp(args) {
  const { channel_id, parent_id, position } = args;

  if (dryRunMode) {
    const result = {
      dryRun: true,
      id: channel_id,
      parent_id: parent_id || null,
      position
    };
    auditLog({ tool: 'move_channel', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedChannelId = await resolveChannelId(guild, channel_id);
      const channel = await guild.channels.fetch(resolvedChannelId).catch(() => null);
      if (!channel) {
        throw new Error(`Channel with ID or name "${channel_id}" was not found.`);
      }

      const resolvedParentId = parent_id ? await resolveCategoryId(guild, parent_id) : null;

      if (resolvedParentId) {
        await checkCategoryChannelLimit(guild, resolvedParentId);
      }

      const updated = await channel.edit({
        parent: resolvedParentId,
        position: position !== undefined ? position : undefined
      });

      return {
        id: String(updated.id),
        parent_id: updated.parentId ? String(updated.parentId) : null,
        position: updated.position
      };
    }, `Move channel ${channel_id}`);

    auditLog({ tool: 'move_channel', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'move_channel', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function reorderChannelsOp(args) {
  const { parent_id, ordered_channel_ids } = args;

  if (dryRunMode) {
    const result = {
      dryRun: true,
      parent_id: parent_id || null,
      ordered_channel_ids
    };
    auditLog({ tool: 'reorder_channels', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedParentId = parent_id ? await resolveCategoryId(guild, parent_id) : null;

      const positions = ordered_channel_ids.map((id, index) => ({
        channel: id,
        position: index,
        parent: resolvedParentId
      }));

      await guild.channels.setPositions(positions);
      return {
        parent_id: resolvedParentId,
        ordered_channel_ids,
        reorderedCount: ordered_channel_ids.length
      };
    }, `Reorder channels in parent ${parent_id || 'root'}`);

    auditLog({ tool: 'reorder_channels', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'reorder_channels', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function createRoleOp(args) {
  const { name, color, hoist, mentionable, permissions } = args;

  if (dryRunMode) {
    const fakeId = nextFakeSnowflake();
    const result = {
      dryRun: true,
      id: fakeId,
      name,
      color: color || '#000000',
      hoist: Boolean(hoist),
      mentionable: Boolean(mentionable),
      permissions: permissions || []
    };
    auditLog({ tool: 'create_role', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      await checkGuildRoleLimit(guild);

      const bitfield = permissions && permissions.length > 0 ? namesToBitfield(permissions) : undefined;

      const role = await guild.roles.create({
        name,
        color: color || undefined,
        hoist: hoist !== undefined ? hoist : undefined,
        mentionable: mentionable !== undefined ? mentionable : undefined,
        permissions: bitfield
      });

      return {
        id: String(role.id),
        name: role.name,
        position: role.position,
        color: role.hexColor,
        hoist: role.hoist,
        mentionable: role.mentionable
      };
    }, `Create role "${name}"`);

    auditLog({ tool: 'create_role', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'create_role', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function editRoleOp(args) {
  const { role_id, name, color, hoist, mentionable, permissions } = args;

  if (dryRunMode) {
    const result = {
      dryRun: true,
      id: role_id,
      name,
      color,
      hoist,
      mentionable,
      permissions
    };
    auditLog({ tool: 'edit_role', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedRoleId = await resolveRoleId(guild, role_id);
      const role = await checkRoleHierarchy(guild, resolvedRoleId);

      const editData = {};
      if (name !== undefined && role.id !== guild.id) editData.name = name; // Can't rename @everyone
      if (color !== undefined) editData.color = color;
      if (hoist !== undefined && role.id !== guild.id) editData.hoist = hoist;
      if (mentionable !== undefined && role.id !== guild.id) editData.mentionable = mentionable;
      if (permissions !== undefined) editData.permissions = namesToBitfield(permissions);

      const updated = await role.edit(editData);
      return {
        id: String(updated.id),
        name: updated.name,
        color: updated.hexColor,
        hoist: updated.hoist,
        mentionable: updated.mentionable,
        position: updated.position
      };
    }, `Edit role ${role_id}`);

    auditLog({ tool: 'edit_role', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'edit_role', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function deleteRoleOp(args) {
  const { role_id } = args;

  if (dryRunMode) {
    const result = { dryRun: true, id: role_id, deleted: true };
    auditLog({ tool: 'delete_role', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedRoleId = await resolveRoleId(guild, role_id);
      if (resolvedRoleId === guild.id) {
        throw new Error(`Cannot delete the @everyone role.`);
      }

      const role = await checkRoleHierarchy(guild, resolvedRoleId);
      const roleName = role.name;
      await role.delete();

      return { id: resolvedRoleId, name: roleName, deleted: true };
    }, `Delete role ${role_id}`);

    auditLog({ tool: 'delete_role', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'delete_role', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function setChannelPermissionsOp(args) {
  const { channel_id, target_id, target_type, allow = [], deny = [] } = args;

  if (dryRunMode) {
    const result = {
      dryRun: true,
      channel_id,
      target_id,
      target_type,
      allow,
      deny
    };
    auditLog({ tool: 'set_channel_permissions', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedChannelId = await resolveChannelId(guild, channel_id);
      const channel = await guild.channels.fetch(resolvedChannelId).catch(() => null);
      if (!channel) {
        throw new Error(`Channel with ID or name "${channel_id}" was not found.`);
      }

      const resolvedTargetId = target_type === 'role' ? await resolveRoleId(guild, target_id) : target_id;
      const overwriteType = target_type === 'role' ? OverwriteType.Role : OverwriteType.Member;

      await channel.permissionOverwrites.edit(resolvedTargetId, {
        ...Object.fromEntries(allow.map((perm) => [perm, true])),
        ...Object.fromEntries(deny.map((perm) => [perm, false]))
      }, {
        type: overwriteType
      });

      return {
        channel_id: resolvedChannelId,
        target_id: resolvedTargetId,
        target_type,
        allow,
        deny
      };
    }, `Set permissions on channel ${channel_id} for ${target_id}`);

    auditLog({ tool: 'set_channel_permissions', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'set_channel_permissions', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function sendMessageOp(args) {
  const { channel_id, content, pin } = args;

  if (dryRunMode) {
    const result = {
      dryRun: true,
      channel_id,
      contentPreview: content.slice(0, 100),
      pinned: Boolean(pin)
    };
    auditLog({ tool: 'send_message', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedChannelId = await resolveChannelId(guild, channel_id);
      const channel = await guild.channels.fetch(resolvedChannelId).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        throw new Error(`Channel "${channel_id}" was not found or is not a text-based channel.`);
      }

      const message = await channel.send(content);
      if (pin) {
        await message.pin().catch((err) => {
          console.warn(`Could not pin message in channel ${channel_id}: ${err.message}`);
        });
      }

      return {
        messageId: String(message.id),
        channel_id: String(channel.id),
        pinned: Boolean(pin)
      };
    }, `Send message to channel ${channel_id}`);

    auditLog({ tool: 'send_message', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'send_message', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function editGuildOp(args) {
  const {
    name,
    icon,
    banner,
    splash,
    description,
    vanity_code,
    system_channel_id,
    rules_channel_id,
    afk_channel_id,
    afk_timeout,
    verification_level,
    explicit_content_filter,
    default_message_notifications
  } = args;

  if (dryRunMode) {
    const result = {
      dryRun: true,
      name,
      icon: icon ? '[Icon Updated]' : icon,
      banner: banner ? '[Banner Updated]' : banner,
      splash: splash ? '[Splash Updated]' : splash,
      description,
      vanity_code,
      system_channel_id,
      rules_channel_id,
      afk_channel_id,
      afk_timeout,
      verification_level,
      explicit_content_filter,
      default_message_notifications
    };
    auditLog({ tool: 'edit_guild', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const editData = {};
      if (name !== undefined) editData.name = name;
      if (icon !== undefined) editData.icon = icon;
      if (banner !== undefined) editData.banner = banner;
      if (splash !== undefined) editData.splash = splash;
      if (description !== undefined) editData.description = description;
      if (vanity_code !== undefined) editData.vanityURLCode = vanity_code;
      if (system_channel_id !== undefined) editData.systemChannel = system_channel_id ? await resolveChannelId(guild, system_channel_id) : null;
      if (rules_channel_id !== undefined) editData.rulesChannel = rules_channel_id ? await resolveChannelId(guild, rules_channel_id) : null;
      if (afk_channel_id !== undefined) editData.afkChannel = afk_channel_id ? await resolveChannelId(guild, afk_channel_id) : null;
      if (afk_timeout !== undefined) editData.afkTimeout = afk_timeout;
      if (verification_level !== undefined) editData.verificationLevel = verification_level;
      if (explicit_content_filter !== undefined) editData.explicitContentFilter = explicit_content_filter;
      if (default_message_notifications !== undefined) editData.defaultMessageNotifications = default_message_notifications;

      const updated = await guild.edit(editData);
      return {
        id: String(updated.id),
        name: updated.name,
        description: updated.description || null,
        iconURL: updated.iconURL?.() || null,
        bannerURL: updated.bannerURL?.() || null,
        splashURL: updated.splashURL?.() || null,
        vanityURLCode: updated.vanityURLCode || null,
        system_channel_id: updated.systemChannelId ? String(updated.systemChannelId) : null,
        rules_channel_id: updated.rulesChannelId ? String(updated.rulesChannelId) : null,
        afk_channel_id: updated.afkChannelId ? String(updated.afkChannelId) : null,
        afk_timeout: updated.afkTimeout
      };
    }, `Edit guild settings`);

    auditLog({ tool: 'edit_guild', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'edit_guild', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function batchCreateStructureOp(args, context = {}) {
  const { roles = [], categories = [], uncategorized_channels = [] } = args;

  let totalItems = roles.length + categories.length + uncategorized_channels.length;
  for (const cat of categories) {
    totalItems += (cat.channels || []).length;
  }

  if (dryRunMode) {
    let currentIdx = 0;
    const createdRoles = roles.map((r, i) => {
      currentIdx++;
      context.onProgress?.({
        current: currentIdx,
        total: totalItems,
        item: `@${r.name}`,
        itemType: 'role',
        status: 'done',
        message: `Simulated role @${r.name} (${currentIdx}/${totalItems})`
      });
      return {
        id: nextFakeSnowflake(),
        name: r.name,
        color: r.color || '#000000',
        position: i + 1
      };
    });

    const createdCategories = [];
    const createdChannels = [];

    for (const [catIdx, cat] of categories.entries()) {
      const catId = nextFakeSnowflake();
      const catChannels = [];
      currentIdx++;
      context.onProgress?.({
        current: currentIdx,
        total: totalItems,
        item: `📁 ${cat.name}`,
        itemType: 'category',
        status: 'done',
        message: `Simulated category ${cat.name} (${currentIdx}/${totalItems})`
      });

      for (const [chIdx, ch] of (cat.channels || []).entries()) {
        const chId = nextFakeSnowflake();
        const chObj = {
          id: chId,
          name: ch.name,
          type: ch.type || 'text',
          parent_id: catId,
          position: chIdx
        };
        catChannels.push(chObj);
        createdChannels.push(chObj);
        currentIdx++;
        context.onProgress?.({
          current: currentIdx,
          total: totalItems,
          item: `#${ch.name}`,
          itemType: 'channel',
          status: 'done',
          message: `Simulated channel #${ch.name} (${currentIdx}/${totalItems})`
        });
      }

      createdCategories.push({
        id: catId,
        name: cat.name,
        private: Boolean(cat.private),
        position: cat.position ?? catIdx,
        channels: catChannels
      });
    }

    for (const [chIdx, ch] of uncategorized_channels.entries()) {
      const chId = nextFakeSnowflake();
      const chObj = {
        id: chId,
        name: ch.name,
        type: ch.type || 'text',
        parent_id: null,
        position: chIdx
      };
      createdChannels.push(chObj);
      currentIdx++;
      context.onProgress?.({
        current: currentIdx,
        total: totalItems,
        item: `#${ch.name}`,
        itemType: 'channel',
        status: 'done',
        message: `Simulated channel #${ch.name} (${currentIdx}/${totalItems})`
      });
    }

    const result = {
      dryRun: true,
      createdRoles,
      createdCategories,
      createdChannels,
      count: {
        roles: createdRoles.length,
        categories: createdCategories.length,
        channels: createdChannels.length
      },
      summary: `Simulated creation of ${createdRoles.length} roles, ${createdCategories.length} categories, and ${createdChannels.length} channels.`
    };

    auditLog({ tool: 'batch_create_structure', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const isCommunity = guild.features.includes('COMMUNITY');

      const createdRoles = [];
      const createdCategories = [];
      const createdChannels = [];
      const roleLookup = new Map(); // lowercase name / id -> roleId
      let currentProgress = 0;

      // 1. Fetch existing roles into lookup ONCE
      const existingRoles = await guild.roles.fetch();
      let currentRoleCount = existingRoles.size;
      for (const r of existingRoles.values()) {
        roleLookup.set(r.name.toLowerCase(), String(r.id));
        roleLookup.set(r.name.toLowerCase().replace(/^@/, ''), String(r.id));
        roleLookup.set(String(r.id), String(r.id));
      }
      roleLookup.set('@everyone', String(guild.id));

      // 2. Fetch existing channels ONCE
      const existingChannels = await guild.channels.fetch();
      let currentChannelCount = existingChannels.filter(
        (c) => c && c.type !== ChannelType.PublicThread && c.type !== ChannelType.PrivateThread && c.type !== ChannelType.AnnouncementThread
      ).size;

      // 3. Create Roles
      for (const roleDef of roles) {
        currentProgress++;
        const existingId = roleLookup.get(roleDef.name.toLowerCase());
        if (existingId && existingId !== guild.id) {
          createdRoles.push({ id: existingId, name: roleDef.name, status: 'existing' });
          context.onProgress?.({
            current: currentProgress,
            total: totalItems,
            item: `@${roleDef.name}`,
            itemType: 'role',
            status: 'done',
            message: `Role @${roleDef.name} already exists (${currentProgress}/${totalItems})`
          });
          continue;
        }

        if (currentRoleCount >= 250) {
          throw new Error(`Guild role limit reached (250 roles maximum).`);
        }

        const bitfield = roleDef.permissions && roleDef.permissions.length > 0 ? namesToBitfield(roleDef.permissions) : undefined;

        try {
          const newRole = await guild.roles.create({
            name: roleDef.name,
            color: roleDef.color || undefined,
            hoist: roleDef.hoist !== undefined ? roleDef.hoist : undefined,
            mentionable: roleDef.mentionable !== undefined ? roleDef.mentionable : undefined,
            permissions: bitfield
          });

          currentRoleCount++;
          const roleId = String(newRole.id);
          roleLookup.set(roleDef.name.toLowerCase(), roleId);
          roleLookup.set(roleId, roleId);
          createdRoles.push({
            id: roleId,
            name: newRole.name,
            color: newRole.hexColor,
            position: newRole.position,
            status: 'created'
          });

          context.onProgress?.({
            current: currentProgress,
            total: totalItems,
            item: `@${newRole.name}`,
            itemType: 'role',
            status: 'done',
            message: `Created role @${newRole.name} (${currentProgress}/${totalItems})`
          });
        } catch (roleErr) {
          console.warn(`[BatchSetup] Failed to create role "${roleDef.name}": ${roleErr.message}`);
          createdRoles.push({ name: roleDef.name, error: roleErr.message, status: 'failed' });
          context.onProgress?.({
            current: currentProgress,
            total: totalItems,
            item: `@${roleDef.name}`,
            itemType: 'role',
            status: 'failed',
            message: `Failed role @${roleDef.name}: ${roleErr.message}`
          });
        }
      }

      // 4. Create Categories & Channels
      for (const [catIdx, catDef] of categories.entries()) {
        currentProgress++;
        if (currentChannelCount >= 500) {
          throw new Error(`Guild channel limit reached (500 maximum).`);
        }

        const permissionOverwrites = [];
        if (catDef.private) {
          permissionOverwrites.push({
            id: guild.id,
            deny: [PermissionsBitField.Flags.ViewChannel]
          });

          const roleRefs = catDef.visible_to_roles || catDef.visible_to_role_ids || [];
          for (const roleRef of roleRefs) {
            const resolvedId = roleLookup.get(String(roleRef).toLowerCase()) || roleLookup.get(String(roleRef).replace(/^@/, '').toLowerCase()) || (await resolveRoleId(guild, roleRef));
            if (resolvedId) {
              permissionOverwrites.push({
                id: resolvedId,
                allow: [PermissionsBitField.Flags.ViewChannel]
              });
            }
          }
        }

        const category = await guild.channels.create({
          name: catDef.name,
          type: ChannelType.GuildCategory,
          position: catDef.position !== undefined ? catDef.position : catIdx,
          permissionOverwrites: permissionOverwrites.length > 0 ? permissionOverwrites : undefined
        });

        currentChannelCount++;
        const categoryId = String(category.id);
        const catChannels = [];

        context.onProgress?.({
          current: currentProgress,
          total: totalItems,
          item: `📁 ${category.name}`,
          itemType: 'category',
          status: 'done',
          message: `Created category ${category.name} (${currentProgress}/${totalItems})`
        });
        context.emit?.('snapshot_updated', {});

        // Create channels in this category
        for (const [chIdx, chDef] of (catDef.channels || []).entries()) {
          currentProgress++;
          if (currentChannelCount >= 500) {
            throw new Error(`Guild channel limit reached (500 maximum).`);
          }

          let channelType = chDef.type || 'text';
          if (['announcement', 'forum', 'stage'].includes(channelType) && !isCommunity) {
            channelType = 'text';
          }

          const discordChannelType = stringToChannelType(channelType);
          const channel = await guild.channels.create({
            name: chDef.name,
            type: discordChannelType,
            parent: categoryId,
            topic: chDef.topic || undefined,
            rateLimitPerUser: chDef.slowmode_seconds !== undefined ? chDef.slowmode_seconds : undefined,
            nsfw: chDef.nsfw !== undefined ? chDef.nsfw : undefined,
            position: chDef.position !== undefined ? chDef.position : chIdx
          });

          currentChannelCount++;
          const chObj = {
            id: String(channel.id),
            name: channel.name,
            type: channelTypeToString(channel.type),
            parent_id: categoryId,
            position: channel.position
          };
          catChannels.push(chObj);
          createdChannels.push(chObj);

          context.onProgress?.({
            current: currentProgress,
            total: totalItems,
            item: `#${channel.name}`,
            itemType: 'channel',
            status: 'done',
            message: `Created channel #${channel.name} (${currentProgress}/${totalItems})`
          });
          context.emit?.('snapshot_updated', {});
        }

        createdCategories.push({
          id: categoryId,
          name: category.name,
          private: Boolean(catDef.private),
          position: category.position,
          channels: catChannels
        });
      }

      // 5. Create Uncategorized Channels
      for (const [chIdx, chDef] of uncategorized_channels.entries()) {
        currentProgress++;
        if (currentChannelCount >= 500) {
          throw new Error(`Guild channel limit reached (500 maximum).`);
        }

        let channelType = chDef.type || 'text';
        if (['announcement', 'forum', 'stage'].includes(channelType) && !isCommunity) {
          channelType = 'text';
        }

        const discordChannelType = stringToChannelType(channelType);
        const channel = await guild.channels.create({
          name: chDef.name,
          type: discordChannelType,
          topic: chDef.topic || undefined,
          position: chDef.position !== undefined ? chDef.position : chIdx
        });

        currentChannelCount++;
        createdChannels.push({
          id: String(channel.id),
          name: channel.name,
          type: channelTypeToString(channel.type),
          parent_id: null,
          position: channel.position
        });

        context.onProgress?.({
          current: currentProgress,
          total: totalItems,
          item: `#${channel.name}`,
          itemType: 'channel',
          status: 'done',
          message: `Created channel #${channel.name} (${currentProgress}/${totalItems})`
        });
        context.emit?.('snapshot_updated', {});
      }

      return {
        createdRoles,
        createdCategories,
        createdChannels,
        count: {
          roles: createdRoles.filter((r) => r.status === 'created').length,
          categories: createdCategories.length,
          channels: createdChannels.length
        },
        summary: `Successfully deployed full server structure: ${createdRoles.length} roles, ${createdCategories.length} categories, and ${createdChannels.length} channels created.`
      };
    }, 'Deploy full server structure (batch)');

    auditLog({ tool: 'batch_create_structure', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'batch_create_structure', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function batchEditChannelsOp(args, context = {}) {
  const { channels = [] } = args;
  const totalItems = channels.length;

  if (dryRunMode) {
    let currentIdx = 0;
    const updatedChannels = channels.map((c) => {
      currentIdx++;
      context.onProgress?.({
        current: currentIdx,
        total: totalItems,
        item: c.name || c.channel_id,
        itemType: 'channel',
        status: 'done',
        message: `Simulated edit channel ${c.name || c.channel_id} (${currentIdx}/${totalItems})`
      });
      return {
        id: c.channel_id,
        name: c.name,
        topic: c.topic,
        slowmode_seconds: c.slowmode_seconds,
        nsfw: c.nsfw
      };
    });
    const result = {
      dryRun: true,
      updatedChannels,
      count: channels.length
    };
    auditLog({ tool: 'batch_edit_channels', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const updatedChannels = [];
      let currentProgress = 0;

      for (const chDef of channels) {
        currentProgress++;
        const resolvedId = await resolveChannelId(guild, chDef.channel_id);
        const channel = await guild.channels.fetch(resolvedId).catch(() => null);
        if (!channel) {
          updatedChannels.push({ id: chDef.channel_id, error: 'Channel not found', status: 'failed' });
          context.onProgress?.({
            current: currentProgress,
            total: totalItems,
            item: chDef.channel_id,
            itemType: 'channel',
            status: 'failed',
            message: `Channel ${chDef.channel_id} not found`
          });
          continue;
        }

        const editData = {};
        if (chDef.name !== undefined) editData.name = chDef.name;
        if (chDef.topic !== undefined) editData.topic = chDef.topic;
        if (chDef.slowmode_seconds !== undefined) editData.rateLimitPerUser = chDef.slowmode_seconds;
        if (chDef.nsfw !== undefined) editData.nsfw = chDef.nsfw;

        const updated = await channel.edit(editData);
        updatedChannels.push({
          id: String(updated.id),
          name: updated.name,
          topic: updated.topic,
          slowmode_seconds: updated.rateLimitPerUser,
          nsfw: updated.nsfw,
          status: 'updated'
        });

        context.onProgress?.({
          current: currentProgress,
          total: totalItems,
          item: `#${updated.name}`,
          itemType: 'channel',
          status: 'done',
          message: `Updated channel #${updated.name} (${currentProgress}/${totalItems})`
        });
        context.emit?.('snapshot_updated', {});
      }

      return {
        updatedChannels,
        count: updatedChannels.filter((c) => c.status === 'updated').length
      };
    }, `Batch edit ${channels.length} channels`);

    auditLog({ tool: 'batch_edit_channels', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'batch_edit_channels', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function batchDeleteChannelsOp(args, context = {}) {
  const { channel_ids = [] } = args;
  const totalItems = channel_ids.length;

  if (dryRunMode) {
    let currentIdx = 0;
    const deletedChannels = channel_ids.map((id) => {
      currentIdx++;
      context.onProgress?.({
        current: currentIdx,
        total: totalItems,
        item: id,
        itemType: 'channel',
        status: 'done',
        message: `Simulated deletion of channel ${id} (${currentIdx}/${totalItems})`
      });
      return { id, deleted: true };
    });
    const result = {
      dryRun: true,
      deletedChannels,
      count: channel_ids.length
    };
    auditLog({ tool: 'batch_delete_channels', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const deletedChannels = [];
      let currentProgress = 0;

      for (const id of channel_ids) {
        currentProgress++;
        const resolvedId = await resolveChannelId(guild, id);
        const channel = await guild.channels.fetch(resolvedId).catch(() => null);
        if (!channel) {
          deletedChannels.push({ id, error: 'Channel not found', status: 'failed' });
          context.onProgress?.({
            current: currentProgress,
            total: totalItems,
            item: id,
            itemType: 'channel',
            status: 'failed',
            message: `Channel ${id} not found`
          });
          continue;
        }

        const name = channel.name;
        await channel.delete();
        deletedChannels.push({ id: resolvedId, name, status: 'deleted' });

        context.onProgress?.({
          current: currentProgress,
          total: totalItems,
          item: `#${name}`,
          itemType: 'channel',
          status: 'done',
          message: `Deleted #${name} (${currentProgress}/${totalItems})`
        });
        context.emit?.('snapshot_updated', {});
      }

      return {
        deletedChannels,
        count: deletedChannels.filter((c) => c.status === 'deleted').length
      };
    }, `Batch delete ${channel_ids.length} channels`);

    auditLog({ tool: 'batch_delete_channels', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'batch_delete_channels', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function batchMoveChannelsOp(args, context = {}) {
  const { moves = [] } = args;
  const totalItems = moves.length;

  if (dryRunMode) {
    let currentIdx = 0;
    const movedChannels = moves.map((m) => {
      currentIdx++;
      context.onProgress?.({
        current: currentIdx,
        total: totalItems,
        item: m.channel_id,
        itemType: 'channel',
        status: 'done',
        message: `Simulated move channel ${m.channel_id} (${currentIdx}/${totalItems})`
      });
      return {
        id: m.channel_id,
        parent_id: m.parent_id || null,
        position: m.position
      };
    });
    const result = {
      dryRun: true,
      movedChannels,
      count: moves.length
    };
    auditLog({ tool: 'batch_move_channels', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const movedChannels = [];
      let currentProgress = 0;

      for (const m of moves) {
        currentProgress++;
        const resolvedId = await resolveChannelId(guild, m.channel_id);
        const channel = await guild.channels.fetch(resolvedId).catch(() => null);
        if (!channel) {
          movedChannels.push({ id: m.channel_id, error: 'Channel not found', status: 'failed' });
          continue;
        }

        const resolvedParentId = m.parent_id ? await resolveCategoryId(guild, m.parent_id) : null;
        const updated = await channel.edit({
          parent: resolvedParentId,
          position: m.position !== undefined ? m.position : undefined
        });

        movedChannels.push({
          id: String(updated.id),
          name: updated.name,
          parent_id: updated.parentId ? String(updated.parentId) : null,
          position: updated.position,
          status: 'moved'
        });

        context.onProgress?.({
          current: currentProgress,
          total: totalItems,
          item: `#${updated.name}`,
          itemType: 'channel',
          status: 'done',
          message: `Moved #${updated.name} (${currentProgress}/${totalItems})`
        });
        context.emit?.('snapshot_updated', {});
      }

      return {
        movedChannels,
        count: movedChannels.filter((c) => c.status === 'moved').length
      };
    }, `Batch move ${moves.length} channels`);

    auditLog({ tool: 'batch_move_channels', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'batch_move_channels', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function batchEditRolesOp(args, context = {}) {
  const { roles = [] } = args;
  const totalItems = roles.length;

  if (dryRunMode) {
    let currentIdx = 0;
    const updatedRoles = roles.map((r) => {
      currentIdx++;
      context.onProgress?.({
        current: currentIdx,
        total: totalItems,
        item: r.name || r.role_id,
        itemType: 'role',
        status: 'done',
        message: `Simulated edit role ${r.name || r.role_id} (${currentIdx}/${totalItems})`
      });
      return {
        id: r.role_id,
        name: r.name,
        color: r.color,
        hoist: r.hoist,
        mentionable: r.mentionable
      };
    });
    const result = {
      dryRun: true,
      updatedRoles,
      count: roles.length
    };
    auditLog({ tool: 'batch_edit_roles', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const updatedRoles = [];
      let currentProgress = 0;

      for (const rDef of roles) {
        currentProgress++;
        const resolvedId = await resolveRoleId(guild, rDef.role_id);
        const role = await checkRoleHierarchy(guild, resolvedId).catch((err) => {
          updatedRoles.push({ id: rDef.role_id, error: err.message, status: 'failed' });
          return null;
        });

        if (!role) continue;

        const editData = {};
        if (rDef.name !== undefined && role.id !== guild.id) editData.name = rDef.name;
        if (rDef.color !== undefined) editData.color = rDef.color;
        if (rDef.hoist !== undefined && role.id !== guild.id) editData.hoist = rDef.hoist;
        if (rDef.mentionable !== undefined && role.id !== guild.id) editData.mentionable = rDef.mentionable;
        if (rDef.permissions !== undefined) editData.permissions = namesToBitfield(rDef.permissions);

        const updated = await role.edit(editData);
        updatedRoles.push({
          id: String(updated.id),
          name: updated.name,
          color: updated.hexColor,
          status: 'updated'
        });

        context.onProgress?.({
          current: currentProgress,
          total: totalItems,
          item: `@${updated.name}`,
          itemType: 'role',
          status: 'done',
          message: `Updated role @${updated.name} (${currentProgress}/${totalItems})`
        });
        context.emit?.('snapshot_updated', {});
      }

      return {
        updatedRoles,
        count: updatedRoles.filter((r) => r.status === 'updated').length
      };
    }, `Batch edit ${roles.length} roles`);

    auditLog({ tool: 'batch_edit_roles', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'batch_edit_roles', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function batchDeleteRolesOp(args, context = {}) {
  const { role_ids = [] } = args;
  const totalItems = role_ids.length;

  if (dryRunMode) {
    let currentIdx = 0;
    const deletedRoles = role_ids.map((id) => {
      currentIdx++;
      context.onProgress?.({
        current: currentIdx,
        total: totalItems,
        item: id,
        itemType: 'role',
        status: 'done',
        message: `Simulated delete role ${id} (${currentIdx}/${totalItems})`
      });
      return { id, deleted: true };
    });
    const result = {
      dryRun: true,
      deletedRoles,
      count: role_ids.length
    };
    auditLog({ tool: 'batch_delete_roles', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const deletedRoles = [];
      let currentProgress = 0;

      for (const id of role_ids) {
        currentProgress++;
        const resolvedId = await resolveRoleId(guild, id);
        if (resolvedId === guild.id) {
          deletedRoles.push({ id, error: 'Cannot delete @everyone', status: 'failed' });
          continue;
        }

        const role = await checkRoleHierarchy(guild, resolvedId).catch((err) => {
          deletedRoles.push({ id, error: err.message, status: 'failed' });
          return null;
        });

        if (!role) continue;

        const name = role.name;
        await role.delete();
        deletedRoles.push({ id: resolvedId, name, status: 'deleted' });

        context.onProgress?.({
          current: currentProgress,
          total: totalItems,
          item: `@${name}`,
          itemType: 'role',
          status: 'done',
          message: `Deleted role @${name} (${currentProgress}/${totalItems})`
        });
        context.emit?.('snapshot_updated', {});
      }

      return {
        deletedRoles,
        count: deletedRoles.filter((r) => r.status === 'deleted').length
      };
    }, `Batch delete ${role_ids.length} roles`);

    auditLog({ tool: 'batch_delete_roles', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'batch_delete_roles', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function batchCreateCategoriesOp(args, context = {}) {
  const { categories = [] } = args;
  const totalItems = categories.length;

  if (dryRunMode) {
    let currentIdx = 0;
    const createdCategories = categories.map((cat, idx) => {
      currentIdx++;
      context.onProgress?.({
        current: currentIdx,
        total: totalItems,
        item: `📁 ${cat.name}`,
        itemType: 'category',
        status: 'done',
        message: `Simulated category ${cat.name} (${currentIdx}/${totalItems})`
      });
      return {
        id: nextFakeSnowflake(),
        name: cat.name,
        position: cat.position ?? idx,
        private: Boolean(cat.private),
        visible_to_role_ids: cat.visible_to_role_ids || cat.visible_to_roles || []
      };
    });

    const result = {
      dryRun: true,
      categories: createdCategories,
      count: createdCategories.length,
      summary: `Simulated creation of ${createdCategories.length} categories.`
    };
    auditLog({ tool: 'batch_create_categories', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const createdCategories = [];
      let currentProgress = 0;

      // Fetch existing channels & roles once
      const existingChannels = await guild.channels.fetch();
      let currentChannelCount = existingChannels.filter(
        (c) => c && c.type !== ChannelType.PublicThread && c.type !== ChannelType.PrivateThread && c.type !== ChannelType.AnnouncementThread
      ).size;

      const existingRoles = await guild.roles.fetch();
      const roleLookup = new Map();
      for (const r of existingRoles.values()) {
        roleLookup.set(r.name.toLowerCase(), String(r.id));
        roleLookup.set(r.name.toLowerCase().replace(/^@/, ''), String(r.id));
        roleLookup.set(String(r.id), String(r.id));
      }
      roleLookup.set('@everyone', String(guild.id));

      for (const [catIdx, catDef] of categories.entries()) {
        currentProgress++;
        if (currentChannelCount >= 500) {
          throw new Error(`Guild channel limit reached (500 maximum).`);
        }

        const permissionOverwrites = [];
        if (catDef.private) {
          permissionOverwrites.push({
            id: guild.id,
            deny: [PermissionsBitField.Flags.ViewChannel]
          });

          const roleRefs = catDef.visible_to_roles || catDef.visible_to_role_ids || [];
          for (const roleRef of roleRefs) {
            const resolvedId = roleLookup.get(String(roleRef).toLowerCase()) || (await resolveRoleId(guild, roleRef));
            if (resolvedId) {
              permissionOverwrites.push({
                id: resolvedId,
                allow: [PermissionsBitField.Flags.ViewChannel]
              });
            }
          }
        }

        const category = await guild.channels.create({
          name: catDef.name,
          type: ChannelType.GuildCategory,
          position: catDef.position !== undefined ? catDef.position : catIdx,
          permissionOverwrites: permissionOverwrites.length > 0 ? permissionOverwrites : undefined
        });

        currentChannelCount++;
        createdCategories.push({
          id: String(category.id),
          name: category.name,
          position: category.position,
          private: Boolean(catDef.private),
          status: 'created'
        });

        context.onProgress?.({
          current: currentProgress,
          total: totalItems,
          item: `📁 ${category.name}`,
          itemType: 'category',
          status: 'done',
          message: `Created category ${category.name} (${currentProgress}/${totalItems})`
        });
        context.emit?.('snapshot_updated', {});
      }

      return {
        categories: createdCategories,
        count: createdCategories.length
      };
    }, `Batch create ${categories.length} categories`);

    auditLog({ tool: 'batch_create_categories', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'batch_create_categories', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function batchCreateChannelsOp(args, context = {}) {
  const { channels = [] } = args;
  const totalItems = channels.length;

  if (dryRunMode) {
    let currentIdx = 0;
    const createdChannels = channels.map((ch, idx) => {
      currentIdx++;
      context.onProgress?.({
        current: currentIdx,
        total: totalItems,
        item: `#${ch.name}`,
        itemType: 'channel',
        status: 'done',
        message: `Simulated channel #${ch.name} (${currentIdx}/${totalItems})`
      });
      return {
        id: nextFakeSnowflake(),
        name: ch.name,
        type: ch.type || 'text',
        parent_id: ch.parent_id || null,
        topic: ch.topic || null,
        slowmode_seconds: ch.slowmode_seconds || 0,
        nsfw: Boolean(ch.nsfw),
        position: ch.position ?? idx
      };
    });

    const result = {
      dryRun: true,
      channels: createdChannels,
      count: createdChannels.length,
      summary: `Simulated creation of ${createdChannels.length} channels.`
    };
    auditLog({ tool: 'batch_create_channels', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const isCommunity = guild.features.includes('COMMUNITY');
      const createdChannels = [];
      let currentProgress = 0;

      // 1. Fetch existing channels once
      const existingChannels = await guild.channels.fetch();
      let currentChannelCount = existingChannels.filter(
        (c) => c && c.type !== ChannelType.PublicThread && c.type !== ChannelType.PrivateThread && c.type !== ChannelType.AnnouncementThread
      ).size;

      // 2. Build in-memory category lookup
      const categoryLookup = new Map();
      for (const c of existingChannels.values()) {
        if (c && c.type === ChannelType.GuildCategory) {
          categoryLookup.set(c.name.toLowerCase(), String(c.id));
          categoryLookup.set(String(c.id), String(c.id));
        }
      }

      for (const [chIdx, chDef] of channels.entries()) {
        currentProgress++;
        if (currentChannelCount >= 500) {
          throw new Error(`Guild channel limit reached (500 channels maximum).`);
        }

        const resolvedParentId = chDef.parent_id
          ? (categoryLookup.get(String(chDef.parent_id).toLowerCase()) || (await resolveCategoryId(guild, chDef.parent_id)))
          : undefined;

        let channelType = chDef.type || 'text';
        if (['announcement', 'forum', 'stage'].includes(channelType) && !isCommunity) {
          channelType = 'text';
        }

        const discordChannelType = stringToChannelType(channelType);
        const channel = await guild.channels.create({
          name: chDef.name,
          type: discordChannelType,
          parent: resolvedParentId,
          topic: chDef.topic || undefined,
          rateLimitPerUser: chDef.slowmode_seconds !== undefined ? chDef.slowmode_seconds : undefined,
          nsfw: chDef.nsfw !== undefined ? chDef.nsfw : undefined,
          position: chDef.position !== undefined ? chDef.position : chIdx
        });

        currentChannelCount++;
        createdChannels.push({
          id: String(channel.id),
          name: channel.name,
          type: channelTypeToString(channel.type),
          parent_id: channel.parentId ? String(channel.parentId) : null,
          position: channel.position,
          status: 'created'
        });

        context.onProgress?.({
          current: currentProgress,
          total: totalItems,
          item: `#${channel.name}`,
          itemType: 'channel',
          status: 'done',
          message: `Created channel #${channel.name} (${currentProgress}/${totalItems})`
        });
        context.emit?.('snapshot_updated', {});
      }

      return {
        channels: createdChannels,
        count: createdChannels.length
      };
    }, `Batch create ${channels.length} channels`);

    auditLog({ tool: 'batch_create_channels', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'batch_create_channels', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function batchCreateRolesOp(args, context = {}) {
  const { roles = [] } = args;
  const totalItems = roles.length;

  if (dryRunMode) {
    let currentIdx = 0;
    const createdRoles = roles.map((r, idx) => {
      currentIdx++;
      context.onProgress?.({
        current: currentIdx,
        total: totalItems,
        item: `@${r.name}`,
        itemType: 'role',
        status: 'done',
        message: `Simulated role @${r.name} (${currentIdx}/${totalItems})`
      });
      return {
        id: nextFakeSnowflake(),
        name: r.name,
        color: r.color || '#000000',
        hoist: Boolean(r.hoist),
        mentionable: Boolean(r.mentionable),
        permissions: r.permissions || [],
        position: idx + 1
      };
    });

    const result = {
      dryRun: true,
      roles: createdRoles,
      count: createdRoles.length,
      summary: `Simulated creation of ${createdRoles.length} roles.`
    };
    auditLog({ tool: 'batch_create_roles', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const createdRoles = [];
      let currentProgress = 0;

      const existingRoles = await guild.roles.fetch();
      let currentRoleCount = existingRoles.size;

      for (const roleDef of roles) {
        currentProgress++;
        if (currentRoleCount >= 250) {
          throw new Error(`Guild role limit reached (250 roles maximum).`);
        }

        const bitfield = roleDef.permissions && roleDef.permissions.length > 0 ? namesToBitfield(roleDef.permissions) : undefined;

        try {
          const newRole = await guild.roles.create({
            name: roleDef.name,
            color: roleDef.color || undefined,
            hoist: roleDef.hoist !== undefined ? roleDef.hoist : undefined,
            mentionable: roleDef.mentionable !== undefined ? roleDef.mentionable : undefined,
            permissions: bitfield
          });

          currentRoleCount++;
          createdRoles.push({
            id: String(newRole.id),
            name: newRole.name,
            color: newRole.hexColor,
            hoist: newRole.hoist,
            mentionable: newRole.mentionable,
            position: newRole.position,
            status: 'created'
          });

          context.onProgress?.({
            current: currentProgress,
            total: totalItems,
            item: `@${newRole.name}`,
            itemType: 'role',
            status: 'done',
            message: `Created role @${newRole.name} (${currentProgress}/${totalItems})`
          });
          context.emit?.('snapshot_updated', {});
        } catch (roleErr) {
          console.warn(`[BatchCreateRoles] Failed to create role "${roleDef.name}": ${roleErr.message}`);
          createdRoles.push({ name: roleDef.name, error: roleErr.message, status: 'failed' });
          context.onProgress?.({
            current: currentProgress,
            total: totalItems,
            item: `@${roleDef.name}`,
            itemType: 'role',
            status: 'failed',
            message: `Failed role @${roleDef.name}: ${roleErr.message}`
          });
        }
      }

      return {
        roles: createdRoles,
        count: createdRoles.filter((r) => r.status === 'created').length
      };
    }, `Batch create ${roles.length} roles`);

    auditLog({ tool: 'batch_create_roles', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'batch_create_roles', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function batchSetChannelPermissionsOp(args, context = {}) {
  const { overwrites = [] } = args;
  const totalItems = overwrites.length;

  if (dryRunMode) {
    let currentIdx = 0;
    const result = {
      dryRun: true,
      overwrites: overwrites.map((ow) => {
        currentIdx++;
        context.onProgress?.({
          current: currentIdx,
          total: totalItems,
          item: `${ow.channel_id} / ${ow.target_id}`,
          itemType: 'permission',
          status: 'done',
          message: `Simulated permissions on ${ow.channel_id} (${currentIdx}/${totalItems})`
        });
        return {
          channel_id: ow.channel_id,
          target_id: ow.target_id,
          target_type: ow.target_type,
          allow: ow.allow || [],
          deny: ow.deny || []
        };
      }),
      count: overwrites.length
    };
    auditLog({ tool: 'batch_set_channel_permissions', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const updatedOverwrites = [];
      let currentProgress = 0;

      for (const ow of overwrites) {
        currentProgress++;
        const resolvedChannelId = await resolveChannelId(guild, ow.channel_id);
        const channel = await guild.channels.fetch(resolvedChannelId).catch(() => null);
        if (!channel) {
          updatedOverwrites.push({ channel_id: ow.channel_id, error: 'Channel not found', status: 'failed' });
          continue;
        }

        const resolvedTargetId = ow.target_type === 'role' ? await resolveRoleId(guild, ow.target_id) : ow.target_id;
        const overwriteType = ow.target_type === 'role' ? OverwriteType.Role : OverwriteType.Member;

        const allowList = ow.allow || [];
        const denyList = ow.deny || [];

        await channel.permissionOverwrites.edit(resolvedTargetId, {
          ...Object.fromEntries(allowList.map((perm) => [perm, true])),
          ...Object.fromEntries(denyList.map((perm) => [perm, false]))
        }, {
          type: overwriteType
        });

        updatedOverwrites.push({
          channel_id: resolvedChannelId,
          target_id: resolvedTargetId,
          target_type: ow.target_type,
          allow: allowList,
          deny: denyList,
          status: 'updated'
        });

        context.onProgress?.({
          current: currentProgress,
          total: totalItems,
          item: `🔒 Overwrite ${ow.channel_id}`,
          itemType: 'permission',
          status: 'done',
          message: `Set permissions on ${ow.channel_id} (${currentProgress}/${totalItems})`
        });
      }

      return {
        overwrites: updatedOverwrites,
        count: updatedOverwrites.filter((ow) => ow.status === 'updated').length
      };
    }, `Batch set ${overwrites.length} permission overwrites`);

    auditLog({ tool: 'batch_set_channel_permissions', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'batch_set_channel_permissions', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function batchSendMessagesOp(args, context = {}) {
  const { messages = [] } = args;
  const totalItems = messages.length;

  if (dryRunMode) {
    let currentIdx = 0;
    const sentMessages = messages.map((m) => {
      currentIdx++;
      context.onProgress?.({
        current: currentIdx,
        total: totalItems,
        item: `💬 ${m.channel_id}`,
        itemType: 'message',
        status: 'done',
        message: `Simulated message in ${m.channel_id} (${currentIdx}/${totalItems})`
      });
      return {
        channel_id: m.channel_id,
        contentPreview: m.content.slice(0, 100),
        pinned: Boolean(m.pin)
      };
    });
    const result = {
      dryRun: true,
      sentMessages,
      count: messages.length
    };
    auditLog({ tool: 'batch_send_messages', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const sentMessages = [];
      let currentProgress = 0;

      for (const m of messages) {
        currentProgress++;
        const resolvedChannelId = await resolveChannelId(guild, m.channel_id);
        const channel = await guild.channels.fetch(resolvedChannelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
          sentMessages.push({ channel_id: m.channel_id, error: 'Channel not found or not text-based', status: 'failed' });
          continue;
        }

        const msg = await channel.send(m.content);
        if (m.pin) {
          await msg.pin().catch((err) => {
            console.warn(`Could not pin message in channel ${m.channel_id}: ${err.message}`);
          });
        }

        sentMessages.push({
          messageId: String(msg.id),
          channel_id: String(channel.id),
          pinned: Boolean(m.pin),
          status: 'sent'
        });

        context.onProgress?.({
          current: currentProgress,
          total: totalItems,
          item: `💬 ${m.channel_id}`,
          itemType: 'message',
          status: 'done',
          message: `Sent message to ${m.channel_id} (${currentProgress}/${totalItems})`
        });
      }

      return {
        sentMessages,
        count: sentMessages.filter((m) => m.status === 'sent').length
      };
    }, `Batch send ${messages.length} messages`);

    auditLog({ tool: 'batch_send_messages', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'batch_send_messages', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

// -------------------------------------------------------------
// Member & Moderation Operations
// -------------------------------------------------------------

export async function listMembersOp(args = {}) {
  const { query, limit = 50, after } = args;

  if (dryRunMode) {
    const result = {
      dryRun: true,
      members: [
        { id: '100000000000000001', username: 'ServerOwner', nickname: '👑 Founder', roles: ['Admin'], joinedAt: new Date().toISOString(), isOwner: true },
        { id: '100000000000000002', username: 'ModeratorOne', nickname: 'Mod', roles: ['Moderator'], joinedAt: new Date().toISOString(), isOwner: false },
        { id: '100000000000000003', username: 'ActiveUser', nickname: null, roles: ['Member'], joinedAt: new Date().toISOString(), isOwner: false }
      ],
      count: 3
    };
    auditLog({ tool: 'list_members', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      let membersCollection;

      if (query && query.trim()) {
        membersCollection = await guild.members.search({ query: query.trim(), limit: Math.min(limit, 100) });
      } else {
        membersCollection = await guild.members.fetch({ limit: Math.min(limit, 100), after });
      }

      const members = membersCollection.map((m) => ({
        id: String(m.id),
        username: m.user.username,
        globalName: m.user.globalName || null,
        nickname: m.nickname || null,
        bot: m.user.bot,
        isOwner: m.id === guild.ownerId,
        roles: m.roles.cache
          .filter((r) => r.id !== guild.id)
          .sort((a, b) => b.position - a.position)
          .map((r) => ({ id: String(r.id), name: r.name, position: r.position })),
        highestRole: m.roles.highest ? { id: String(m.roles.highest.id), name: m.roles.highest.name, position: m.roles.highest.position } : null,
        joinedAt: m.joinedAt ? m.joinedAt.toISOString() : null,
        communicationDisabledUntil: m.communicationDisabledUntil ? m.communicationDisabledUntil.toISOString() : null
      }));

      return {
        members,
        count: members.length
      };
    }, 'List / search guild members');

    auditLog({ tool: 'list_members', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'list_members', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function assignMemberRoleOp(args) {
  const { member_id, role_id, reason } = args;

  if (dryRunMode) {
    const result = { dryRun: true, member_id, role_id, assigned: true, reason };
    auditLog({ tool: 'assign_member_role', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedMemberId = await resolveMemberId(guild, member_id);
      const member = await guild.members.fetch(resolvedMemberId).catch(() => null);
      if (!member) {
        throw new Error(`Member "${member_id}" was not found in this server.`);
      }

      const resolvedRoleId = await resolveRoleId(guild, role_id);
      const role = await checkRoleHierarchy(guild, resolvedRoleId);
      await checkMemberHierarchy(guild, member);

      await member.roles.add(role, reason || undefined);
      return {
        member_id: resolvedMemberId,
        username: member.user.username,
        role_id: String(role.id),
        role_name: role.name,
        assigned: true
      };
    }, `Assign role ${role_id} to member ${member_id}`);

    auditLog({ tool: 'assign_member_role', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'assign_member_role', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function removeMemberRoleOp(args) {
  const { member_id, role_id, reason } = args;

  if (dryRunMode) {
    const result = { dryRun: true, member_id, role_id, removed: true, reason };
    auditLog({ tool: 'remove_member_role', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedMemberId = await resolveMemberId(guild, member_id);
      const member = await guild.members.fetch(resolvedMemberId).catch(() => null);
      if (!member) {
        throw new Error(`Member "${member_id}" was not found in this server.`);
      }

      const resolvedRoleId = await resolveRoleId(guild, role_id);
      const role = await checkRoleHierarchy(guild, resolvedRoleId);
      await checkMemberHierarchy(guild, member);

      await member.roles.remove(role, reason || undefined);
      return {
        member_id: resolvedMemberId,
        username: member.user.username,
        role_id: String(role.id),
        role_name: role.name,
        removed: true
      };
    }, `Remove role ${role_id} from member ${member_id}`);

    auditLog({ tool: 'remove_member_role', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'remove_member_role', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function setMemberNicknameOp(args) {
  const { member_id, nickname, reason } = args;

  if (dryRunMode) {
    const result = { dryRun: true, member_id, nickname, reason };
    auditLog({ tool: 'set_member_nickname', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedMemberId = await resolveMemberId(guild, member_id);
      const member = await guild.members.fetch(resolvedMemberId).catch(() => null);
      if (!member) {
        throw new Error(`Member "${member_id}" was not found in this server.`);
      }

      await checkMemberHierarchy(guild, member);
      const updated = await member.setNickname(nickname || null, reason || undefined);
      return {
        member_id: resolvedMemberId,
        username: member.user.username,
        nickname: updated.nickname
      };
    }, `Set nickname for member ${member_id}`);

    auditLog({ tool: 'set_member_nickname', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'set_member_nickname', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function timeoutMemberOp(args) {
  const { member_id, duration_minutes, reason } = args;

  if (dryRunMode) {
    const result = {
      dryRun: true,
      member_id,
      duration_minutes,
      timed_out: Boolean(duration_minutes && duration_minutes > 0),
      reason
    };
    auditLog({ tool: 'timeout_member', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedMemberId = await resolveMemberId(guild, member_id);
      const member = await guild.members.fetch(resolvedMemberId).catch(() => null);
      if (!member) {
        throw new Error(`Member "${member_id}" was not found in this server.`);
      }

      await checkMemberHierarchy(guild, member);
      const durationMs = duration_minutes && duration_minutes > 0 ? duration_minutes * 60 * 1000 : null;
      await member.timeout(durationMs, reason || undefined);

      return {
        member_id: resolvedMemberId,
        username: member.user.username,
        duration_minutes: duration_minutes || 0,
        timed_out: Boolean(duration_minutes && duration_minutes > 0),
        communicationDisabledUntil: member.communicationDisabledUntil ? member.communicationDisabledUntil.toISOString() : null
      };
    }, `Timeout member ${member_id} for ${duration_minutes} minutes`);

    auditLog({ tool: 'timeout_member', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'timeout_member', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function kickMemberOp(args) {
  const { member_id, reason } = args;

  if (dryRunMode) {
    const result = { dryRun: true, member_id, kicked: true, reason };
    auditLog({ tool: 'kick_member', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedMemberId = await resolveMemberId(guild, member_id);
      const member = await guild.members.fetch(resolvedMemberId).catch(() => null);
      if (!member) {
        throw new Error(`Member "${member_id}" was not found in this server.`);
      }

      await checkMemberHierarchy(guild, member);
      const username = member.user.username;
      await member.kick(reason || undefined);

      return {
        member_id: resolvedMemberId,
        username,
        kicked: true,
        reason
      };
    }, `Kick member ${member_id}`);

    auditLog({ tool: 'kick_member', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'kick_member', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function banMemberOp(args) {
  const { user_id, delete_message_seconds = 0, reason } = args;

  if (dryRunMode) {
    const result = { dryRun: true, user_id, delete_message_seconds, banned: true, reason };
    auditLog({ tool: 'ban_member', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedUserId = await resolveMemberId(guild, user_id);

      const member = await guild.members.fetch(resolvedUserId).catch(() => null);
      if (member) {
        await checkMemberHierarchy(guild, member);
      }

      await guild.members.ban(resolvedUserId, {
        deleteMessageSeconds: delete_message_seconds,
        reason: reason || undefined
      });

      return {
        user_id: resolvedUserId,
        banned: true,
        delete_message_seconds,
        reason
      };
    }, `Ban user ${user_id}`);

    auditLog({ tool: 'ban_member', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'ban_member', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function unbanMemberOp(args) {
  const { user_id, reason } = args;

  if (dryRunMode) {
    const result = { dryRun: true, user_id, unbanned: true, reason };
    auditLog({ tool: 'unban_member', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedUserId = await resolveMemberId(guild, user_id);
      await guild.members.unban(resolvedUserId, reason || undefined);
      return {
        user_id: resolvedUserId,
        unbanned: true,
        reason
      };
    }, `Unban user ${user_id}`);

    auditLog({ tool: 'unban_member', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'unban_member', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function listBansOp(args = {}) {
  const { limit = 50 } = args;

  if (dryRunMode) {
    const result = {
      dryRun: true,
      bans: [
        { user: { id: '900000000000000001', username: 'spammer_account', tag: 'spammer_account#0000' }, reason: 'Spamming harmful links' }
      ],
      count: 1
    };
    auditLog({ tool: 'list_bans', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const bansCollection = await guild.bans.fetch({ limit: Math.min(limit, 100) });
      const bans = bansCollection.map((b) => ({
        user: {
          id: String(b.user.id),
          username: b.user.username,
          tag: b.user.tag,
          bot: b.user.bot
        },
        reason: b.reason || null
      }));

      return {
        bans,
        count: bans.length
      };
    }, 'List guild bans');

    auditLog({ tool: 'list_bans', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'list_bans', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

// -------------------------------------------------------------
// Message & Chat History Operations
// -------------------------------------------------------------

export async function getChannelMessagesOp(args) {
  const { channel_id, limit = 50, before_id, after_id, around_id } = args;

  if (dryRunMode) {
    const result = {
      dryRun: true,
      channel_id,
      messages: [
        {
          id: '100000000000000010',
          author: { id: '100000000000000001', username: 'ServerOwner', bot: false },
          content: 'Welcome to the server everyone! Check the rules.',
          created_at: new Date(Date.now() - 3600000).toISOString(),
          pinned: true,
          attachments_count: 0,
          embeds_count: 0
        },
        {
          id: '100000000000000011',
          author: { id: '100000000000000003', username: 'ActiveUser', bot: false },
          content: 'Glad to be here! What channels are coming next?',
          created_at: new Date(Date.now() - 1800000).toISOString(),
          pinned: false,
          attachments_count: 0,
          embeds_count: 0
        }
      ],
      count: 2
    };
    auditLog({ tool: 'get_channel_messages', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedChannelId = await resolveChannelId(guild, channel_id);
      const channel = await guild.channels.fetch(resolvedChannelId).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        throw new Error(`Channel "${channel_id}" was not found or is not a text-based channel.`);
      }

      const options = { limit: Math.min(limit, 100) };
      if (before_id) options.before = before_id;
      if (after_id) options.after = after_id;
      if (around_id) options.around = around_id;

      const messagesCollection = await channel.messages.fetch(options);
      let missingMessageContentWarning = false;

      const messages = messagesCollection.map((m) => {
        let displayContent = m.content;
        if (!displayContent || displayContent.trim() === '') {
          if (m.attachments.size > 0) {
            displayContent = `[Attachment: ${m.attachments.map((a) => a.name || a.url).join(', ')}]`;
          } else if (m.embeds.length > 0) {
            displayContent = `[Embed: ${m.embeds[0].title || m.embeds[0].description || 'Rich Embed'}]`;
          } else if (m.stickers?.size > 0) {
            displayContent = `[Sticker: ${m.stickers.map((s) => s.name).join(', ')}]`;
          } else if (!m.author.bot) {
            displayContent = '[Message Content Empty — Privileged Message Content Intent not enabled in Developer Portal]';
            missingMessageContentWarning = true;
          }
        }

        return {
          id: String(m.id),
          author: {
            id: String(m.author.id),
            username: m.author.username,
            bot: m.author.bot
          },
          content: displayContent,
          raw_content: m.content,
          created_at: m.createdAt.toISOString(),
          pinned: m.pinned,
          attachments_count: m.attachments.size,
          embeds_count: m.embeds.length,
          reactions_count: m.reactions.cache.size
        };
      });

      const response = {
        channel_id: String(channel.id),
        channel_name: channel.name,
        messages,
        count: messages.length
      };

      if (missingMessageContentWarning) {
        response.message_content_intent_notice = "User message text was stripped by Discord. To allow the bot to read user messages, go to Discord Developer Portal (https://discord.com/developers/applications) > Your Application > Bot tab > Scroll down to 'Privileged Gateway Intents' > Toggle ON 'Message Content Intent', then restart the bot.";
      }

      return response;
    }, `Fetch messages from channel ${channel_id}`);

    auditLog({ tool: 'get_channel_messages', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'get_channel_messages', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function editMessageOp(args) {
  const { channel_id, message_id, content } = args;

  if (dryRunMode) {
    const result = {
      dryRun: true,
      channel_id,
      message_id,
      contentPreview: content.slice(0, 100),
      edited: true
    };
    auditLog({ tool: 'edit_message', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedChannelId = await resolveChannelId(guild, channel_id);
      const channel = await guild.channels.fetch(resolvedChannelId).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        throw new Error(`Channel "${channel_id}" was not found or is not a text-based channel.`);
      }

      const msg = await channel.messages.fetch(message_id).catch(() => null);
      if (!msg) {
        throw new Error(`Message with ID "${message_id}" was not found in channel ${channel_id}.`);
      }

      const updated = await msg.edit(content);
      return {
        message_id: String(updated.id),
        channel_id: String(channel.id),
        edited: true
      };
    }, `Edit message ${message_id} in channel ${channel_id}`);

    auditLog({ tool: 'edit_message', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'edit_message', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function deleteMessageOp(args) {
  const { channel_id, message_id, reason } = args;

  if (dryRunMode) {
    const result = { dryRun: true, channel_id, message_id, deleted: true, reason };
    auditLog({ tool: 'delete_message', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedChannelId = await resolveChannelId(guild, channel_id);
      const channel = await guild.channels.fetch(resolvedChannelId).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        throw new Error(`Channel "${channel_id}" was not found or is not a text-based channel.`);
      }

      const msg = await channel.messages.fetch(message_id).catch(() => null);
      if (!msg) {
        throw new Error(`Message with ID "${message_id}" was not found in channel ${channel_id}.`);
      }

      await msg.delete();
      return {
        message_id,
        channel_id: String(channel.id),
        deleted: true,
        reason
      };
    }, `Delete message ${message_id} in channel ${channel_id}`);

    auditLog({ tool: 'delete_message', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'delete_message', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function purgeMessagesOp(args) {
  const { channel_id, count = 10, filter_user_id, bot_only, reason } = args;

  if (dryRunMode) {
    const result = {
      dryRun: true,
      channel_id,
      purged_count: Math.min(count, 100),
      filter_user_id,
      bot_only: Boolean(bot_only),
      reason
    };
    auditLog({ tool: 'purge_messages', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedChannelId = await resolveChannelId(guild, channel_id);
      const channel = await guild.channels.fetch(resolvedChannelId).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        throw new Error(`Channel "${channel_id}" was not found or is not a text-based channel.`);
      }

      let resolvedFilterUserId = null;
      if (filter_user_id) {
        resolvedFilterUserId = await resolveMemberId(guild, filter_user_id);
      }

      const fetchLimit = Math.min(Math.max(count, 2), 100);
      const messagesCollection = await channel.messages.fetch({ limit: fetchLimit });
      let messagesToDelete = Array.from(messagesCollection.values());

      if (resolvedFilterUserId) {
        messagesToDelete = messagesToDelete.filter((m) => m.author.id === resolvedFilterUserId);
      }
      if (bot_only) {
        messagesToDelete = messagesToDelete.filter((m) => m.author.bot);
      }

      if (messagesToDelete.length === 0) {
        return {
          channel_id: String(channel.id),
          purged_count: 0,
          message: 'No matching messages found to purge.'
        };
      }

      const deleted = await channel.bulkDelete(messagesToDelete, true);
      return {
        channel_id: String(channel.id),
        purged_count: deleted.size
      };
    }, `Purge messages in channel ${channel_id}`);

    auditLog({ tool: 'purge_messages', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'purge_messages', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function pinMessageOp(args) {
  const { channel_id, message_id, pinned = true } = args;

  if (dryRunMode) {
    const result = { dryRun: true, channel_id, message_id, pinned };
    auditLog({ tool: 'pin_message', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedChannelId = await resolveChannelId(guild, channel_id);
      const channel = await guild.channels.fetch(resolvedChannelId).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        throw new Error(`Channel "${channel_id}" was not found or is not text-based.`);
      }

      const msg = await channel.messages.fetch(message_id).catch(() => null);
      if (!msg) {
        throw new Error(`Message with ID "${message_id}" was not found in channel ${channel_id}.`);
      }

      if (pinned) {
        await msg.pin();
      } else {
        await msg.unpin();
      }

      return {
        channel_id: String(channel.id),
        message_id: String(msg.id),
        pinned
      };
    }, `${pinned ? 'Pin' : 'Unpin'} message ${message_id} in channel ${channel_id}`);

    auditLog({ tool: 'pin_message', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'pin_message', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

// -------------------------------------------------------------
// Emojis & Stickers Operations
// -------------------------------------------------------------

export async function listEmojisOp() {
  if (dryRunMode) {
    const result = {
      dryRun: true,
      emojis: [
        { id: '100000000000000020', name: 'wave', animated: false, url: 'https://cdn.discordapp.com/emojis/100000000000000020.png', roles: [] }
      ],
      count: 1
    };
    auditLog({ tool: 'list_emojis', args: {}, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const emojis = await guild.emojis.fetch();
      const emojiList = emojis.map((e) => ({
        id: String(e.id),
        name: e.name,
        animated: e.animated,
        roles: Array.from(e.roles.cache.keys()).map(String),
        url: e.imageURL()
      }));

      return {
        emojis: emojiList,
        count: emojiList.length
      };
    }, 'List custom emojis');

    auditLog({ tool: 'list_emojis', args: {}, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'list_emojis', args: {}, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function createEmojiOp(args) {
  const { name, image, roles = [], reason } = args;

  if (dryRunMode) {
    const result = {
      dryRun: true,
      id: nextFakeSnowflake(),
      name,
      roles,
      reason
    };
    auditLog({ tool: 'create_emoji', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedRoleIds = [];
      for (const r of roles) {
        resolvedRoleIds.push(await resolveRoleId(guild, r));
      }

      const emoji = await guild.emojis.create({
        attachment: image,
        name,
        roles: resolvedRoleIds.length > 0 ? resolvedRoleIds : undefined,
        reason: reason || undefined
      });

      return {
        id: String(emoji.id),
        name: emoji.name,
        animated: emoji.animated,
        url: emoji.imageURL()
      };
    }, `Create emoji "${name}"`);

    auditLog({ tool: 'create_emoji', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'create_emoji', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function editEmojiOp(args) {
  const { emoji_id, name, roles, reason } = args;

  if (dryRunMode) {
    const result = { dryRun: true, emoji_id, name, roles, reason };
    auditLog({ tool: 'edit_emoji', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedEmojiId = await resolveEmojiId(guild, emoji_id);
      const emoji = await guild.emojis.fetch(resolvedEmojiId).catch(() => null);
      if (!emoji) {
        throw new Error(`Emoji with ID or name "${emoji_id}" was not found.`);
      }

      const editData = {};
      if (name !== undefined) editData.name = name;
      if (roles !== undefined) {
        const resolvedRoleIds = [];
        for (const r of roles) {
          resolvedRoleIds.push(await resolveRoleId(guild, r));
        }
        editData.roles = resolvedRoleIds;
      }
      if (reason) editData.reason = reason;

      const updated = await emoji.edit(editData);
      return {
        id: String(updated.id),
        name: updated.name,
        roles: Array.from(updated.roles.cache.keys()).map(String)
      };
    }, `Edit emoji ${emoji_id}`);

    auditLog({ tool: 'edit_emoji', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'edit_emoji', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function deleteEmojiOp(args) {
  const { emoji_id, reason } = args;

  if (dryRunMode) {
    const result = { dryRun: true, emoji_id, deleted: true, reason };
    auditLog({ tool: 'delete_emoji', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedEmojiId = await resolveEmojiId(guild, emoji_id);
      const emoji = await guild.emojis.fetch(resolvedEmojiId).catch(() => null);
      if (!emoji) {
        throw new Error(`Emoji with ID or name "${emoji_id}" was not found.`);
      }

      const name = emoji.name;
      await emoji.delete(reason || undefined);
      return {
        id: resolvedEmojiId,
        name,
        deleted: true
      };
    }, `Delete emoji ${emoji_id}`);

    auditLog({ tool: 'delete_emoji', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'delete_emoji', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function listStickersOp() {
  if (dryRunMode) {
    const result = {
      dryRun: true,
      stickers: [
        { id: '100000000000000030', name: 'ThumbsUp', tags: '👍', description: 'Nice job sticker', url: 'https://media.discordapp.net/stickers/100000000000000030.png' }
      ],
      count: 1
    };
    auditLog({ tool: 'list_stickers', args: {}, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const stickers = await guild.stickers.fetch();
      const stickerList = stickers.map((s) => ({
        id: String(s.id),
        name: s.name,
        description: s.description || null,
        tags: s.tags,
        format: s.format,
        url: s.url
      }));

      return {
        stickers: stickerList,
        count: stickerList.length
      };
    }, 'List custom stickers');

    auditLog({ tool: 'list_stickers', args: {}, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'list_stickers', args: {}, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function createStickerOp(args) {
  const { name, file, tags, description, reason } = args;

  if (dryRunMode) {
    const result = {
      dryRun: true,
      id: nextFakeSnowflake(),
      name,
      tags,
      description,
      reason
    };
    auditLog({ tool: 'create_sticker', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const sticker = await guild.stickers.create({
        file,
        name,
        tags,
        description: description || undefined,
        reason: reason || undefined
      });

      return {
        id: String(sticker.id),
        name: sticker.name,
        tags: sticker.tags,
        description: sticker.description,
        url: sticker.url
      };
    }, `Create sticker "${name}"`);

    auditLog({ tool: 'create_sticker', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'create_sticker', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function editStickerOp(args) {
  const { sticker_id, name, description, tags, reason } = args;

  if (dryRunMode) {
    const result = { dryRun: true, sticker_id, name, description, tags, reason };
    auditLog({ tool: 'edit_sticker', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedStickerId = await resolveStickerId(guild, sticker_id);
      const sticker = await guild.stickers.fetch(resolvedStickerId).catch(() => null);
      if (!sticker) {
        throw new Error(`Sticker with ID or name "${sticker_id}" was not found.`);
      }

      const editData = {};
      if (name !== undefined) editData.name = name;
      if (description !== undefined) editData.description = description;
      if (tags !== undefined) editData.tags = tags;
      if (reason) editData.reason = reason;

      const updated = await sticker.edit(editData);
      return {
        id: String(updated.id),
        name: updated.name,
        description: updated.description,
        tags: updated.tags
      };
    }, `Edit sticker ${sticker_id}`);

    auditLog({ tool: 'edit_sticker', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'edit_sticker', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function deleteStickerOp(args) {
  const { sticker_id, reason } = args;

  if (dryRunMode) {
    const result = { dryRun: true, sticker_id, deleted: true, reason };
    auditLog({ tool: 'delete_sticker', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedStickerId = await resolveStickerId(guild, sticker_id);
      const sticker = await guild.stickers.fetch(resolvedStickerId).catch(() => null);
      if (!sticker) {
        throw new Error(`Sticker with ID or name "${sticker_id}" was not found.`);
      }

      const name = sticker.name;
      await sticker.delete(reason || undefined);
      return {
        id: resolvedStickerId,
        name,
        deleted: true
      };
    }, `Delete sticker ${sticker_id}`);

    auditLog({ tool: 'delete_sticker', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'delete_sticker', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

// -------------------------------------------------------------
// Soundboard Operations
// -------------------------------------------------------------

export async function listSoundboardSoundsOp() {
  if (dryRunMode) {
    const result = {
      dryRun: true,
      sounds: [
        { id: '100000000000000040', name: 'applause', volume: 0.8, emoji_name: '👏', emoji_id: null, sound_url: 'https://cdn.discordapp.com/soundboard-sounds/100000000000000040' }
      ],
      count: 1
    };
    auditLog({ tool: 'list_soundboard_sounds', args: {}, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      if (!guild.soundboardSounds) {
        return { sounds: [], count: 0 };
      }
      const sounds = await guild.soundboardSounds.fetch();
      const soundList = sounds.map((s) => ({
        id: String(s.id),
        name: s.name,
        volume: s.volume,
        emoji_name: s.emojiName || null,
        emoji_id: s.emojiId ? String(s.emojiId) : null,
        sound_url: s.soundURL
      }));

      return {
        sounds: soundList,
        count: soundList.length
      };
    }, 'List soundboard sounds');

    auditLog({ tool: 'list_soundboard_sounds', args: {}, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'list_soundboard_sounds', args: {}, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function createSoundboardSoundOp(args) {
  const { name, sound, volume, emoji_name, emoji_id, reason } = args;

  if (dryRunMode) {
    const result = {
      dryRun: true,
      id: nextFakeSnowflake(),
      name,
      volume: volume ?? 1.0,
      emoji_name,
      emoji_id,
      reason
    };
    auditLog({ tool: 'create_soundboard_sound', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      if (!guild.soundboardSounds) {
        throw new Error('Soundboard is not supported or accessible on this Discord client version.');
      }

      const created = await guild.soundboardSounds.create({
        sound,
        name,
        volume: volume !== undefined ? volume : undefined,
        emojiName: emoji_name || undefined,
        emojiId: emoji_id || undefined,
        reason: reason || undefined
      });

      return {
        id: String(created.id),
        name: created.name,
        volume: created.volume,
        sound_url: created.soundURL
      };
    }, `Create soundboard sound "${name}"`);

    auditLog({ tool: 'create_soundboard_sound', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'create_soundboard_sound', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function editSoundboardSoundOp(args) {
  const { sound_id, name, volume, emoji_name, emoji_id, reason } = args;

  if (dryRunMode) {
    const result = { dryRun: true, sound_id, name, volume, emoji_name, emoji_id, reason };
    auditLog({ tool: 'edit_soundboard_sound', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      if (!guild.soundboardSounds) {
        throw new Error('Soundboard is not supported on this Discord client version.');
      }

      const resolvedSoundId = await resolveSoundboardSoundId(guild, sound_id);
      const snd = await guild.soundboardSounds.fetch(resolvedSoundId).catch(() => null);
      if (!snd) {
        throw new Error(`Soundboard sound "${sound_id}" was not found.`);
      }

      const editData = {};
      if (name !== undefined) editData.name = name;
      if (volume !== undefined) editData.volume = volume;
      if (emoji_name !== undefined) editData.emojiName = emoji_name;
      if (emoji_id !== undefined) editData.emojiId = emoji_id;
      if (reason) editData.reason = reason;

      const updated = await snd.edit(editData);
      return {
        id: String(updated.id),
        name: updated.name,
        volume: updated.volume
      };
    }, `Edit soundboard sound ${sound_id}`);

    auditLog({ tool: 'edit_soundboard_sound', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'edit_soundboard_sound', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function deleteSoundboardSoundOp(args) {
  const { sound_id, reason } = args;

  if (dryRunMode) {
    const result = { dryRun: true, sound_id, deleted: true, reason };
    auditLog({ tool: 'delete_soundboard_sound', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      if (!guild.soundboardSounds) {
        throw new Error('Soundboard is not supported on this Discord client version.');
      }

      const resolvedSoundId = await resolveSoundboardSoundId(guild, sound_id);
      const snd = await guild.soundboardSounds.fetch(resolvedSoundId).catch(() => null);
      if (!snd) {
        throw new Error(`Soundboard sound "${sound_id}" was not found.`);
      }

      const name = snd.name;
      await snd.delete(reason || undefined);
      return {
        id: resolvedSoundId,
        name,
        deleted: true
      };
    }, `Delete soundboard sound ${sound_id}`);

    auditLog({ tool: 'delete_soundboard_sound', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'delete_soundboard_sound', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

// -------------------------------------------------------------
// Auto-Moderation Operations
// -------------------------------------------------------------

function mapAutoModTriggerType(typeStr) {
  switch (typeStr) {
    case 'keyword':
    case 'harmful_link':
      return AutoModerationRuleTriggerType.Keyword;
    case 'spam':
      return AutoModerationRuleTriggerType.Spam;
    case 'keyword_preset':
      return AutoModerationRuleTriggerType.KeywordPreset;
    case 'mention_spam':
      return AutoModerationRuleTriggerType.MentionSpam;
    default:
      return AutoModerationRuleTriggerType.Keyword;
  }
}

function mapAutoModActions(actions = []) {
  return actions.map((act) => {
    switch (act.type) {
      case 'block_message':
        return { type: AutoModerationActionType.BlockMessage };
      case 'send_alert_message':
        return {
          type: AutoModerationActionType.SendAlertMessage,
          metadata: { channel: act.channel_id }
        };
      case 'timeout':
        return {
          type: AutoModerationActionType.Timeout,
          metadata: { durationSeconds: act.duration_seconds || 300 }
        };
      default:
        return { type: AutoModerationActionType.BlockMessage };
    }
  });
}

export async function listAutomodRulesOp() {
  if (dryRunMode) {
    const result = {
      dryRun: true,
      rules: [
        {
          id: '100000000000000050',
          name: 'Block Profanity & Phishing',
          enabled: true,
          triggerType: 1,
          triggerMetadata: { keywordFilter: ['*scam*', '*phish*'], regexPatterns: [] },
          actions: [{ type: 1 }]
        }
      ],
      count: 1
    };
    auditLog({ tool: 'list_automod_rules', args: {}, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      if (!guild.autoModerationRules) {
        return { rules: [], count: 0 };
      }
      const rules = await guild.autoModerationRules.fetch();
      const ruleList = rules.map((r) => ({
        id: String(r.id),
        name: r.name,
        enabled: r.enabled,
        eventType: r.eventType,
        triggerType: r.triggerType,
        triggerMetadata: r.triggerMetadata,
        actions: r.actions,
        exemptRoles: Array.from(r.exemptRoles.keys()).map(String),
        exemptChannels: Array.from(r.exemptChannels.keys()).map(String)
      }));

      return {
        rules: ruleList,
        count: ruleList.length
      };
    }, 'List auto-moderation rules');

    auditLog({ tool: 'list_automod_rules', args: {}, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'list_automod_rules', args: {}, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function createAutomodRuleOp(args) {
  const {
    name,
    trigger_type = 'keyword',
    keyword_filter = [],
    regex_patterns = [],
    presets = [],
    mention_total_limit,
    actions = [{ type: 'block_message' }],
    enabled = true,
    exempt_roles = [],
    exempt_channels = [],
    reason
  } = args;

  if (dryRunMode) {
    const result = {
      dryRun: true,
      id: nextFakeSnowflake(),
      name,
      trigger_type,
      enabled,
      keyword_filter,
      actions
    };
    auditLog({ tool: 'create_automod_rule', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      if (!guild.autoModerationRules) {
        throw new Error('Auto-moderation is not accessible on this Discord client.');
      }

      const discordTriggerType = mapAutoModTriggerType(trigger_type);
      const discordActions = mapAutoModActions(actions);

      const triggerMetadata = {};
      if (keyword_filter.length > 0) triggerMetadata.keywordFilter = keyword_filter;
      if (regex_patterns.length > 0) triggerMetadata.regexPatterns = regex_patterns;
      if (presets.length > 0) triggerMetadata.presets = presets;
      if (mention_total_limit) triggerMetadata.mentionTotalLimit = mention_total_limit;

      const exemptRoleIds = [];
      for (const r of exempt_roles) {
        exemptRoleIds.push(await resolveRoleId(guild, r));
      }

      const exemptChannelIds = [];
      for (const c of exempt_channels) {
        exemptChannelIds.push(await resolveChannelId(guild, c));
      }

      const rule = await guild.autoModerationRules.create({
        name,
        eventType: AutoModerationRuleEventType.MessageSend,
        triggerType: discordTriggerType,
        triggerMetadata,
        actions: discordActions,
        enabled,
        exemptRoles: exemptRoleIds.length > 0 ? exemptRoleIds : undefined,
        exemptChannels: exemptChannelIds.length > 0 ? exemptChannelIds : undefined,
        reason: reason || undefined
      });

      return {
        id: String(rule.id),
        name: rule.name,
        enabled: rule.enabled,
        triggerType: rule.triggerType
      };
    }, `Create auto-moderation rule "${name}"`);

    auditLog({ tool: 'create_automod_rule', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'create_automod_rule', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function editAutomodRuleOp(args) {
  const { rule_id, name, enabled, keyword_filter, regex_patterns, actions, exempt_roles, exempt_channels, reason } = args;

  if (dryRunMode) {
    const result = { dryRun: true, rule_id, name, enabled, keyword_filter, reason };
    auditLog({ tool: 'edit_automod_rule', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      if (!guild.autoModerationRules) {
        throw new Error('Auto-moderation is not accessible on this Discord client.');
      }

      const resolvedRuleId = await resolveAutomodRuleId(guild, rule_id);
      const rule = await guild.autoModerationRules.fetch(resolvedRuleId).catch(() => null);
      if (!rule) {
        throw new Error(`Auto-moderation rule "${rule_id}" was not found.`);
      }

      const editData = {};
      if (name !== undefined) editData.name = name;
      if (enabled !== undefined) editData.enabled = enabled;
      if (actions !== undefined) editData.actions = mapAutoModActions(actions);
      if (keyword_filter !== undefined || regex_patterns !== undefined) {
        editData.triggerMetadata = {
          ...rule.triggerMetadata,
          ...(keyword_filter !== undefined ? { keywordFilter: keyword_filter } : {}),
          ...(regex_patterns !== undefined ? { regexPatterns: regex_patterns } : {})
        };
      }
      if (exempt_roles !== undefined) {
        const roleIds = [];
        for (const r of exempt_roles) {
          roleIds.push(await resolveRoleId(guild, r));
        }
        editData.exemptRoles = roleIds;
      }
      if (exempt_channels !== undefined) {
        const channelIds = [];
        for (const c of exempt_channels) {
          channelIds.push(await resolveChannelId(guild, c));
        }
        editData.exemptChannels = channelIds;
      }
      if (reason) editData.reason = reason;

      const updated = await rule.edit(editData);
      return {
        id: String(updated.id),
        name: updated.name,
        enabled: updated.enabled
      };
    }, `Edit auto-moderation rule ${rule_id}`);

    auditLog({ tool: 'edit_automod_rule', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'edit_automod_rule', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function deleteAutomodRuleOp(args) {
  const { rule_id, reason } = args;

  if (dryRunMode) {
    const result = { dryRun: true, rule_id, deleted: true, reason };
    auditLog({ tool: 'delete_automod_rule', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      if (!guild.autoModerationRules) {
        throw new Error('Auto-moderation is not accessible on this Discord client.');
      }

      const resolvedRuleId = await resolveAutomodRuleId(guild, rule_id);
      const rule = await guild.autoModerationRules.fetch(resolvedRuleId).catch(() => null);
      if (!rule) {
        throw new Error(`Auto-moderation rule "${rule_id}" was not found.`);
      }

      const name = rule.name;
      await rule.delete(reason || undefined);
      return {
        id: resolvedRuleId,
        name,
        deleted: true
      };
    }, `Delete auto-moderation rule ${rule_id}`);

    auditLog({ tool: 'delete_automod_rule', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'delete_automod_rule', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

// -------------------------------------------------------------
// Webhooks & Integrations Operations
// -------------------------------------------------------------

export async function listWebhooksOp(args = {}) {
  const { channel_id } = args;

  if (dryRunMode) {
    const result = {
      dryRun: true,
      webhooks: [
        { id: '100000000000000060', name: 'Server Announcements Webhook', channelId: channel_id || '100000000000000002', url: 'https://discord.com/api/webhooks/100000000000000060/token' }
      ],
      count: 1
    };
    auditLog({ tool: 'list_webhooks', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      let webhooksCollection;

      if (channel_id) {
        const resolvedChannelId = await resolveChannelId(guild, channel_id);
        const channel = await guild.channels.fetch(resolvedChannelId).catch(() => null);
        if (!channel || !channel.fetchWebhooks) {
          throw new Error(`Channel "${channel_id}" was not found or does not support webhooks.`);
        }
        webhooksCollection = await channel.fetchWebhooks();
      } else {
        webhooksCollection = await guild.fetchWebhooks();
      }

      const webhookList = webhooksCollection.map((w) => ({
        id: String(w.id),
        name: w.name,
        channelId: String(w.channelId),
        avatar: w.avatarURL(),
        url: w.url
      }));

      return {
        webhooks: webhookList,
        count: webhookList.length
      };
    }, 'List webhooks');

    auditLog({ tool: 'list_webhooks', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'list_webhooks', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function createWebhookOp(args) {
  const { channel_id, name, avatar, reason } = args;

  if (dryRunMode) {
    const result = {
      dryRun: true,
      id: nextFakeSnowflake(),
      name,
      channel_id,
      url: `https://discord.com/api/webhooks/${nextFakeSnowflake()}/fake_token`,
      reason
    };
    auditLog({ tool: 'create_webhook', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedChannelId = await resolveChannelId(guild, channel_id);
      const channel = await guild.channels.fetch(resolvedChannelId).catch(() => null);
      if (!channel || !channel.createWebhook) {
        throw new Error(`Channel "${channel_id}" was not found or cannot host webhooks.`);
      }

      const webhook = await channel.createWebhook({
        name,
        avatar: avatar || undefined,
        reason: reason || undefined
      });

      return {
        id: String(webhook.id),
        name: webhook.name,
        channel_id: String(webhook.channelId),
        url: webhook.url
      };
    }, `Create webhook "${name}" on channel ${channel_id}`);

    auditLog({ tool: 'create_webhook', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'create_webhook', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function editWebhookOp(args) {
  const { webhook_id, name, avatar, channel_id, reason } = args;

  if (dryRunMode) {
    const result = { dryRun: true, webhook_id, name, channel_id, reason };
    auditLog({ tool: 'edit_webhook', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedWebhookId = await resolveWebhookId(guild, webhook_id);
      const webhooks = await guild.fetchWebhooks();
      const webhook = webhooks.get(resolvedWebhookId);
      if (!webhook) {
        throw new Error(`Webhook "${webhook_id}" was not found.`);
      }

      const editData = {};
      if (name !== undefined) editData.name = name;
      if (avatar !== undefined) editData.avatar = avatar;
      if (channel_id !== undefined) editData.channel = await resolveChannelId(guild, channel_id);
      if (reason) editData.reason = reason;

      const updated = await webhook.edit(editData);
      return {
        id: String(updated.id),
        name: updated.name,
        channel_id: String(updated.channelId)
      };
    }, `Edit webhook ${webhook_id}`);

    auditLog({ tool: 'edit_webhook', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'edit_webhook', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function deleteWebhookOp(args) {
  const { webhook_id, reason } = args;

  if (dryRunMode) {
    const result = { dryRun: true, webhook_id, deleted: true, reason };
    auditLog({ tool: 'delete_webhook', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedWebhookId = await resolveWebhookId(guild, webhook_id);
      const webhooks = await guild.fetchWebhooks();
      const webhook = webhooks.get(resolvedWebhookId);
      if (!webhook) {
        throw new Error(`Webhook "${webhook_id}" was not found.`);
      }

      const name = webhook.name;
      await webhook.delete(reason || undefined);
      return {
        id: resolvedWebhookId,
        name,
        deleted: true
      };
    }, `Delete webhook ${webhook_id}`);

    auditLog({ tool: 'delete_webhook', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'delete_webhook', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function sendWebhookMessageOp(args) {
  const { webhook_id, content, username, avatar_url } = args;

  if (dryRunMode) {
    const result = {
      dryRun: true,
      webhook_id,
      contentPreview: content.slice(0, 100),
      username,
      sent: true
    };
    auditLog({ tool: 'send_webhook_message', args, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const resolvedWebhookId = await resolveWebhookId(guild, webhook_id);
      const webhooks = await guild.fetchWebhooks();
      const webhook = webhooks.get(resolvedWebhookId);
      if (!webhook) {
        throw new Error(`Webhook "${webhook_id}" was not found.`);
      }

      const msg = await webhook.send({
        content,
        username: username || undefined,
        avatarURL: avatar_url || undefined
      });

      return {
        message_id: String(msg.id),
        webhook_id: resolvedWebhookId,
        sent: true
      };
    }, `Send webhook message via ${webhook_id}`);

    auditLog({ tool: 'send_webhook_message', args, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'send_webhook_message', args, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}

export async function listIntegrationsOp() {
  if (dryRunMode) {
    const result = {
      dryRun: true,
      integrations: [
        { id: '100000000000000070', name: 'Discord Architect Bot', type: 'discord', enabled: true, syncing: false }
      ],
      count: 1
    };
    auditLog({ tool: 'list_integrations', args: {}, ok: true, result, dryRun: true });
    return result;
  }

  try {
    const result = await opQueue.enqueue(async () => {
      const guild = await getGuild();
      const integrations = await guild.fetchIntegrations();
      const list = integrations.map((ig) => ({
        id: String(ig.id),
        name: ig.name,
        type: ig.type,
        enabled: ig.enabled,
        syncing: ig.syncing,
        user: ig.user ? { id: String(ig.user.id), username: ig.user.username, bot: ig.user.bot } : null
      }));

      return {
        integrations: list,
        count: list.length
      };
    }, 'List guild integrations');

    auditLog({ tool: 'list_integrations', args: {}, ok: true, result, dryRun: false });
    return result;
  } catch (err) {
    auditLog({ tool: 'list_integrations', args: {}, ok: false, error: err.message, dryRun: false });
    throw err;
  }
}
