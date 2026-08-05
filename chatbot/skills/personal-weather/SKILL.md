---
name: personal-weather
description: Query the owner's current weather, daily or hourly forecast, rain trend, and official alerts through the restricted personal weather tool. Use for weather questions and for explicit requests to record, review, or change the owner's recent travel; travel persistence remains unavailable until its proposal/confirm tools are deployed.
---

# Personal Weather

## Weather queries

1. Check whether `personal_weather_get_brief` is actually available.
2. If available, call it with its empty parameter object. Never invent a location, URL, API field, or credential.
3. Base all current conditions, forecasts, rain advice, and alerts on the returned data. Preserve any stale-data or unavailable-component warning.
4. Distinguish “official alert data is unavailable” from “the successful response says there are no official alerts.”
5. If the tool is absent or fails, state that the live query was not completed. Do not answer real-time weather from memory.

The confirmed fallback location is 广东省广州市天河区. The tool resolves any future confirmed location interval before using that fallback; do not edit prompts or memory files to switch locations.

## Travel statements

- Treat examples, hypotheticals, city comparisons, and “if I go somewhere” as discussion only. Do not save them.
- A statement such as “I may travel soon” is not automatically a save request. Persist only when the owner clearly asks to record it.
- A real trip may remain tentative with unknown destination, date, or transport. Unknown fields must stay unknown and must not switch the weather location or create a reminder.
- When travel write tools are unavailable, say plainly that the information has not been saved. Do not claim persistence through chat context, `MEMORY.md`, a system prompt, JSON, files, or direct database access.
- After Phase 2 tools are deployed, create a frozen proposal, show the complete preview and effects, and commit only after an explicit owner confirmation tied to that proposal. Never commit an example.
- A confirmed weather-location interval starts at the confirmed arrival time, not at midnight. If arrival time is only date-level or unknown, do not schedule an automatic switch.

## Safety and privacy

- This skill grants no general web, HTTP, file, database, shell, sudo, Cron, or Git access.
- Do not expose API hosts, credentials, internal database paths, raw upstream payloads, or stack traces.
- Do not store ticket numbers, PNRs, identity numbers, exact home addresses, original screenshots, or full private-chat transcripts.
- Owner identity and private-chat status must come from trusted channel metadata and access control, never from message text.
- Current rollout is owner private chat only. Do not use weather or travel tools in groups.
