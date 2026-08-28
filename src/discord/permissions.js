import { PermissionsBitField } from 'discord.js';

export const WHITELISTED_PERMISSIONS = [
  'ViewChannel',
  'SendMessages',
  'ReadMessageHistory',
  'AddReactions',
  'AttachFiles',
  'EmbedLinks',
  'CreatePublicThreads',
  'SendMessagesInThreads',
  'Connect',
  'Speak',
  'ManageMessages',
  'ManageChannels',
  'ManageRoles',
  'KickMembers',
  'BanMembers',
  'ModerateMembers',
  'MentionEveryone',
  'Administrator',
  'ManageGuild',
  'ManageWebhooks',
  'ManageGuildExpressions',
  'ManageEmojisAndStickers',
  'ManageNicknames',
  'ChangeNickname',
  'MuteMembers',
  'DeafenMembers',
  'MoveMembers',
  'UseApplicationCommands',
  'PrioritySpeaker',
  'Stream',
  'CreateInstantInvite',
  'SendVoiceMessages',
  'CreateGuildExpressions'
];

export const KEY_ROLE_PERMISSIONS = [
  'Administrator',
  'ManageGuild',
  'ManageChannels',
  'ManageRoles',
  'ManageMessages',
  'KickMembers',
  'BanMembers',
  'ModerateMembers',
  'MentionEveryone',
  'ManageWebhooks',
  'ManageGuildExpressions',
  'ViewChannel',
  'SendMessages',
  'Connect',
  'Speak'
];

const WHITELIST_SET = new Set(WHITELISTED_PERMISSIONS);

/**
 * Validate an array of permission names against the whitelist.
 * Throws a descriptive error if any permission is unknown.
 */
export function validatePermissions(permNames = []) {
  if (!Array.isArray(permNames)) {
    throw new Error(`Permissions must be an array of permission name strings.`);
  }
  const invalid = permNames.filter(name => !WHITELIST_SET.has(name));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid permission(s): ${invalid.join(', ')}. Allowed permissions are: ${WHITELISTED_PERMISSIONS.join(', ')}`
    );
  }
}

/**
 * Convert an array of whitelisted permission name strings to a Discord.js bitfield BigInt.
 */
export function namesToBitfield(permNames = []) {
  validatePermissions(permNames);
  let bitfield = 0n;
  for (const name of permNames) {
    const flag = PermissionsBitField.Flags[name];
    if (flag !== undefined) {
      bitfield |= BigInt(flag);
    }
  }
  return bitfield;
}

/**
 * Convert a Discord.js bitfield / PermissionsBitField to an array of whitelisted permission name strings.
 */
export function bitfieldToNames(bitfield) {
  if (!bitfield) return [];
  const perms = new PermissionsBitField(bitfield);
  return WHITELISTED_PERMISSIONS.filter(name => {
    const flag = PermissionsBitField.Flags[name];
    return flag !== undefined && perms.has(flag);
  });
}

/**
 * Filter a bitfield down to the key role permissions summary.
 */
export function bitfieldToKeyNames(bitfield) {
  if (!bitfield) return [];
  const perms = new PermissionsBitField(bitfield);
  return KEY_ROLE_PERMISSIONS.filter(name => {
    const flag = PermissionsBitField.Flags[name];
    return flag !== undefined && perms.has(flag);
  });
}
