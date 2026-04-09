# SiteShrimp OpenClaw Skill — Setup Guide

## Overview

This skill gives OpenClaw **read-only** access to your SiteShrimp defect data.
OpenClaw can query, summarize, and report on defects — but CANNOT modify any data.

## Architecture

```
OpenClaw ── READ ONLY ──▶ PocketBase ◀── READ/WRITE ── SiteShrimp App
                                     ◀── READ/WRITE ── SiteShrimp Telegram Bot
```

## Step 1: Create a Read-Only User in PocketBase

1. Open your PocketBase admin panel: `https://your-pb-url/_/`
2. Go to **Collections** → **users**
3. Click **New Record** and create a user:
   - Email: `openclaw-readonly@yourcompany.com`
   - Password: (generate a strong password)
   - Name: `OpenClaw (Read-Only)`
4. Note the email and password — you'll need them to generate a token

## Step 2: Set PocketBase Collection Rules (IMPORTANT)

By default, PocketBase users have full access. You MUST restrict the read-only user.

1. In PocketBase admin → **Collections** → **defects**
2. Click the **gear icon** (API Rules)
3. Under **List/Search rule** and **View rule**, these should allow authenticated users:
   ```
   @request.auth.id != ""
   ```
4. Under **Create rule**, **Update rule**, and **Delete rule**, add a restriction
   that blocks the read-only user:
   ```
   @request.auth.email != "openclaw-readonly@yourcompany.com"
   ```
5. Repeat for other collections: **projects**, **members**, **comments**

This ensures the OpenClaw user can read but never write, even if the AI somehow
attempts a POST/PATCH/DELETE request.

## Step 3: Generate an API Token

```bash
# Replace with your PocketBase URL, email, and password
curl -X POST https://your-pb-url/api/collections/users/auth-with-password \
  -H "Content-Type: application/json" \
  -d '{"identity":"openclaw-readonly@yourcompany.com","password":"your-password"}'
```

Copy the `token` from the response.

## Step 4: Configure OpenClaw

Add to your `~/.openclaw/openclaw.json`:

```json5
{
  skills: {
    entries: {
      "siteshrimp": {
        enabled: true,
        env: {
          SITESHRIMP_PB_URL: "https://your-pocketbase-url.com",
          SITESHRIMP_PB_TOKEN: "paste-your-token-here"
        }
      }
    }
  }
}
```

## Step 5: Install the Skill

Copy the SKILL.md file to OpenClaw's skills directory:

```bash
# Create skill directory
mkdir -p ~/.openclaw/skills/siteshrimp

# Copy the skill file
cp SKILL.md ~/.openclaw/skills/siteshrimp/SKILL.md
```

Restart OpenClaw gateway to load the new skill:

```bash
openclaw gateway
```

## Step 6: Test

In your Telegram group (where OpenClaw is connected), try:

- "How many open defects are there?"
- "Show me critical defects"
- "What's the total cost impact?"
- "Try to delete a defect" ← should REFUSE

## Security Checklist

- [ ] Read-only PocketBase user created
- [ ] Collection API rules block write access for read-only user
- [ ] Token stored securely in OpenClaw config (not shared)
- [ ] Tested that OpenClaw refuses write requests
- [ ] SiteShrimp app and Telegram bot use separate (full-access) credentials

## Token Refresh

PocketBase tokens expire. To auto-refresh, you can run a cron job:

```bash
# Add to crontab (refreshes every 12 hours)
0 */12 * * * curl -s -X POST https://your-pb-url/api/collections/users/auth-refresh \
  -H "Authorization: Bearer $(cat ~/.openclaw/siteshrimp-token)" \
  | jq -r '.token' > ~/.openclaw/siteshrimp-token
```

Or configure OpenClaw's cron system to refresh the token automatically.

## Troubleshooting

**"Skill not loaded"**
- Check: `openclaw status --deep` to see if skill is listed
- Verify env vars are set: `SITESHRIMP_PB_URL` and `SITESHRIMP_PB_TOKEN`

**"API error 401"**
- Token expired — regenerate with Step 3
- Wrong PocketBase URL — check the URL is reachable

**"API error 403"**
- Collection rules are blocking access — check Step 2
- Ensure the read-only user has List/View permissions

**OpenClaw tries to modify data**
- The SKILL.md has strict guardrails — if this happens, report it
- PocketBase API rules (Step 2) are the hard enforcement layer
- The skill instructions are the soft layer — AI should follow them
- Both layers together provide defense-in-depth
