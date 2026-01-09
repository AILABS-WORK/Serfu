# User Isolation & Group Management

## Overview

The bot now supports **user-specific isolation** - each user has their own groups, analytics, and settings. Users cannot see or access other users' groups.

## Key Changes

### 1. User Ownership of Groups

- Each group is now owned by a specific user
- When you add the bot to a group and interact with it, you become the owner
- Other users can add the bot to the same group, but they'll have their own separate instance
- Your groups are completely private to you

### 2. Improved Group Management

**New Features:**
- **Bot Invite Link**: Easy way to add bot to groups
- **Better UX**: Clear instructions and buttons
- **User-Scoped Commands**: All commands now filter by your user ID

**How to Add Groups:**
1. Click "➕ Add Group" or "🔗 Get Invite Link" in `/groups`
2. Use the invite link to add bot to a group
3. Run `/setdestination` in that group (if it's your destination)
4. Bot automatically tracks groups it's added to

### 3. Privacy & Isolation

- ✅ Each user only sees their own groups
- ✅ Analytics are user-specific
- ✅ Signals forward only to your destination groups
- ✅ Leaderboards show only your groups/users
- ✅ Complete data isolation between users

---

## Telegram API Limitation

### Can the bot read groups via your account?

**Short Answer: No, this is not possible with Telegram Bot API.**

**Why:**
- Telegram Bot API requires the bot to be a **member** of a group to read messages
- Bots cannot read messages through a user's account
- This is a security feature by Telegram

**What We Can Do:**
1. ✅ Bot invite links for easy addition
2. ✅ Auto-tracking when bot is added
3. ✅ User-specific group management
4. ✅ Private, isolated experiences

**Alternative Approaches:**
- **User Bots (MTProto)**: Would require your personal account credentials (not recommended, against ToS)
- **Telegram Client API**: Complex, requires user account, may violate ToS
- **Current Approach (Bot API)**: Secure, compliant, but requires bot to be in group

---

## How It Works Now

### Adding a Group

**Method 1: Invite Link (Recommended)**
1. Run `/groups` command
2. Click "🔗 Get Invite Link"
3. Share link or click to add bot to group
4. Bot automatically starts tracking

**Method 2: Manual**
1. Go to your group
2. Add @YourBotUsername as member
3. Bot automatically detects and tracks
4. Run `/setdestination` if it's your destination

### Group Ownership

- **First Interaction**: When you first interact with a group (send message, run command), you become the owner
- **Auto-Creation**: Groups are created automatically when bot detects messages
- **Ownership**: Each user has their own copy of the group with their own settings

### Signal Forwarding

- Signals from your source groups → Forward to your destination groups
- Other users' signals → Never forwarded to your groups
- Complete isolation

---

## Commands Updated

All commands are now user-scoped:

- `/groups` - Shows **your** groups only
- `/setdestination` - Sets **your** destination group
- `/groupstats` - Shows stats for **your** groups
- `/groupleaderboard` - Shows **your** groups ranked
- `/analytics` - Shows **your** analytics
- All other commands - User-specific

---

## Database Schema Changes

The `Group` model now includes:
- `ownerId` - Links group to user
- Unique constraint: `(chatId, ownerId)` - Same group can exist for multiple users

This means:
- User A can have "Group X" as source
- User B can have "Group X" as destination
- They're completely separate in the database

---

## Migration Required

After deploying, you'll need to run a migration to add the `ownerId` field. The bot will handle this automatically if `RUN_MIGRATIONS=true` is set.

**Note**: Existing groups without owners will need to be migrated. The migration will:
1. Create owner records for existing groups (based on first interaction)
2. Or mark them as "system" groups

---

## Privacy Benefits

1. **Complete Isolation**: Your groups are invisible to other users
2. **Private Analytics**: Only you see your group/user performance
3. **Secure Forwarding**: Signals only forward to your destinations
4. **No Data Leakage**: Other users cannot access your data

---

## Future Enhancements

Possible improvements (if needed):
- Group sharing between trusted users
- Group templates/presets
- Bulk group management
- Advanced group discovery

---

**Last Updated**: January 2025


