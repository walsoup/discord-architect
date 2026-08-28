# Discord Architect

A local AI-powered server architect that analyzes, plans, and restructures your Discord server through a conversational web interface using OpenAI and Discord.js.

---

## 1. Prerequisites

- **Node.js 20+** installed on your system.
- An **OpenAI API Key** with access to GPT-4o / GPT-4.1.
- A **Discord Account** with *Administrator* or *Manage Server* permissions on your target Discord server.

---

## 2. Creating the Bot in the Discord Developer Portal

1. Navigate to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application** in the top right, name it (e.g., `Discord Architect`), and click **Create**.
3. In the left sidebar, click **Bot**.
4. Click **Reset Token** (or **Add Bot**) to generate your bot token. Copy this token for your `.env` file (`DISCORD_BOT_TOKEN`).
5. Under **Privileged Gateway Intents** (scroll down on the Bot tab):
   - Toggle **ON** **Message Content Intent** (Required if you want the bot to read user chat history and text).
   - Toggle **ON** **Server Members Intent** (Recommended for searching and listing server members).
   - Click **Save Changes**.

---

## 3. OAuth2 URL & Bot Permissions

1. In your application on the Developer Portal, go to **OAuth2 > URL Generator** in the left sidebar.
2. Under **Scopes**, check `bot`.
3. Under **Bot Permissions**, select:
   - **Manage Channels** (`MANAGE_CHANNELS`)
   - **Manage Roles** (`MANAGE_ROLES`)
   - **View Channels** (`VIEW_CHANNEL`)
   - **Send Messages** (`SEND_MESSAGES`)
   - **Manage Messages** (`MANAGE_MESSAGES`)
   - **Read Message History** (`READ_MESSAGE_HISTORY`)
   - **Kick Members** (`KICK_MEMBERS`)
   - **Ban Members** (`BAN_MEMBERS`)
   - **Moderate Members** (`MODERATE_MEMBERS`)
   - **Manage Nicknames** (`MANAGE_NICKNAMES`)
   - **Manage Guild / Server** (`MANAGE_GUILD`)
   - **Manage Webhooks** (`MANAGE_WEBHOOKS`)
   - **Manage Emojis and Stickers** (`MANAGE_EMOJIS_AND_STICKERS`)
   - *(Optional: Administrator if you want full unattended management)*
4. Copy the generated URL at the bottom of the page, open it in your browser, and authorize the bot to join your target server.

---

## 4. Dragging the Bot's Role to the Top (CRITICAL)

> **IMPORTANT:** In Discord's role hierarchy, a bot **cannot manage, create, or edit roles positioned higher than its own highest role**, nor can it assign permissions or moderate members with higher roles.

1. Open Discord and go to your server.
2. Click the server name in the top-left > **Server Settings** > **Roles**.
3. Locate the bot's integration role (named `Discord Architect` or your bot's name).
4. **Drag this role to the very top of the role list** (just below Server Owner).
5. Click **Save Changes**.

If you skip this step, Discord will return `403 Missing Permissions` whenever the bot attempts to create roles, moderate members, or reorder roles.

---

## 5. Enabling Developer Mode to Copy the Guild ID

1. In Discord, go to **User Settings** (the gear icon next to your avatar in the bottom left).
2. Scroll down to **Advanced** in the left menu.
3. Toggle **Developer Mode** to **ON**.
4. In your server list on the left, right-click your server's icon and click **Copy Server ID**. This is your `DISCORD_GUILD_ID`.

---

## 6. Filling `.env`

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` with your credentials (or configure directly in the Web UI):

```env
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-4.1
# Optional: Set custom base URL for OpenAI-compatible proxies / providers:
# OPENAI_BASE_URL=https://openrouter.ai/api/v1
DISCORD_BOT_TOKEN=MTE...
DISCORD_GUILD_ID=123456789012345678
PORT=3650
```

---

## 7. Web Setup Wizard & Provider Configuration

You can set up and change all credentials directly in the **Web UI** without editing files:
- When you first start the app and visit `http://127.0.0.1:3650`, the **Web Setup Wizard** opens automatically.
- Paste your **Discord Bot Token** and **Guild ID**, click **Test & Connect Discord** to verify live connection, and save.
- Configure your **AI Provider / Proxy** (OpenAI, OpenRouter, Groq, Ollama, LM Studio, etc.) and model selection.
- Credentials are automatically saved to `.env` and the Discord bot connects on the fly.
- Re-open setup at any time via the **Setup & Config ⚙️** button in the header.

---

## 8. Installation & Running

```bash
# Install dependencies
npm install

# Start the server
npm start
```

Open your browser and navigate to **[http://127.0.0.1:3650](http://127.0.0.1:3650)**.

---

## 9. Safety, Confirmation & Dry Run Mode

> **KEEP DRY RUN MODE ENABLED (`ON`) FOR YOUR FIRST CONVERSATION.**
>
> By default, `DRY RUN` is **ON** at startup. In this mode, the agent simulates every Discord mutation, generates plausible fake IDs, and logs the entire operation to `logs/audit-YYYY-MM-DD.jsonl` without making any real changes to your Discord server.
>
> Once you have reviewed the agent's proposed plan and confirmed the simulated results look correct, you can toggle the switch to **`ARMED`** to execute live changes on your server.
>
> **Interactive Approval Gate:** Any destructive or irreversible operations (kicking/banning members, timeouts, deleting messages/purging channels, deleting channels, deleting roles, deleting emojis/stickers/sounds, deleting automod rules, or deleting webhooks) will immediately pause the execution loop and prompt you with an interactive confirmation modal before executing.

---

## Complete Toolset Capabilities

- **Server Architecture & Channels:** Full batch and individual creation, editing, moving, and deletion of categories and channels (text, voice, announcement, forum, stage), custom permission overwrites, and one-shot complete server deployment (`batch_create_structure`).
- **Member Management & Moderation:** Member search and role inspection (`list_members`), role assignment/removal (`assign_member_role`, `remove_member_role`), nickname management (`set_member_nickname`), member timeouts/mutes (`timeout_member`), kicks (`kick_member`), bans/unbans (`ban_member`, `unban_member`, `list_bans`).
- **Chat & Message History:** Reading channel chat history (`get_channel_messages`), sending messages (`send_message`, `batch_send_messages`), editing announcements/rules (`edit_message`), deleting messages (`delete_message`), bulk message purging (`purge_messages`), and message pinning (`pin_message`).
- **Server Visual Assets & Custom Media:** Changing guild icon, banner, invite splash, server description, vanity URL, AFK channel/timeout, verification levels (`edit_guild`), custom emoji management (`list_emojis`, `create_emoji`, `edit_emoji`, `delete_emoji`), custom sticker management (`list_stickers`, `create_sticker`, `edit_sticker`, `delete_sticker`), and custom soundboard management (`list_soundboard_sounds`, `create_soundboard_sound`, `edit_soundboard_sound`, `delete_soundboard_sound`).
- **Auto-Moderation & Webhooks:** Creating/managing Discord AutoMod rules with keyword filters, regex patterns, anti-spam, and timeout/alert actions (`list_automod_rules`, `create_automod_rule`, `edit_automod_rule`, `delete_automod_rule`), managing webhooks and integrations (`list_webhooks`, `create_webhook`, `edit_webhook`, `delete_webhook`, `send_webhook_message`, `list_integrations`).

---

## Architecture & Codebase Map

```
discord-architect/
  .env.example          # Environment template
  .gitignore            # Ignores .env, node_modules, and logs/
  package.json          # ESM package configuration
  README.md             # Setup guide and documentation
  src/
    server.js           # Express web server, REST API, SSE endpoints
    agent/
      loop.js           # Streaming OpenAI agent loop, tool accumulation, approval gate
      systemPrompt.js   # Dynamic system prompt generator with snapshot injection
      tools.js          # Tool definitions with JSON Schema, Zod validation, and handlers
    discord/
      client.js         # Discord.js client singleton, ready check, self-check logging
      snapshot.js       # Compact, token-efficient guild state serializer
      ops.js            # Mutation wrappers, rate-limit queue caller, dry-run simulation
      permissions.js    # Permission names whitelist <-> Bitfield conversions
      queue.js          # Serialized (concurrency 1), 350ms delay, 429 retry queue
    util/
      sse.js            # Server-Sent Events manager with buffering and 15s heartbeat
      log.js            # Daily JSONL audit logger and terminal output
  public/
    index.html          # Clean 3-pane interface
    app.js              # Client-side state, SSE event listeners, Markdown parser
    style.css           # Modern dark Discord-themed UI
  logs/                 # Daily audit logs (audit-YYYY-MM-DD.jsonl)
```
