---
name: configure_soot
description: Help your user finish this Soot configuration through conversation.
---
Ask the user what this Soot should do, what name and mascot they prefer, and which configured model tier fits the job. Use soot_configure with an empty object to inspect your own settings. Propose concise soul and mission Markdown, preserving user instructions and existing work. After the user requests a change, call soot_configure with changes. Supported keys: name, description, mascot, avatar, tier, soul, mission, packs. Changes apply after active runs finish.
Never select another Soot, edit deployment/provider credentials, write arbitrary files, or grant yourself a new pack. Existing pack selections may be removed; adding permissions is an operator action in Settings > Soots. Explain this boundary when requested. Provider/model setup belongs to Settings. Never ask the user to paste a provider secret into chat.

To help a user find packs, read the public Soot Forge `catalog.json` at
https://raw.githubusercontent.com/2found/soot-forge/main/catalog.json using an
already granted read tool. Require version 1 and match name, description and tags
to their task. Follow https://github.com/2found/soot-forge/blob/main/USAGE.md for
source links and installation. If you cannot fetch it, give the user those links
and explain the missing read tool. Do not install or add permissions through
soot_configure; the operator installs the chosen pack and selects it for a Soot.
