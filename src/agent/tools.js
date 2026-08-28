import { z } from 'zod';
import { getSnapshot } from '../discord/snapshot.js';
import { getGuild } from '../discord/client.js';
import { bitfieldToKeyNames, WHITELISTED_PERMISSIONS } from '../discord/permissions.js';
import {
  createCategoryOp,
  createChannelOp,
  editChannelOp,
  deleteChannelOp,
  moveChannelOp,
  reorderChannelsOp,
  createRoleOp,
  editRoleOp,
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
} from '../discord/ops.js';

// Flexible snowflake or identifier schema (allows numeric snowflakes or name lookups)
export const identifierSchema = z.string().min(1).max(100);

const permissionNameSchema = z.enum(WHITELISTED_PERMISSIONS);
const hexColorSchema = z.string().regex(/^#([A-Fa-f0-9]{6})$/, 'Color must be a 6-digit hex string like #FF5733');

/**
 * Tool registry holding all tool definitions.
 */
export const toolsRegistry = new Map();

function registerTool(toolDef) {
  toolsRegistry.set(toolDef.name, toolDef);
}

// -------------------------------------------------------------
// Tool: get_guild_snapshot (Read)
// -------------------------------------------------------------
registerTool({
  name: 'get_guild_snapshot',
  description: 'Retrieve a compact, token-efficient snapshot of the entire guild structure, including roles, categories, channels, and non-default permission overwrites. Call this first before planning or modifying anything.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  schema: z.object({}).passthrough(),
  handler: async () => {
    try {
      const snapshot = await getSnapshot();
      return { ok: true, result: snapshot };
    } catch (err) {
      return { ok: false, error: `Failed to get guild snapshot: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: list_roles (Read)
// -------------------------------------------------------------
registerTool({
  name: 'list_roles',
  description: 'Get an updated list of all server roles with their IDs, names, positions, colors, and key permissions.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  schema: z.object({}).passthrough(),
  handler: async () => {
    try {
      const guild = await getGuild();
      const rolesCache = await guild.roles.fetch();
      const roles = rolesCache
        .map((r) => ({
          id: String(r.id),
          name: r.name,
          position: r.position,
          color: r.hexColor,
          hoist: r.hoist,
          keyPerms: bitfieldToKeyNames(r.permissions)
        }))
        .sort((a, b) => b.position - a.position);
      return { ok: true, result: { roles } };
    } catch (err) {
      return { ok: false, error: `Failed to list roles: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: create_category
// -------------------------------------------------------------
registerTool({
  name: 'create_category',
  description: 'Create a new channel category. Can optionally be made private with initial role access.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Category name (1-100 chars)' },
      position: { type: 'integer', description: 'Sorting position (0 is highest at top)' },
      private: { type: 'boolean', description: 'If true, denies ViewChannel for @everyone' },
      visible_to_role_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of role ID strings (or role names) allowed to view if private is true'
      }
    },
    required: ['name'],
    additionalProperties: false
  },
  schema: z.object({
    name: z.string().min(1).max(100),
    position: z.number().int().min(0).optional(),
    private: z.boolean().optional(),
    visible_to_role_ids: z.array(identifierSchema).optional()
  }),
  handler: async (args) => {
    try {
      const res = await createCategoryOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to create category "${args.name}": ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: create_channel
// -------------------------------------------------------------
registerTool({
  name: 'create_channel',
  description: 'Create a new text, voice, announcement, forum, or stage channel. Announcement/forum/stage channels require the Community feature.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Channel name (1-100 chars, e.g. "general" or "voice-chat")' },
      type: {
        type: 'string',
        enum: ['text', 'voice', 'announcement', 'forum', 'stage'],
        description: 'Type of channel'
      },
      parent_id: { type: 'string', description: 'ID or name of the category to place this channel in' },
      topic: { type: 'string', description: 'Channel topic/description (max 1024 chars)' },
      slowmode_seconds: { type: 'integer', description: 'Slowmode delay per user in seconds (0-21600)' },
      nsfw: { type: 'boolean', description: 'Whether the channel is age-restricted (NSFW)' },
      position: { type: 'integer', description: 'Sorting position within category/server' }
    },
    required: ['name', 'type'],
    additionalProperties: false
  },
  schema: z.object({
    name: z.string().min(1).max(100),
    type: z.enum(['text', 'voice', 'announcement', 'forum', 'stage']),
    parent_id: identifierSchema.optional(),
    topic: z.string().max(1024).optional(),
    slowmode_seconds: z.number().int().min(0).max(21600).optional(),
    nsfw: z.boolean().optional(),
    position: z.number().int().min(0).optional()
  }),
  handler: async (args) => {
    try {
      const res = await createChannelOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to create channel "${args.name}": ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: edit_channel
// -------------------------------------------------------------
registerTool({
  name: 'edit_channel',
  description: 'Edit properties of an existing channel (name, topic, slowmode, nsfw).',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'ID or name of the channel to edit' },
      name: { type: 'string', description: 'New channel name (1-100 chars)' },
      topic: { type: 'string', description: 'New topic (max 1024 chars)' },
      slowmode_seconds: { type: 'integer', description: 'Slowmode in seconds (0-21600)' },
      nsfw: { type: 'boolean', description: 'Age-restricted flag' }
    },
    required: ['channel_id'],
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema,
    name: z.string().min(1).max(100).optional(),
    topic: z.string().max(1024).optional(),
    slowmode_seconds: z.number().int().min(0).max(21600).optional(),
    nsfw: z.boolean().optional()
  }),
  handler: async (args) => {
    try {
      const res = await editChannelOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to edit channel ${args.channel_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: delete_channel (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'delete_channel',
  description: 'Permanently delete a channel or category. DESTRUCTIVE: requires user approval when dry-run is off.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'ID of the channel or category to delete' }
    },
    required: ['channel_id'],
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema
  }),
  handler: async (args) => {
    try {
      const res = await deleteChannelOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to delete channel ${args.channel_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: move_channel
// -------------------------------------------------------------
registerTool({
  name: 'move_channel',
  description: 'Move a channel into a category (or uncategorized) and set its position.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'ID of the channel to move' },
      parent_id: {
        type: 'string',
        description: 'ID or name of the destination category (empty or omit to make uncategorized)'
      },
      position: { type: 'integer', description: 'Target position within category or server' }
    },
    required: ['channel_id', 'position'],
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema,
    parent_id: identifierSchema.nullable().optional(),
    position: z.number().int().min(0)
  }),
  handler: async (args) => {
    try {
      const res = await moveChannelOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to move channel ${args.channel_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: reorder_channels
// -------------------------------------------------------------
registerTool({
  name: 'reorder_channels',
  description: 'Reorder multiple channels at once within a category or at the root level.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      parent_id: {
        type: 'string',
        description: 'Category ID (empty or omit for uncategorized root channels)'
      },
      ordered_channel_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of channel IDs in desired order from top to bottom'
      }
    },
    required: ['ordered_channel_ids'],
    additionalProperties: false
  },
  schema: z.object({
    parent_id: identifierSchema.nullable().optional(),
    ordered_channel_ids: z.array(identifierSchema).min(1)
  }),
  handler: async (args) => {
    try {
      const res = await reorderChannelsOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to reorder channels: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: create_role
// -------------------------------------------------------------
registerTool({
  name: 'create_role',
  description: 'Create a new server role with optional color, hoist, mentionable status, and whitelisted permissions.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Role name (1-100 chars)' },
      color: { type: 'string', description: 'Hex color string (e.g. "#FF5733")' },
      hoist: { type: 'boolean', description: 'Whether role is displayed separately in the member list' },
      mentionable: { type: 'boolean', description: 'Whether anyone can @mention this role' },
      permissions: {
        type: 'array',
        items: {
          type: 'string',
          enum: WHITELISTED_PERMISSIONS
        },
        description: 'Array of whitelisted permission name strings'
      }
    },
    required: ['name'],
    additionalProperties: false
  },
  schema: z.object({
    name: z.string().min(1).max(100),
    color: hexColorSchema.optional(),
    hoist: z.boolean().optional(),
    mentionable: z.boolean().optional(),
    permissions: z.array(permissionNameSchema).optional()
  }),
  handler: async (args) => {
    try {
      const res = await createRoleOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to create role "${args.name}": ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: edit_role
// -------------------------------------------------------------
registerTool({
  name: 'edit_role',
  description: 'Edit properties and permissions of an existing role. Cannot edit roles higher than bot highest role.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      role_id: { type: 'string', description: 'ID or name of the role to edit' },
      name: { type: 'string', description: 'New role name (cannot rename @everyone)' },
      color: { type: 'string', description: 'Hex color string (e.g. "#5865F2")' },
      hoist: { type: 'boolean', description: 'Hoist in member sidebar' },
      mentionable: { type: 'boolean', description: 'Mentionable by all members' },
      permissions: {
        type: 'array',
        items: {
          type: 'string',
          enum: WHITELISTED_PERMISSIONS
        },
        description: 'Array of whitelisted permission names'
      }
    },
    required: ['role_id'],
    additionalProperties: false
  },
  schema: z.object({
    role_id: identifierSchema,
    name: z.string().min(1).max(100).optional(),
    color: hexColorSchema.optional(),
    hoist: z.boolean().optional(),
    mentionable: z.boolean().optional(),
    permissions: z.array(permissionNameSchema).optional()
  }),
  handler: async (args) => {
    try {
      const res = await editRoleOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to edit role ${args.role_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: delete_role (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'delete_role',
  description: 'Permanently delete a role. DESTRUCTIVE: requires user approval when dry-run is off.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      role_id: { type: 'string', description: 'ID or name of the role to delete' }
    },
    required: ['role_id'],
    additionalProperties: false
  },
  schema: z.object({
    role_id: identifierSchema
  }),
  handler: async (args) => {
    try {
      const res = await deleteRoleOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to delete role ${args.role_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: set_channel_permissions
// -------------------------------------------------------------
registerTool({
  name: 'set_channel_permissions',
  description: 'Set explicit permission overwrites on a channel or category for a specific role or member. Prefer setting on categories so channels inherit.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'ID or name of the channel or category' },
      target_id: { type: 'string', description: 'ID or name of the target role or member (for @everyone, use guild ID or "@everyone")' },
      target_type: { type: 'string', enum: ['role', 'member'], description: 'Whether target is a role or member' },
      allow: {
        type: 'array',
        items: { type: 'string', enum: WHITELISTED_PERMISSIONS },
        description: 'Array of whitelisted permissions to explicitly ALLOW'
      },
      deny: {
        type: 'array',
        items: { type: 'string', enum: WHITELISTED_PERMISSIONS },
        description: 'Array of whitelisted permissions to explicitly DENY'
      }
    },
    required: ['channel_id', 'target_id', 'target_type'],
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema,
    target_id: identifierSchema,
    target_type: z.enum(['role', 'member']),
    allow: z.array(permissionNameSchema).optional(),
    deny: z.array(permissionNameSchema).optional()
  }),
  handler: async (args) => {
    try {
      const res = await setChannelPermissionsOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to set permissions on ${args.channel_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: send_message
// -------------------------------------------------------------
registerTool({
  name: 'send_message',
  description: 'Send a message to a text channel, e.g. for server rules, welcome info, or category guides. Optionally pin the message.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'ID or name of the text channel' },
      content: { type: 'string', description: 'Message content (1-2000 chars)' },
      pin: { type: 'boolean', description: 'Whether to pin the message in the channel' }
    },
    required: ['channel_id', 'content'],
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema,
    content: z.string().min(1).max(2000),
    pin: z.boolean().optional()
  }),
  handler: async (args) => {
    try {
      const res = await sendMessageOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to send message to channel ${args.channel_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: edit_guild
// -------------------------------------------------------------
registerTool({
  name: 'edit_guild',
  description: 'Edit server name, visual assets (icon, banner, splash), description, vanity URL code, system channel, rules channel, AFK channel/timeout, verification level, or moderation settings.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'New guild name (2-100 chars)' },
      icon: { type: 'string', description: 'Server icon image (HTTPS URL or base64 data URI, or empty to remove)' },
      banner: { type: 'string', description: 'Server banner image (HTTPS URL or base64 data URI, or empty to remove)' },
      splash: { type: 'string', description: 'Server invite splash image (HTTPS URL or base64 data URI, or empty to remove)' },
      description: { type: 'string', description: 'Server description for discovery / community (max 120 chars)' },
      vanity_code: { type: 'string', description: 'Custom vanity invite URL code (if server has sufficient boost level)' },
      system_channel_id: { type: 'string', description: 'System message channel ID or name (where welcome/boost messages go)' },
      rules_channel_id: { type: 'string', description: 'Rules channel ID or name' },
      afk_channel_id: { type: 'string', description: 'AFK voice channel ID or name' },
      afk_timeout: { type: 'integer', description: 'AFK timeout in seconds (60, 300, 900, 1800, or 3600)' },
      verification_level: { type: 'integer', description: '0=None, 1=Low, 2=Medium, 3=High, 4=VeryHigh' },
      explicit_content_filter: { type: 'integer', description: '0=Disabled, 1=MembersWithoutRoles, 2=AllMembers' },
      default_message_notifications: { type: 'integer', description: '0=AllMessages, 1=OnlyMentions' }
    },
    additionalProperties: false
  },
  schema: z.object({
    name: z.string().min(2).max(100).optional(),
    icon: z.string().nullable().optional(),
    banner: z.string().nullable().optional(),
    splash: z.string().nullable().optional(),
    description: z.string().max(120).nullable().optional(),
    vanity_code: z.string().max(32).nullable().optional(),
    system_channel_id: identifierSchema.nullable().optional(),
    rules_channel_id: identifierSchema.nullable().optional(),
    afk_channel_id: identifierSchema.nullable().optional(),
    afk_timeout: z.number().int().optional(),
    verification_level: z.number().int().min(0).max(4).optional(),
    explicit_content_filter: z.number().int().min(0).max(2).optional(),
    default_message_notifications: z.number().int().min(0).max(1).optional()
  }),
  handler: async (args) => {
    try {
      const res = await editGuildOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to edit guild: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: batch_create_structure (All-in-one full server deployment)
// -------------------------------------------------------------
registerTool({
  name: 'batch_create_structure',
  description: 'Deploy an entire Discord server layout in a single high-efficiency command. Creates all specified roles, categories, and channels at once with proper permissions and relationships.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      roles: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Role name' },
            color: { type: 'string', description: 'Hex color string (e.g. #3498DB)' },
            hoist: { type: 'boolean' },
            mentionable: { type: 'boolean' },
            permissions: { type: 'array', items: { type: 'string' } }
          },
          required: ['name']
        },
        description: 'List of server roles to create'
      },
      categories: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Category name' },
            position: { type: 'integer' },
            private: { type: 'boolean', description: 'If true, hides from @everyone' },
            visible_to_roles: {
              type: 'array',
              items: { type: 'string' },
              description: 'Role names or IDs allowed to view if private'
            },
            channels: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  type: { type: 'string', enum: ['text', 'voice', 'announcement', 'forum', 'stage'] },
                  topic: { type: 'string' },
                  slowmode_seconds: { type: 'integer' },
                  nsfw: { type: 'boolean' },
                  position: { type: 'integer' }
                },
                required: ['name']
              },
              description: 'Channels to create under this category'
            }
          },
          required: ['name']
        },
        description: 'Categories to create with their nested channels'
      },
      uncategorized_channels: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: { type: 'string', enum: ['text', 'voice', 'announcement', 'forum', 'stage'] },
            topic: { type: 'string' }
          },
          required: ['name']
        },
        description: 'Uncategorized channels at root level'
      }
    },
    additionalProperties: false
  },
  schema: z.object({
    roles: z.array(z.object({
      name: z.string().min(1),
      color: z.string().optional(),
      hoist: z.boolean().optional(),
      mentionable: z.boolean().optional(),
      permissions: z.array(z.string()).optional()
    })).optional(),
    categories: z.array(z.object({
      name: z.string().min(1),
      position: z.number().int().optional(),
      private: z.boolean().optional(),
      visible_to_roles: z.array(z.string()).optional(),
      visible_to_role_ids: z.array(z.string()).optional(),
      channels: z.array(z.object({
        name: z.string().min(1),
        type: z.string().optional(),
        topic: z.string().optional(),
        slowmode_seconds: z.number().int().optional(),
        nsfw: z.boolean().optional(),
        position: z.number().int().optional()
      })).optional()
    })).optional(),
    uncategorized_channels: z.array(z.object({
      name: z.string().min(1),
      type: z.string().optional(),
      topic: z.string().optional()
    })).optional()
  }),
  handler: async (args, context) => {
    try {
      const res = await batchCreateStructureOp(args, context);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Batch creation failed: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: batch_edit_channels
// -------------------------------------------------------------
registerTool({
  name: 'batch_edit_channels',
  description: 'Edit properties (names, topics, slowmode, nsfw) of multiple channels at once in a single command.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channels: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            channel_id: { type: 'string', description: 'ID or current name of the channel' },
            name: { type: 'string', description: 'New channel name' },
            topic: { type: 'string', description: 'New channel topic' },
            slowmode_seconds: { type: 'integer' },
            nsfw: { type: 'boolean' }
          },
          required: ['channel_id']
        },
        description: 'Array of channel updates'
      }
    },
    required: ['channels'],
    additionalProperties: false
  },
  schema: z.object({
    channels: z.array(z.object({
      channel_id: identifierSchema,
      name: z.string().min(1).max(100).optional(),
      topic: z.string().max(1024).optional(),
      slowmode_seconds: z.number().int().min(0).max(21600).optional(),
      nsfw: z.boolean().optional()
    })).min(1)
  }),
  handler: async (args, context) => {
    try {
      const res = await batchEditChannelsOp(args, context);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Batch edit channels failed: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: batch_delete_channels (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'batch_delete_channels',
  description: 'Delete multiple channels or categories at once. DESTRUCTIVE: requires user approval when dry-run is off.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      channel_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of channel or category IDs (or names) to delete'
      }
    },
    required: ['channel_ids'],
    additionalProperties: false
  },
  schema: z.object({
    channel_ids: z.array(identifierSchema).min(1)
  }),
  handler: async (args, context) => {
    try {
      const res = await batchDeleteChannelsOp(args, context);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Batch delete channels failed: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: batch_move_channels
// -------------------------------------------------------------
registerTool({
  name: 'batch_move_channels',
  description: 'Move, reparent, and position multiple channels at once in a single command.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      moves: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            channel_id: { type: 'string', description: 'Channel ID or name to move' },
            parent_id: { type: 'string', description: 'Destination category ID/name (empty or omit for root)' },
            position: { type: 'integer', description: 'Position within parent/server' }
          },
          required: ['channel_id']
        },
        description: 'Array of move operations'
      }
    },
    required: ['moves'],
    additionalProperties: false
  },
  schema: z.object({
    moves: z.array(z.object({
      channel_id: identifierSchema,
      parent_id: identifierSchema.nullable().optional(),
      position: z.number().int().min(0).optional()
    })).min(1)
  }),
  handler: async (args, context) => {
    try {
      const res = await batchMoveChannelsOp(args, context);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Batch move channels failed: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: batch_edit_roles
// -------------------------------------------------------------
registerTool({
  name: 'batch_edit_roles',
  description: 'Edit properties (names, colors, hoist, mentionable, permissions) of multiple roles at once.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      roles: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            role_id: { type: 'string', description: 'Role ID or name' },
            name: { type: 'string' },
            color: { type: 'string' },
            hoist: { type: 'boolean' },
            mentionable: { type: 'boolean' },
            permissions: { type: 'array', items: { type: 'string' } }
          },
          required: ['role_id']
        },
        description: 'Array of role edits'
      }
    },
    required: ['roles'],
    additionalProperties: false
  },
  schema: z.object({
    roles: z.array(z.object({
      role_id: identifierSchema,
      name: z.string().min(1).max(100).optional(),
      color: hexColorSchema.optional(),
      hoist: z.boolean().optional(),
      mentionable: z.boolean().optional(),
      permissions: z.array(permissionNameSchema).optional()
    })).min(1)
  }),
  handler: async (args, context) => {
    try {
      const res = await batchEditRolesOp(args, context);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Batch edit roles failed: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: batch_delete_roles (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'batch_delete_roles',
  description: 'Delete multiple roles at once. DESTRUCTIVE: requires user approval when dry-run is off.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      role_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of role IDs (or names) to delete'
      }
    },
    required: ['role_ids'],
    additionalProperties: false
  },
  schema: z.object({
    role_ids: z.array(identifierSchema).min(1)
  }),
  handler: async (args, context) => {
    try {
      const res = await batchDeleteRolesOp(args, context);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Batch delete roles failed: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: batch_create_categories
// -------------------------------------------------------------
registerTool({
  name: 'batch_create_categories',
  description: 'Create multiple channel categories at once in a single command. Reduces token use and turn overhead.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      categories: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Category name (1-100 chars)' },
            position: { type: 'integer', description: 'Sorting position (0 is top)' },
            private: { type: 'boolean', description: 'If true, denies ViewChannel for @everyone' },
            visible_to_role_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'Role IDs or names allowed to view if private'
            }
          },
          required: ['name']
        },
        description: 'Array of categories to create'
      }
    },
    required: ['categories'],
    additionalProperties: false
  },
  schema: z.object({
    categories: z.array(z.object({
      name: z.string().min(1).max(100),
      position: z.number().int().min(0).optional(),
      private: z.boolean().optional(),
      visible_to_role_ids: z.array(identifierSchema).optional(),
      visible_to_roles: z.array(identifierSchema).optional()
    })).min(1)
  }),
  handler: async (args, context) => {
    try {
      const res = await batchCreateCategoriesOp(args, context);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Batch create categories failed: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: batch_create_channels
// -------------------------------------------------------------
registerTool({
  name: 'batch_create_channels',
  description: 'Create multiple channels at once in a single command. Reduces token use and turn overhead.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channels: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Channel name (1-100 chars)' },
            type: {
              type: 'string',
              enum: ['text', 'voice', 'announcement', 'forum', 'stage'],
              description: 'Channel type'
            },
            parent_id: { type: 'string', description: 'Category ID or category name' },
            topic: { type: 'string', description: 'Topic/description (max 1024 chars)' },
            slowmode_seconds: { type: 'integer', description: 'Slowmode delay in seconds (0-21600)' },
            nsfw: { type: 'boolean', description: 'Age-restricted flag' },
            position: { type: 'integer', description: 'Sorting position' }
          },
          required: ['name', 'type']
        },
        description: 'Array of channels to create'
      }
    },
    required: ['channels'],
    additionalProperties: false
  },
  schema: z.object({
    channels: z.array(z.object({
      name: z.string().min(1).max(100),
      type: z.enum(['text', 'voice', 'announcement', 'forum', 'stage']),
      parent_id: identifierSchema.optional(),
      topic: z.string().max(1024).optional(),
      slowmode_seconds: z.number().int().min(0).max(21600).optional(),
      nsfw: z.boolean().optional(),
      position: z.number().int().min(0).optional()
    })).min(1)
  }),
  handler: async (args, context) => {
    try {
      const res = await batchCreateChannelsOp(args, context);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Batch create channels failed: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: batch_create_roles
// -------------------------------------------------------------
registerTool({
  name: 'batch_create_roles',
  description: 'Create multiple server roles at once with optional colors, hoist, mentionable status, and permissions. Highly token efficient.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      roles: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Role name (1-100 chars)' },
            color: { type: 'string', description: 'Hex color string (e.g. "#FF5733")' },
            hoist: { type: 'boolean', description: 'Display separately in member list' },
            mentionable: { type: 'boolean', description: 'Mentionable by all members' },
            permissions: {
              type: 'array',
              items: { type: 'string', enum: WHITELISTED_PERMISSIONS },
              description: 'Array of whitelisted permission names'
            }
          },
          required: ['name']
        },
        description: 'Array of roles to create'
      }
    },
    required: ['roles'],
    additionalProperties: false
  },
  schema: z.object({
    roles: z.array(z.object({
      name: z.string().min(1).max(100),
      color: hexColorSchema.optional(),
      hoist: z.boolean().optional(),
      mentionable: z.boolean().optional(),
      permissions: z.array(permissionNameSchema).optional()
    })).min(1)
  }),
  handler: async (args, context) => {
    try {
      const res = await batchCreateRolesOp(args, context);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Batch create roles failed: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: batch_set_channel_permissions
// -------------------------------------------------------------
registerTool({
  name: 'batch_set_channel_permissions',
  description: 'Set explicit permission overwrites on multiple channels or categories for roles or members in a single command. Highly token efficient.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      overwrites: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            channel_id: { type: 'string', description: 'ID or name of channel or category' },
            target_id: { type: 'string', description: 'Target role/member ID or name ("@everyone" for default)' },
            target_type: { type: 'string', enum: ['role', 'member'] },
            allow: {
              type: 'array',
              items: { type: 'string', enum: WHITELISTED_PERMISSIONS },
              description: 'Permissions to explicitly ALLOW'
            },
            deny: {
              type: 'array',
              items: { type: 'string', enum: WHITELISTED_PERMISSIONS },
              description: 'Permissions to explicitly DENY'
            }
          },
          required: ['channel_id', 'target_id', 'target_type']
        },
        description: 'Array of permission overwrites'
      }
    },
    required: ['overwrites'],
    additionalProperties: false
  },
  schema: z.object({
    overwrites: z.array(z.object({
      channel_id: identifierSchema,
      target_id: identifierSchema,
      target_type: z.enum(['role', 'member']),
      allow: z.array(permissionNameSchema).optional(),
      deny: z.array(permissionNameSchema).optional()
    })).min(1)
  }),
  handler: async (args, context) => {
    try {
      const res = await batchSetChannelPermissionsOp(args, context);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Batch set channel permissions failed: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: batch_send_messages
// -------------------------------------------------------------
registerTool({
  name: 'batch_send_messages',
  description: 'Send multiple messages to one or more text channels in a single command (e.g. posting server rules, welcome text, category guides). Highly token efficient.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      messages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            channel_id: { type: 'string', description: 'ID or name of text channel' },
            content: { type: 'string', description: 'Message content (1-2000 chars)' },
            pin: { type: 'boolean', description: 'Whether to pin the message' }
          },
          required: ['channel_id', 'content']
        },
        description: 'Array of messages to send'
      }
    },
    required: ['messages'],
    additionalProperties: false
  },
  schema: z.object({
    messages: z.array(z.object({
      channel_id: identifierSchema,
      content: z.string().min(1).max(2000),
      pin: z.boolean().optional()
    })).min(1)
  }),
  handler: async (args, context) => {
    try {
      const res = await batchSendMessagesOp(args, context);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Batch send messages failed: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: list_members (Read)
// -------------------------------------------------------------
registerTool({
  name: 'list_members',
  description: 'Search or list server members with their roles, nicknames, joined dates, and moderation status. Use this to find member IDs before managing roles or moderating.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query to filter members by username or nickname' },
      limit: { type: 'integer', description: 'Max number of members to return (1-100, default 50)' },
      after: { type: 'string', description: 'Snowflake ID to paginate after' }
    },
    additionalProperties: false
  },
  schema: z.object({
    query: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    after: identifierSchema.optional()
  }),
  handler: async (args) => {
    try {
      const res = await listMembersOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to list members: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: assign_member_role
// -------------------------------------------------------------
registerTool({
  name: 'assign_member_role',
  description: 'Assign a role to a specific guild member.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      member_id: { type: 'string', description: 'ID, username, or nickname of the member' },
      role_id: { type: 'string', description: 'ID or name of the role to assign' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['member_id', 'role_id'],
    additionalProperties: false
  },
  schema: z.object({
    member_id: identifierSchema,
    role_id: identifierSchema,
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await assignMemberRoleOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to assign role: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: remove_member_role
// -------------------------------------------------------------
registerTool({
  name: 'remove_member_role',
  description: 'Remove a role from a specific guild member.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      member_id: { type: 'string', description: 'ID, username, or nickname of the member' },
      role_id: { type: 'string', description: 'ID or name of the role to remove' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['member_id', 'role_id'],
    additionalProperties: false
  },
  schema: z.object({
    member_id: identifierSchema,
    role_id: identifierSchema,
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await removeMemberRoleOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to remove role: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: set_member_nickname
// -------------------------------------------------------------
registerTool({
  name: 'set_member_nickname',
  description: 'Change or reset a member\'s nickname in the server.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      member_id: { type: 'string', description: 'ID, username, or nickname of the member' },
      nickname: { type: 'string', description: 'New nickname (empty string or omit to reset to default username)' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['member_id'],
    additionalProperties: false
  },
  schema: z.object({
    member_id: identifierSchema,
    nickname: z.string().nullable().optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await setMemberNicknameOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to set nickname: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: timeout_member (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'timeout_member',
  description: 'Temporarily timeout/mute a member or remove an existing timeout. DESTRUCTIVE: requires user approval when armed.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      member_id: { type: 'string', description: 'ID, username, or nickname of the member' },
      duration_minutes: { type: 'integer', description: 'Duration in minutes (1 to 40320 = 28 days, or 0 to remove timeout)' },
      reason: { type: 'string', description: 'Audit log reason for timeout' }
    },
    required: ['member_id'],
    additionalProperties: false
  },
  schema: z.object({
    member_id: identifierSchema,
    duration_minutes: z.number().int().min(0).max(40320).nullable().optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await timeoutMemberOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to timeout member: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: kick_member (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'kick_member',
  description: 'Kick a member from the server. DESTRUCTIVE: requires user approval when armed.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      member_id: { type: 'string', description: 'ID, username, or nickname of the member to kick' },
      reason: { type: 'string', description: 'Reason for kicking the member' }
    },
    required: ['member_id'],
    additionalProperties: false
  },
  schema: z.object({
    member_id: identifierSchema,
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await kickMemberOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to kick member: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: ban_member (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'ban_member',
  description: 'Permanently ban a user from the server and optionally delete their recent messages. DESTRUCTIVE: requires user approval when armed.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      user_id: { type: 'string', description: 'ID, username, or nickname of the user to ban' },
      delete_message_seconds: { type: 'integer', description: 'Number of seconds of message history to delete (0 to 604800 = 7 days, e.g. 86400 for 1 day)' },
      reason: { type: 'string', description: 'Reason for the ban' }
    },
    required: ['user_id'],
    additionalProperties: false
  },
  schema: z.object({
    user_id: identifierSchema,
    delete_message_seconds: z.number().int().min(0).max(604800).optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await banMemberOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to ban user: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: unban_member
// -------------------------------------------------------------
registerTool({
  name: 'unban_member',
  description: 'Unban a previously banned user by their user ID.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      user_id: { type: 'string', description: 'ID of the banned user' },
      reason: { type: 'string', description: 'Reason for unbanning' }
    },
    required: ['user_id'],
    additionalProperties: false
  },
  schema: z.object({
    user_id: identifierSchema,
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await unbanMemberOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to unban user: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: list_bans (Read)
// -------------------------------------------------------------
registerTool({
  name: 'list_bans',
  description: 'List all banned users in the server with their recorded ban reasons.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: 'Maximum number of bans to fetch (1-100, default 50)' }
    },
    additionalProperties: false
  },
  schema: z.object({
    limit: z.number().int().min(1).max(100).optional()
  }),
  handler: async (args) => {
    try {
      const res = await listBansOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to list bans: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: get_channel_messages (Read)
// -------------------------------------------------------------
registerTool({
  name: 'get_channel_messages',
  description: 'Read recent message history in a channel to analyze user activity, verify bot posts, or inspect discussions.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'ID or name of the channel' },
      limit: { type: 'integer', description: 'Number of messages to retrieve (1-100, default 50)' },
      before_id: { type: 'string', description: 'Snowflake message ID to fetch messages before' },
      after_id: { type: 'string', description: 'Snowflake message ID to fetch messages after' },
      around_id: { type: 'string', description: 'Snowflake message ID to fetch messages around' }
    },
    required: ['channel_id'],
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema,
    limit: z.number().int().min(1).max(100).optional(),
    before_id: identifierSchema.optional(),
    after_id: identifierSchema.optional(),
    around_id: identifierSchema.optional()
  }),
  handler: async (args) => {
    try {
      const res = await getChannelMessagesOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to get channel messages: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: edit_message
// -------------------------------------------------------------
registerTool({
  name: 'edit_message',
  description: 'Edit a previously sent message in a channel (e.g. updating server rules, welcome banners, or category guides).',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'ID or name of the channel' },
      message_id: { type: 'string', description: 'ID of the message to edit' },
      content: { type: 'string', description: 'New message content (1-2000 chars)' }
    },
    required: ['channel_id', 'message_id', 'content'],
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema,
    message_id: identifierSchema,
    content: z.string().min(1).max(2000)
  }),
  handler: async (args) => {
    try {
      const res = await editMessageOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to edit message: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: delete_message (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'delete_message',
  description: 'Permanently delete a specific message from a channel. DESTRUCTIVE: requires user approval when armed.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'ID or name of the channel' },
      message_id: { type: 'string', description: 'ID of the message to delete' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['channel_id', 'message_id'],
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema,
    message_id: identifierSchema,
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await deleteMessageOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to delete message: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: purge_messages (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'purge_messages',
  description: 'Bulk delete multiple messages (2-100) in a channel, optionally filtering by author or bot-only. DESTRUCTIVE: requires user approval when armed.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'ID or name of the channel' },
      count: { type: 'integer', description: 'Number of recent messages to inspect/delete (2-100, default 10)' },
      filter_user_id: { type: 'string', description: 'Only delete messages sent by this user ID or username' },
      bot_only: { type: 'boolean', description: 'If true, only deletes bot messages' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['channel_id', 'count'],
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema,
    count: z.number().int().min(2).max(100),
    filter_user_id: identifierSchema.optional(),
    bot_only: z.boolean().optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await purgeMessagesOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to purge messages: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: pin_message
// -------------------------------------------------------------
registerTool({
  name: 'pin_message',
  description: 'Pin or unpin a message in a text channel.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'ID or name of the channel' },
      message_id: { type: 'string', description: 'ID of the message' },
      pinned: { type: 'boolean', description: 'True to pin, false to unpin (default true)' }
    },
    required: ['channel_id', 'message_id'],
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema,
    message_id: identifierSchema,
    pinned: z.boolean().optional()
  }),
  handler: async (args) => {
    try {
      const res = await pinMessageOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to pin/unpin message: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: list_emojis (Read)
// -------------------------------------------------------------
registerTool({
  name: 'list_emojis',
  description: 'List all custom emojis in the server with IDs, names, animated flags, and URLs.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  schema: z.object({}).passthrough(),
  handler: async () => {
    try {
      const res = await listEmojisOp();
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to list emojis: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: create_emoji
// -------------------------------------------------------------
registerTool({
  name: 'create_emoji',
  description: 'Upload and create a new custom emoji for the server from an image URL or data URI.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Emoji name (2-32 alphanumeric/underscore characters)' },
      image: { type: 'string', description: 'HTTPS image URL or base64 data URI (PNG, JPEG, GIF)' },
      roles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of role IDs or names allowed to use this emoji'
      },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['name', 'image'],
    additionalProperties: false
  },
  schema: z.object({
    name: z.string().min(2).max(32),
    image: z.string().min(1),
    roles: z.array(identifierSchema).optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await createEmojiOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to create emoji "${args.name}": ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: edit_emoji
// -------------------------------------------------------------
registerTool({
  name: 'edit_emoji',
  description: 'Edit a custom emoji\'s name or restricted roles.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      emoji_id: { type: 'string', description: 'ID or current name of the emoji' },
      name: { type: 'string', description: 'New emoji name (2-32 chars)' },
      roles: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of role IDs/names allowed to use this emoji'
      },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['emoji_id'],
    additionalProperties: false
  },
  schema: z.object({
    emoji_id: identifierSchema,
    name: z.string().min(2).max(32).optional(),
    roles: z.array(identifierSchema).optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await editEmojiOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to edit emoji ${args.emoji_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: delete_emoji (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'delete_emoji',
  description: 'Permanently delete a custom emoji. DESTRUCTIVE: requires user approval when armed.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      emoji_id: { type: 'string', description: 'ID or name of the emoji to delete' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['emoji_id'],
    additionalProperties: false
  },
  schema: z.object({
    emoji_id: identifierSchema,
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await deleteEmojiOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to delete emoji ${args.emoji_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: list_stickers (Read)
// -------------------------------------------------------------
registerTool({
  name: 'list_stickers',
  description: 'List all custom stickers in the server.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  schema: z.object({}).passthrough(),
  handler: async () => {
    try {
      const res = await listStickersOp();
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to list stickers: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: create_sticker
// -------------------------------------------------------------
registerTool({
  name: 'create_sticker',
  description: 'Create a new custom sticker for the server (PNG, APNG, Lottie).',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Sticker name (2-30 chars)' },
      file: { type: 'string', description: 'HTTPS file URL or data URI' },
      tags: { type: 'string', description: 'Related emoji string (e.g. "👍" or "wave")' },
      description: { type: 'string', description: 'Description of the sticker (max 100 chars)' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['name', 'file', 'tags'],
    additionalProperties: false
  },
  schema: z.object({
    name: z.string().min(2).max(30),
    file: z.string().min(1),
    tags: z.string().min(1),
    description: z.string().max(100).optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await createStickerOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to create sticker "${args.name}": ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: edit_sticker
// -------------------------------------------------------------
registerTool({
  name: 'edit_sticker',
  description: 'Edit a custom sticker\'s name, description, or tags.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      sticker_id: { type: 'string', description: 'ID or name of the sticker' },
      name: { type: 'string', description: 'New sticker name (2-30 chars)' },
      description: { type: 'string', description: 'New description (max 100 chars)' },
      tags: { type: 'string', description: 'New related emoji tags' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['sticker_id'],
    additionalProperties: false
  },
  schema: z.object({
    sticker_id: identifierSchema,
    name: z.string().min(2).max(30).optional(),
    description: z.string().max(100).optional(),
    tags: z.string().optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await editStickerOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to edit sticker ${args.sticker_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: delete_sticker (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'delete_sticker',
  description: 'Permanently delete a custom sticker. DESTRUCTIVE: requires user approval when armed.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      sticker_id: { type: 'string', description: 'ID or name of the sticker to delete' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['sticker_id'],
    additionalProperties: false
  },
  schema: z.object({
    sticker_id: identifierSchema,
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await deleteStickerOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to delete sticker ${args.sticker_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: list_soundboard_sounds (Read)
// -------------------------------------------------------------
registerTool({
  name: 'list_soundboard_sounds',
  description: 'List all custom soundboard sounds in the server.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  schema: z.object({}).passthrough(),
  handler: async () => {
    try {
      const res = await listSoundboardSoundsOp();
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to list soundboard sounds: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: create_soundboard_sound
// -------------------------------------------------------------
registerTool({
  name: 'create_soundboard_sound',
  description: 'Upload and create a new custom soundboard sound for the guild (MP3/OGG audio up to 512KB).',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Sound name (2-32 chars)' },
      sound: { type: 'string', description: 'Audio file HTTPS URL or base64 data URI' },
      volume: { type: 'number', description: 'Default playback volume (0.0 to 1.0, default 1.0)' },
      emoji_name: { type: 'string', description: 'Unicode emoji string (e.g. "👏")' },
      emoji_id: { type: 'string', description: 'Custom emoji ID' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['name', 'sound'],
    additionalProperties: false
  },
  schema: z.object({
    name: z.string().min(2).max(32),
    sound: z.string().min(1),
    volume: z.number().min(0).max(1).optional(),
    emoji_name: z.string().optional(),
    emoji_id: identifierSchema.optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await createSoundboardSoundOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to create soundboard sound "${args.name}": ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: edit_soundboard_sound
// -------------------------------------------------------------
registerTool({
  name: 'edit_soundboard_sound',
  description: 'Edit a soundboard sound\'s name, volume, or associated emoji.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      sound_id: { type: 'string', description: 'ID or name of the soundboard sound' },
      name: { type: 'string', description: 'New sound name (2-32 chars)' },
      volume: { type: 'number', description: 'New volume (0.0 to 1.0)' },
      emoji_name: { type: 'string', description: 'Unicode emoji string' },
      emoji_id: { type: 'string', description: 'Custom emoji ID' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['sound_id'],
    additionalProperties: false
  },
  schema: z.object({
    sound_id: identifierSchema,
    name: z.string().min(2).max(32).optional(),
    volume: z.number().min(0).max(1).optional(),
    emoji_name: z.string().nullable().optional(),
    emoji_id: identifierSchema.nullable().optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await editSoundboardSoundOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to edit soundboard sound ${args.sound_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: delete_soundboard_sound (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'delete_soundboard_sound',
  description: 'Permanently delete a soundboard sound. DESTRUCTIVE: requires user approval when armed.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      sound_id: { type: 'string', description: 'ID or name of the sound to delete' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['sound_id'],
    additionalProperties: false
  },
  schema: z.object({
    sound_id: identifierSchema,
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await deleteSoundboardSoundOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to delete soundboard sound ${args.sound_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: list_automod_rules (Read)
// -------------------------------------------------------------
registerTool({
  name: 'list_automod_rules',
  description: 'List all auto-moderation rules configured in the server.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  schema: z.object({}).passthrough(),
  handler: async () => {
    try {
      const res = await listAutomodRulesOp();
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to list auto-mod rules: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: create_automod_rule
// -------------------------------------------------------------
registerTool({
  name: 'create_automod_rule',
  description: 'Create an Auto-Moderation rule (e.g. blocking forbidden words, regex patterns, anti-spam, or mention spam).',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Rule name (1-100 chars)' },
      trigger_type: {
        type: 'string',
        enum: ['keyword', 'harmful_link', 'spam', 'mention_spam', 'keyword_preset'],
        description: 'Trigger type'
      },
      keyword_filter: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of keyword string filters (wildcards allowed, e.g. "*badword*")'
      },
      regex_patterns: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of regex pattern strings (max 10)'
      },
      mention_total_limit: {
        type: 'integer',
        description: 'Total mention limit for mention_spam trigger (1-50)'
      },
      actions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['block_message', 'send_alert_message', 'timeout'] },
            channel_id: { type: 'string', description: 'Alert channel ID for send_alert_message action' },
            duration_seconds: { type: 'integer', description: 'Timeout duration in seconds for timeout action' }
          },
          required: ['type']
        },
        description: 'Array of actions to take when rule triggers'
      },
      enabled: { type: 'boolean', description: 'Whether rule is initially active (default true)' },
      exempt_roles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Role IDs or names exempt from this rule'
      },
      exempt_channels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Channel IDs or names exempt from this rule'
      },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['name', 'trigger_type'],
    additionalProperties: false
  },
  schema: z.object({
    name: z.string().min(1).max(100),
    trigger_type: z.enum(['keyword', 'harmful_link', 'spam', 'mention_spam', 'keyword_preset']),
    keyword_filter: z.array(z.string()).optional(),
    regex_patterns: z.array(z.string()).optional(),
    presets: z.array(z.number().int()).optional(),
    mention_total_limit: z.number().int().min(1).max(50).optional(),
    actions: z.array(z.object({
      type: z.enum(['block_message', 'send_alert_message', 'timeout']),
      channel_id: identifierSchema.optional(),
      duration_seconds: z.number().int().optional()
    })).optional(),
    enabled: z.boolean().optional(),
    exempt_roles: z.array(identifierSchema).optional(),
    exempt_channels: z.array(identifierSchema).optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await createAutomodRuleOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to create auto-mod rule "${args.name}": ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: edit_automod_rule
// -------------------------------------------------------------
registerTool({
  name: 'edit_automod_rule',
  description: 'Edit an existing Auto-Moderation rule\'s name, status, filters, actions, or exemptions.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      rule_id: { type: 'string', description: 'ID or name of the auto-mod rule' },
      name: { type: 'string', description: 'New rule name' },
      enabled: { type: 'boolean', description: 'Enable or disable the rule' },
      keyword_filter: { type: 'array', items: { type: 'string' } },
      regex_patterns: { type: 'array', items: { type: 'string' } },
      actions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['block_message', 'send_alert_message', 'timeout'] },
            channel_id: { type: 'string' },
            duration_seconds: { type: 'integer' }
          },
          required: ['type']
        }
      },
      exempt_roles: { type: 'array', items: { type: 'string' } },
      exempt_channels: { type: 'array', items: { type: 'string' } },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['rule_id'],
    additionalProperties: false
  },
  schema: z.object({
    rule_id: identifierSchema,
    name: z.string().min(1).max(100).optional(),
    enabled: z.boolean().optional(),
    keyword_filter: z.array(z.string()).optional(),
    regex_patterns: z.array(z.string()).optional(),
    actions: z.array(z.object({
      type: z.enum(['block_message', 'send_alert_message', 'timeout']),
      channel_id: identifierSchema.optional(),
      duration_seconds: z.number().int().optional()
    })).optional(),
    exempt_roles: z.array(identifierSchema).optional(),
    exempt_channels: z.array(identifierSchema).optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await editAutomodRuleOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to edit auto-mod rule ${args.rule_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: delete_automod_rule (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'delete_automod_rule',
  description: 'Permanently delete an Auto-Moderation rule. DESTRUCTIVE: requires user approval when armed.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      rule_id: { type: 'string', description: 'ID or name of the auto-mod rule to delete' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['rule_id'],
    additionalProperties: false
  },
  schema: z.object({
    rule_id: identifierSchema,
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await deleteAutomodRuleOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to delete auto-mod rule ${args.rule_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: list_webhooks (Read)
// -------------------------------------------------------------
registerTool({
  name: 'list_webhooks',
  description: 'List webhooks in the server or for a specific channel.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'Optional channel ID/name to filter webhooks' }
    },
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema.optional()
  }),
  handler: async (args) => {
    try {
      const res = await listWebhooksOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to list webhooks: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: create_webhook
// -------------------------------------------------------------
registerTool({
  name: 'create_webhook',
  description: 'Create a new webhook for a text/announcement channel to enable external bot or API integrations.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'Channel ID or name to create the webhook in' },
      name: { type: 'string', description: 'Webhook name (1-80 chars)' },
      avatar: { type: 'string', description: 'Avatar HTTPS URL or data URI' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['channel_id', 'name'],
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema,
    name: z.string().min(1).max(80),
    avatar: z.string().optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await createWebhookOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to create webhook "${args.name}": ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: edit_webhook
// -------------------------------------------------------------
registerTool({
  name: 'edit_webhook',
  description: 'Edit a webhook\'s name, avatar, or move it to a different channel.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      webhook_id: { type: 'string', description: 'Webhook ID or name' },
      name: { type: 'string', description: 'New webhook name (1-80 chars)' },
      avatar: { type: 'string', description: 'New avatar HTTPS URL or empty to remove' },
      channel_id: { type: 'string', description: 'New destination channel ID/name' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['webhook_id'],
    additionalProperties: false
  },
  schema: z.object({
    webhook_id: identifierSchema,
    name: z.string().min(1).max(80).optional(),
    avatar: z.string().nullable().optional(),
    channel_id: identifierSchema.optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await editWebhookOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to edit webhook ${args.webhook_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: delete_webhook (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'delete_webhook',
  description: 'Permanently delete a webhook. DESTRUCTIVE: requires user approval when armed.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      webhook_id: { type: 'string', description: 'Webhook ID or name to delete' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['webhook_id'],
    additionalProperties: false
  },
  schema: z.object({
    webhook_id: identifierSchema,
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await deleteWebhookOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to delete webhook ${args.webhook_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: send_webhook_message
// -------------------------------------------------------------
registerTool({
  name: 'send_webhook_message',
  description: 'Send a message through a webhook with custom display name and avatar.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      webhook_id: { type: 'string', description: 'Webhook ID or name' },
      content: { type: 'string', description: 'Message content (1-2000 chars)' },
      username: { type: 'string', description: 'Override webhook username' },
      avatar_url: { type: 'string', description: 'Override webhook avatar URL' }
    },
    required: ['webhook_id', 'content'],
    additionalProperties: false
  },
  schema: z.object({
    webhook_id: identifierSchema,
    content: z.string().min(1).max(2000),
    username: z.string().optional(),
    avatar_url: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await sendWebhookMessageOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to send webhook message: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: list_integrations (Read)
// -------------------------------------------------------------
registerTool({
  name: 'list_integrations',
  description: 'List active integrations, bots, and connected apps in the server.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  schema: z.object({}).passthrough(),
  handler: async () => {
    try {
      const res = await listIntegrationsOp();
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to list integrations: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: finish
// -------------------------------------------------------------
registerTool({
  name: 'finish',
  description: 'Call this tool when all requested restructuring steps and plans are complete, providing a concise final summary.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Summary of the actions taken and the final server structure' }
    },
    required: ['summary'],
    additionalProperties: false
  },
  schema: z.object({
    summary: z.string().min(1)
  }),
  handler: async (args) => {
    return { ok: true, result: { finished: true, summary: args.summary } };
  }
});

/**
 * Recursively cleans JSON schema so that upstream OpenAI/Gemini providers
 * never reject tool definitions with invalid enum types or union type arrays.
 */
function sanitizeJsonSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) {
    return schema.map(sanitizeJsonSchema);
  }

  const clean = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type' && Array.isArray(value)) {
      const primaryType = value.find((t) => t !== 'null') || 'string';
      clean.type = primaryType;
    } else if (key === 'enum' && Array.isArray(value)) {
      clean.enum = value.map((v) => String(v));
    } else if (typeof value === 'object' && value !== null) {
      clean[key] = sanitizeJsonSchema(value);
    } else {
      clean[key] = value;
    }
  }

  // Gemini and OpenAPI require all enum values to be strings.
  // If property is integer or number, delete enum to avoid type mismatch errors.
  if ((clean.type === 'integer' || clean.type === 'number') && clean.enum) {
    delete clean.enum;
  }

  return clean;
}

/**
 * Returns OpenAI-formatted tools array with sanitized JSON schema definitions.
 */
export function getOpenAITools() {
  return Array.from(toolsRegistry.values()).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: sanitizeJsonSchema(tool.parameters)
    }
  }));
}
