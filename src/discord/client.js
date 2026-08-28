import { Client, GatewayIntentBits, ChannelType, Events } from 'discord.js';

let clientInstance = null;
let clientReadyPromise = null;

const PRIVILEGED_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildEmojisAndStickers,
  GatewayIntentBits.GuildIntegrations,
  GatewayIntentBits.GuildWebhooks,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.AutoModerationConfiguration,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildMembers
];

const BASE_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildEmojisAndStickers,
  GatewayIntentBits.GuildIntegrations,
  GatewayIntentBits.GuildWebhooks,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.AutoModerationConfiguration
];

export function isDiscordConfigured() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  return Boolean(token && token.trim() && guildId && guildId.trim());
}

export function isDiscordReady() {
  return Boolean(clientInstance && clientInstance.isReady());
}

async function loginClientWithFallback(token, onReady) {
  // First attempt: Request MessageContent & GuildMembers privileged intents
  let client = new Client({ intents: PRIVILEGED_INTENTS });
  let hasPrivileged = true;

  try {
    await new Promise((resolve, reject) => {
      client.once(Events.ClientReady, async (readyClient) => {
        try {
          await performSelfCheck(readyClient, true);
          resolve(readyClient);
        } catch (err) {
          resolve(readyClient);
        }
      });

      client.on('error', (err) => {
        console.error('Discord client error:', err);
      });

      client.login(token.trim()).catch(reject);
    });

    return { client, hasPrivileged: true };
  } catch (err) {
    if (err.code === 'DisallowedIntents' || err.message?.includes('disallowed') || err.message?.includes('intent')) {
      console.warn('\n⚠️ [Discord Gateway] Message Content or Server Members intent is not enabled in Discord Developer Portal.');
      console.warn('⚠️ Falling back to base intents. To let the bot read user message text, open Discord Developer Portal > Applications > Your Bot > Bot tab > Scroll to "Privileged Gateway Intents" and toggle ON "Message Content Intent".\n');
      
      try {
        client.destroy();
      } catch (_) {}

      // Second attempt: Fallback to base intents without privileged intents
      const fallbackClient = new Client({ intents: BASE_INTENTS });
      await new Promise((resolve, reject) => {
        fallbackClient.once(Events.ClientReady, async (readyClient) => {
          try {
            await performSelfCheck(readyClient, false);
            resolve(readyClient);
          } catch (err) {
            resolve(readyClient);
          }
        });

        fallbackClient.on('error', (fallbackErr) => {
          console.error('Discord client error:', fallbackErr);
        });

        fallbackClient.login(token.trim()).catch(reject);
      });

      return { client: fallbackClient, hasPrivileged: false };
    }

    throw err;
  }
}

/**
 * Initialize or get the Discord client singleton.
 */
export function getDiscordClient() {
  if (clientInstance) return clientInstance;

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token || !token.trim()) {
    console.warn('⚠️ DISCORD_BOT_TOKEN is not configured yet. Server is waiting for Web UI setup.');
    return null;
  }

  clientReadyPromise = loginClientWithFallback(token)
    .then(({ client }) => {
      clientInstance = client;
      return client;
    })
    .catch((err) => {
      console.error('Failed to log in to Discord:', err.message);
      throw err;
    });

  return clientInstance;
}

/**
 * Reconnect or initialize Discord client with new credentials from Web UI.
 */
export async function reconnectDiscordClient(token, guildId) {
  if (clientInstance) {
    try {
      clientInstance.destroy();
    } catch (_) {}
    clientInstance = null;
    clientReadyPromise = null;
  }

  if (token) process.env.DISCORD_BOT_TOKEN = token.trim();
  if (guildId) process.env.DISCORD_GUILD_ID = guildId.trim();

  clientReadyPromise = loginClientWithFallback(token).then(({ client }) => {
    clientInstance = client;
    return client;
  });

  const readyClient = await clientReadyPromise;

  const targetGuildId = guildId || process.env.DISCORD_GUILD_ID;
  const guild = await readyClient.guilds.fetch(targetGuildId).catch((err) => {
    throw new Error(`Connected to Discord, but could not fetch guild ${targetGuildId}: ${err.message}. Make sure the bot is invited to this server.`);
  });

  return {
    ok: true,
    guild: {
      id: guild.id,
      name: guild.name,
      memberCount: guild.memberCount
    }
  };
}

/**
 * Perform a self-check on boot and print diagnostic stats.
 */
async function performSelfCheck(readyClient, hasPrivileged = true) {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) {
    console.warn('⚠️ DISCORD_GUILD_ID is not set. Cannot run self-check.');
    return;
  }

  const guild = await readyClient.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    console.error(`❌ Bot logged in as ${readyClient.user.tag}, but guild ${guildId} was not found or the bot is not a member!`);
    return;
  }

  const [roles, channels, botMember] = await Promise.all([
    guild.roles.fetch(),
    guild.channels.fetch(),
    guild.members.fetch(readyClient.user.id).catch(() => null)
  ]);

  const botHighestRole = botMember ? botMember.roles.highest : null;
  const maxRolePosition = Math.max(...roles.map(r => r.position), 0);
  const isCommunity = guild.features.includes('COMMUNITY');
  const channelCount = channels.filter(c => c && c.type !== ChannelType.PublicThread && c.type !== ChannelType.PrivateThread).size;
  const roleCount = roles.size;

  console.log('\n================ DISCORD BOT SELF-CHECK ================');
  console.log(`🤖 Bot User:         ${readyClient.user.tag} (${readyClient.user.id})`);
  console.log(`🏰 Target Guild:     ${guild.name} (${guild.id})`);
  console.log(`👥 Member Count:    ${guild.memberCount}`);
  console.log(`🌐 Community Flag:   ${isCommunity ? 'ENABLED' : 'DISABLED'}`);
  console.log(`💬 Message Content:  ${hasPrivileged ? 'ENABLED ✅' : 'DISABLED ⚠️ (Enable in Developer Portal to read user chat)'}`);
  console.log(`📊 Channels:         ${channelCount}/500`);
  console.log(`🎭 Roles:            ${roleCount}/250`);
  console.log(`⭐ Bot Highest Role: "${botHighestRole ? botHighestRole.name : 'None'}" (Position: ${botHighestRole ? botHighestRole.position : 0} / Max: ${maxRolePosition})`);

  if (!botHighestRole || botHighestRole.position < maxRolePosition - 1) {
    console.warn('\n⚠️ WARNING: The bot\'s highest role is NOT near the top of the role list!');
    console.warn('Discord permission hierarchy prevents the bot from managing or creating roles positioned above its own role.');
    console.warn('Please open Server Settings > Roles in Discord and drag the bot\'s role to the top of the list!\n');
  } else {
    console.log('✅ Role hierarchy check passed (bot role is near/at top).');
  }
  console.log('========================================================\n');
}

/**
 * Await client readiness and fetch the target guild.
 */
export async function getGuild() {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) {
    throw new Error('DISCORD_GUILD_ID is not configured. Please configure it via Web UI setup.');
  }

  if (!clientInstance) {
    getDiscordClient();
  }

  if (!clientReadyPromise) {
    throw new Error('Discord bot is not connected. Please configure your bot token via Web UI setup.');
  }

  await clientReadyPromise;

  const guild = await clientInstance.guilds.fetch(guildId).catch((err) => {
    throw new Error(`Failed to fetch guild ID ${guildId}: ${err.message}. Make sure the bot is invited to this server.`);
  });

  if (!guild) {
    throw new Error(`Guild with ID ${guildId} was not found or the bot is not a member.`);
  }

  return guild;
}

/**
 * Get state summary for API /api/state
 */
export async function getGuildStateSummary() {
  if (!isDiscordConfigured()) {
    return {
      configured: false,
      botUser: null,
      guild: {
        id: '',
        name: 'Not Configured',
        memberCount: 0,
        community: false,
        iconURL: null
      },
      botHighestRole: { name: 'None', position: 0 },
      maxRolePosition: 0,
      roleHierarchyWarning: false,
      channelCount: 0,
      maxChannels: 500,
      roleCount: 0,
      maxRoles: 250
    };
  }

  const guild = await getGuild();
  const [roles, channels, botMember] = await Promise.all([
    guild.roles.fetch(),
    guild.channels.fetch(),
    guild.members.fetch(clientInstance.user.id).catch(() => null)
  ]);

  const botHighestRole = botMember ? botMember.roles.highest : null;
  const maxRolePosition = Math.max(...roles.map(r => r.position), 0);
  const isCommunity = guild.features.includes('COMMUNITY');
  const channelCount = channels.filter(c => c && c.type !== ChannelType.PublicThread && c.type !== ChannelType.PrivateThread).size;
  const roleCount = roles.size;

  const roleHierarchyWarning = !botHighestRole || botHighestRole.position < maxRolePosition - 1;

  return {
    configured: true,
    botUser: {
      id: clientInstance.user.id,
      tag: clientInstance.user.tag,
      username: clientInstance.user.username
    },
    guild: {
      id: guild.id,
      name: guild.name,
      memberCount: guild.memberCount,
      community: isCommunity,
      iconURL: guild.iconURL()
    },
    botHighestRole: {
      name: botHighestRole ? botHighestRole.name : 'None',
      position: botHighestRole ? botHighestRole.position : 0
    },
    maxRolePosition,
    roleHierarchyWarning,
    channelCount,
    maxChannels: 500,
    roleCount,
    maxRoles: 250
  };
}
