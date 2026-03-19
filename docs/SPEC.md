# openclaw-homeassistant — Design Spec

## Overview

Two-part integration connecting OpenClaw AI agents to Home Assistant's voice pipeline:

1. **OpenClaw Plugin** (`openclaw-homeassistant`) — registers `homeassistant` as a channel, connects to HA via WebSocket, exposes HA entity control as tools
2. **HA Custom Integration** (`custom_components/openclaw`) — registers as a conversation agent in HA, bridges voice pipeline to the OpenClaw plugin

**Repo:** `coderage-labs/openclaw-homeassistant`

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Home Assistant                         │
│                                                          │
│  ┌──────────────┐    ┌─────────────────────────────┐    │
│  │ Voice PE     │───▶│ Voice Pipeline               │    │
│  │ (satellite)  │    │  Wake Word → STT → Agent → TTS│   │
│  └──────────────┘    └──────────┬──────────────────┘    │
│                                 │                        │
│  ┌──────────────────────────────▼───────────────────┐   │
│  │ custom_components/openclaw                        │   │
│  │  ConversationEntity (registered as agent)         │   │
│  │  Forwards text + area context to OpenClaw plugin  │   │
│  │  Returns response for TTS                         │   │
│  └──────────────────────┬───────────────────────────┘   │
│                          │ WebSocket (bidirectional)      │
└──────────────────────────┼──────────────────────────────┘
                           │
┌──────────────────────────┼──────────────────────────────┐
│                    OpenClaw                               │
│                          │                                │
│  ┌───────────────────────▼──────────────────────────┐   │
│  │ openclaw-homeassistant plugin                     │   │
│  │  Channel: "homeassistant"                         │   │
│  │  Tools: ha_call_service, ha_get_state, etc.       │   │
│  │  WebSocket client → HA API                        │   │
│  └──────────────────────┬───────────────────────────┘   │
│                          │                                │
│  ┌───────────────────────▼──────────────────────────┐   │
│  │ OpenClaw Message Pipeline                         │   │
│  │  Robin receives message on "homeassistant" channel│   │
│  │  Full context: calendar, email, energy, memory    │   │
│  │  Responds → routed back to HA via plugin          │   │
│  └──────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

---

## Part 1: OpenClaw Plugin

### Registration

```javascript
// index.js
export default function homeAssistantPlugin(api) {
  // Register channel
  api.registerChannel({
    name: 'homeassistant',
    displayName: 'Home Assistant',
    // Message handling
    async send(ctx) { /* send response back to HA */ },
  });

  // Register tools for HA entity control
  api.registerTool({
    name: 'ha_call_service',
    description: 'Call a Home Assistant service (turn on lights, set climate, etc.)',
    parameters: {
      domain: { type: 'string', description: 'Service domain (light, climate, switch, etc.)' },
      service: { type: 'string', description: 'Service name (turn_on, turn_off, set_temperature, etc.)' },
      entity_id: { type: 'string', description: 'Target entity ID' },
      data: { type: 'object', description: 'Service data (brightness, temperature, etc.)' },
    },
    async execute({ domain, service, entity_id, data }) { /* WebSocket call_service */ },
  });

  api.registerTool({
    name: 'ha_get_states',
    description: 'Get current state of HA entities. Use to check device status, temperature, etc.',
    parameters: {
      entity_ids: { type: 'array', items: { type: 'string' }, description: 'Entity IDs to query (omit for all)' },
    },
    async execute({ entity_ids }) { /* WebSocket get_states, filter if entity_ids provided */ },
  });

  api.registerTool({
    name: 'ha_get_areas',
    description: 'List all areas and their devices/entities',
    parameters: {},
    async execute() { /* area_registry/list */ },
  });

  // Register service for WebSocket connection management
  api.registerService({
    name: 'homeassistant',
    async start() { /* connect to HA WebSocket, authenticate */ },
    async stop() { /* disconnect */ },
  });

  // Register HTTP route for HA custom component to connect
  api.registerHttpRoute({
    method: 'POST',
    path: '/ha/conversation',
    async handler(req, res) {
      // Receive conversation input from HA custom component
      // Inject as message on "homeassistant" channel
      // Wait for response, return it
    },
  });
}
```

### Config

```json
{
  "plugins": {
    "openclaw-homeassistant": {
      "ha_url": "http://homeassistant.local:8123",
      "ha_token": "LONG_LIVED_ACCESS_TOKEN",
      "auto_discover_entities": true,
      "area_mapping": {
        "garden_room": "Garden Room",
        "living_room": "Living Room",
        "bedroom": "Main Bedroom"
      }
    }
  }
}
```

### Session Model

**One persistent session per voice satellite/area.** Same pattern as Telegram groups.

```
Voice PE (Garden Room)  → session: "ha:satellite:garden_room"
Android phone (Bedroom) → session: "ha:satellite:bedroom"  
Kitchen tablet          → session: "ha:satellite:kitchen"
```

Each session is:
- **Persistent** — Robin remembers "you just asked me to turn the lights on" for follow-ups
- **Scoped** — garden room conversation doesn't leak into bedroom session
- **Shared agent** — same Robin, same tools, same memory across all sessions
- **Lightweight** — voice sessions don't need the full history depth of main chat

Session key format: `ha:satellite:{area_id}` (derived from satellite's assigned area).

Falls back to `ha:satellite:{device_id}` if no area is assigned, or `ha:default` as last resort.

### Message Flow (Inbound — Voice → Robin)

1. HA custom component receives voice input from pipeline
2. POSTs to OpenClaw plugin HTTP route `/ha/conversation`:
   ```json
   {
     "text": "it's too warm",
     "conversation_id": "abc-123",
     "device_id": "voice_pe_garden_room",
     "area_id": "garden_room",
     "area_name": "Garden Room",
     "satellite_id": "assist_satellite.garden_room",
     "language": "en",
     "user_id": "ha_user_id"
   }
   ```
3. Plugin resolves the session key from `area_id` → `ha:satellite:garden_room`
4. Plugin routes the message to that session on the `homeassistant` channel:
   ```javascript
   {
     channel: 'homeassistant',
     sessionKey: 'ha:satellite:garden_room',
     text: "it's too warm",
     sender: { id: 'ha_user', name: 'Chris' },
     metadata: {
       area_id: 'garden_room',
       area_name: 'Garden Room',
       device_id: 'voice_pe_garden_room',
       conversation_id: 'abc-123',
       satellite_id: 'assist_satellite.garden_room',
     }
   }
   ```
5. Robin receives the message in the garden room session, sees area context
6. Robin uses `ha_call_service` to adjust climate, responds with text
7. Plugin captures response, returns to HA custom component
8. HA feeds response text to TTS → Voice PE speaks it

**Multi-turn example:**
```
[Session: ha:satellite:garden_room]

You: "Turn on the lights"
Robin: "Garden room lights on." → ha_call_service(light, turn_on, light.garden_room)

You: "Make them dimmer"          ← Robin knows "them" = garden room lights
Robin: "Dimmed to 40%." → ha_call_service(light, turn_on, light.garden_room, {brightness: 102})

You: "What's the temperature?"
Robin: "It's 24°C in here. Want me to cool it down?"
```

### Message Flow (Outbound — Robin → HA Proactive)

Robin can also proactively push announcements to HA voice satellites:

```javascript
api.registerTool({
  name: 'ha_announce',
  description: 'Announce a message via TTS on a specific voice satellite or all satellites',
  parameters: {
    message: { type: 'string', description: 'Message to announce' },
    area: { type: 'string', description: 'Area to announce in (omit for all)' },
  },
  async execute({ message, area }) {
    // Call tts.speak service targeting the satellite media_player in the area
    await haWs.callService('tts', 'speak', {
      entity_id: getSatelliteMediaPlayer(area),
      message,
    });
  },
});
```

### WebSocket Connection Manager

```javascript
class HAWebSocket {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.ws = null;
    this.msgId = 0;
    this.pending = new Map(); // id → {resolve, reject}
  }

  async connect() {
    this.ws = new WebSocket(`${this.url}/api/websocket`);
    // Handle auth flow
    // auth_required → send auth token → auth_ok
  }

  async callService(domain, service, data = {}, target = {}) {
    return this.send({
      type: 'call_service',
      domain,
      service,
      service_data: data,
      target,
      return_response: true,
    });
  }

  async getStates() {
    return this.send({ type: 'get_states' });
  }

  async subscribeEvents(eventType, callback) {
    const id = await this.send({
      type: 'subscribe_events',
      event_type: eventType,
    });
    this.eventCallbacks.set(id, callback);
  }

  async send(msg) {
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...msg, id }));
    });
  }
}
```

---

## Part 2: HA Custom Integration

### File Structure

```
custom_components/openclaw/
├── __init__.py          # Setup, config entry
├── manifest.json        # Integration metadata
├── config_flow.py       # UI configuration flow
├── conversation.py      # ConversationEntity
├── const.py             # Constants
├── strings.json         # UI strings
└── translations/
    └── en.json
```

### manifest.json

```json
{
  "domain": "openclaw",
  "name": "OpenClaw AI Assistant",
  "codeowners": ["@coderage-labs"],
  "config_flow": true,
  "dependencies": ["conversation"],
  "documentation": "https://github.com/coderage-labs/openclaw-homeassistant",
  "iot_class": "local_push",
  "requirements": ["aiohttp>=3.9.0"],
  "version": "0.1.0"
}
```

### conversation.py — ConversationEntity

```python
"""OpenClaw conversation agent for Home Assistant."""
from __future__ import annotations

import logging
from typing import Literal

import aiohttp

from homeassistant.components import conversation
from homeassistant.components.conversation import trace
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr, area_registry as ar, intent
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, CONF_OPENCLAW_URL, CONF_OPENCLAW_TOKEN

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up OpenClaw conversation entity."""
    async_add_entities([
        OpenClawConversationEntity(hass, config_entry)
    ])


class OpenClawConversationEntity(
    conversation.ConversationEntity,
):
    """OpenClaw AI conversation agent."""

    _attr_has_entity_name = True
    _attr_name = "OpenClaw"
    _attr_supports_streaming = False  # v1: no streaming, add later

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        """Initialise."""
        self.hass = hass
        self.entry = entry
        self._openclaw_url = entry.data[CONF_OPENCLAW_URL]
        self._openclaw_token = entry.data.get(CONF_OPENCLAW_TOKEN)
        self._attr_unique_id = f"{entry.entry_id}_conversation"

    @property
    def supported_languages(self) -> list[str] | Literal["*"]:
        """All languages — OpenClaw handles translation."""
        return "*"

    async def async_added_to_hass(self) -> None:
        """Register as conversation agent."""
        await super().async_added_to_hass()
        conversation.async_set_agent(self.hass, self.entry, self)

    async def async_will_remove_from_hass(self) -> None:
        """Unregister."""
        conversation.async_unset_agent(self.hass, self.entry)
        await super().async_will_remove_from_hass()

    async def _async_handle_message(
        self,
        user_input: conversation.ConversationInput,
        chat_log: conversation.ChatLog,
    ) -> conversation.ConversationResult:
        """Forward conversation to OpenClaw and return response."""

        # Resolve area from device_id
        area_id = None
        area_name = None
        if user_input.device_id:
            dev_reg = dr.async_get(self.hass)
            device = dev_reg.async_get(user_input.device_id)
            if device and device.area_id:
                area_id = device.area_id
                area_reg = ar.async_get(self.hass)
                area = area_reg.async_get_area(device.area_id)
                area_name = area.name if area else None

        # Build request payload
        payload = {
            "text": user_input.text,
            "conversation_id": user_input.conversation_id,
            "device_id": user_input.device_id,
            "satellite_id": user_input.satellite_id,
            "area_id": area_id,
            "area_name": area_name,
            "language": user_input.language,
        }

        # POST to OpenClaw plugin
        try:
            async with aiohttp.ClientSession() as session:
                headers = {}
                if self._openclaw_token:
                    headers["Authorization"] = f"Bearer {self._openclaw_token}"

                async with session.post(
                    f"{self._openclaw_url}/ha/conversation",
                    json=payload,
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=30),
                ) as resp:
                    if resp.status != 200:
                        raise Exception(f"OpenClaw returned {resp.status}")
                    result = await resp.json()

        except Exception as err:
            _LOGGER.error("Error communicating with OpenClaw: %s", err)
            intent_response = intent.IntentResponse(language=user_input.language)
            intent_response.async_set_error(
                intent.IntentResponseErrorCode.UNKNOWN,
                "Sorry, I couldn't reach OpenClaw right now.",
            )
            return conversation.ConversationResult(
                response=intent_response,
                conversation_id=user_input.conversation_id,
            )

        # Build response
        intent_response = intent.IntentResponse(language=user_input.language)
        intent_response.async_set_speech(result.get("text", ""))

        return conversation.ConversationResult(
            response=intent_response,
            conversation_id=result.get("conversation_id", user_input.conversation_id),
            continue_conversation=result.get("continue_conversation", False),
        )
```

### config_flow.py

```python
"""Config flow for OpenClaw integration."""
import aiohttp
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.const import CONF_URL

from .const import DOMAIN, CONF_OPENCLAW_URL, CONF_OPENCLAW_TOKEN


class OpenClawConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for OpenClaw."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        """Handle the initial step."""
        errors = {}

        if user_input is not None:
            # Test connection to OpenClaw
            try:
                async with aiohttp.ClientSession() as session:
                    headers = {}
                    if user_input.get(CONF_OPENCLAW_TOKEN):
                        headers["Authorization"] = f"Bearer {user_input[CONF_OPENCLAW_TOKEN]}"
                    async with session.get(
                        f"{user_input[CONF_OPENCLAW_URL]}/ha/ping",
                        headers=headers,
                        timeout=aiohttp.ClientTimeout(total=5),
                    ) as resp:
                        if resp.status != 200:
                            errors["base"] = "cannot_connect"
            except Exception:
                errors["base"] = "cannot_connect"

            if not errors:
                return self.async_create_entry(
                    title="OpenClaw",
                    data=user_input,
                )

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({
                vol.Required(CONF_OPENCLAW_URL, default="http://localhost:3000"): str,
                vol.Optional(CONF_OPENCLAW_TOKEN): str,
            }),
            errors=errors,
        )
```

---

## Part 3: Tools Exposed to Robin

### Core Tools

| Tool | Description | Example |
|------|-------------|---------|
| `ha_call_service` | Call any HA service | Turn on lights, set climate temp, lock doors |
| `ha_get_states` | Query entity states | "What's the garden room temperature?" |
| `ha_get_areas` | List areas + entities | Know what's in each room |
| `ha_announce` | TTS announcement on satellites | "Someone's at the door" |
| `ha_subscribe` | Subscribe to state changes | React to events in real-time |

### Smart Tool Wrappers (convenience)

| Tool | Maps to |
|------|---------|
| `ha_lights` | `light.turn_on/off` with brightness, color, transition |
| `ha_climate` | `climate.set_temperature`, `set_hvac_mode` |
| `ha_media` | `media_player.play_media`, volume, etc. |
| `ha_alarm` | `alarm_control_panel.arm_home/away/disarm` |
| `ha_cover` | `cover.open/close/set_position` (blinds, garage) |

### Context Injection

On each voice message, inject area-relevant state into the system prompt:
```
[Home Assistant Context]
Area: Garden Room
- climate.garden_room: 24°C (cooling, target 21°C)
- light.garden_room_desk: on (brightness 80%)
- binary_sensor.garden_room_presence: detected
- sensor.garden_room_humidity: 55%
```

This gives Robin ambient awareness without needing to call `ha_get_states` every time.

---

## Repo Structure

```
openclaw-homeassistant/
├── README.md
├── LICENSE (MIT)
├── plugin/                          # OpenClaw plugin
│   ├── package.json
│   ├── openclaw.plugin.json
│   ├── src/
│   │   ├── index.ts                 # Plugin entry point
│   │   ├── channel.ts               # Channel registration
│   │   ├── websocket.ts             # HA WebSocket client
│   │   ├── tools.ts                 # HA control tools
│   │   └── types.ts                 # TypeScript types
│   └── tsconfig.json
├── ha-integration/                  # HA custom component
│   └── custom_components/
│       └── openclaw/
│           ├── __init__.py
│           ├── manifest.json
│           ├── config_flow.py
│           ├── conversation.py
│           ├── const.py
│           ├── strings.json
│           └── translations/
│               └── en.json
└── docs/
    ├── setup.md                     # Installation guide
    ├── configuration.md             # Config reference
    └── development.md               # Contributing guide
```

---

## MVP Scope (v0.1.0)

### In
- [ ] OpenClaw plugin: channel registration, HTTP endpoint, HA WebSocket client
- [ ] HA integration: ConversationEntity, config flow, connection test
- [ ] Tools: `ha_call_service`, `ha_get_states`, `ha_get_areas`, `ha_announce`
- [ ] Area context passed from satellite → Robin
- [ ] Area-relevant state injection in system prompt
- [ ] Persistent sessions per satellite/area (multi-turn conversation)
- [ ] Reconnection/error handling on WebSocket

### Out (v0.2.0+)
- [ ] **Voice context switching** — switch session context via voice command
- [ ] Streaming responses
- [ ] Event subscriptions (state_changed → proactive notifications)
- [ ] Entity auto-discovery and smart tool generation
- [ ] Voice ID (speaker recognition)
- [ ] Media player control / music
- [ ] Dashboard/Lovelace card showing Robin status
- [ ] HACS store submission

---

## Adaptive TTS Routing (v0.1.0)

### Problem
Piper (local) is fast and free but lacks emotional expressiveness. Cloud TTS (OpenAI, ElevenLabs)
sounds natural but costs money and adds latency. Most home automation responses don't need
expressiveness, but conversational replies do.

### Solution
Robin tags responses with TTS hints. The plugin parses the tag, routes to the appropriate
TTS engine, and strips the tag before speaking.

### Tags

| Tag | Routes to | Use case |
|-----|-----------|----------|
| *(no tag)* | Piper (local, default) | Short confirmations: "Lights on", "Set to 20 degrees" |
| `[expressive]` | OpenAI TTS / ElevenLabs | Conversational, emotional, jokes, storytelling, morning briefings |
| `[whisper]` | Piper low volume / soft voice | Night mode, quiet hours |
| `[urgent]` | Piper with alert tone prefix | Security alerts, alarms, critical notifications |
| `[announce]` | Piper/cloud on ALL satellites | House-wide announcements ("Someone's at the door") |

Tags can be combined: `[urgent][announce] Motion detected on the driveway at 2am`

### How Robin Knows It's Voice

The plugin injects voice context into the session's system prompt automatically:

```
You are responding via voice through a Home Assistant satellite
in the {area_name}. Keep responses concise and spoken-word friendly
(no markdown, no URLs, no formatting).

TTS routing tags (optional, place at start of response):
- [expressive] — use for conversational/emotional responses (cloud TTS)
- [whisper] — quiet/night mode
- [urgent] — prefix with alert tone
- [announce] — play on all satellites
Default (no tag) uses fast local TTS — best for short confirmations.
```

This system prompt fragment is injected by the plugin when `input_type: "voice"`.
Robin doesn't need to know about TTS engines — it just sees the prompt and tags naturally.

### Plugin Processing

```typescript
interface TTSRouting {
  engine: 'piper' | 'openai' | 'elevenlabs';
  volume?: 'normal' | 'low';
  alertTone?: boolean;
  broadcast?: boolean;
}

function parseTTSTags(text: string): { routing: TTSRouting; cleanText: string } {
  const tags = new Set<string>();
  let clean = text;

  // Extract all tags from start of response
  const tagPattern = /^\[(\w+)\]\s*/;
  let match;
  while ((match = tagPattern.exec(clean))) {
    tags.add(match[1]);
    clean = clean.slice(match[0].length);
  }

  const routing: TTSRouting = {
    engine: tags.has('expressive') ? config.expressiveEngine : 'piper',
    volume: tags.has('whisper') ? 'low' : 'normal',
    alertTone: tags.has('urgent'),
    broadcast: tags.has('announce'),
  };

  return { routing, cleanText: clean };
}
```

### Config

```json
{
  "tts": {
    "default_engine": "piper",
    "expressive_engine": "openai",
    "openai_voice": "nova",
    "openai_api_key": "sk-...",
    "whisper_volume": 0.3,
    "urgent_alert_sound": "/media/alert.mp3"
  }
}
```

### Voice-Aware Response Style

When responding via voice, Robin should:
- Keep it concise — no walls of text
- No markdown, bullet points, tables, or URLs
- Use natural spoken language ("twenty degrees" not "20°C")
- Round numbers ("about two hours" not "1 hour 47 minutes")
- Front-load the answer — say the important thing first

The system prompt fragment handles this automatically.

---

## Voice Context Switching (v0.2.0)

### Problem
Each satellite has a dedicated HA session (`ha:satellite:garden_room`) scoped to home automation.
But the user may want to ask dev/work/personal questions from the same satellite without
polluting the HA session with irrelevant context (and vice versa).

### Solution
Voice commands to switch the active session context for a satellite:

```
"Hey Robin, developer mode"     → routes to ha:context:dev:{area}
"Hey Robin, home mode"          → routes back to ha:satellite:{area} (default)
"Hey Robin, personal mode"      → routes to ha:context:personal:{area}
```

### Session Routing

Each satellite can route to multiple session contexts:

```
ha:satellite:garden_room          ← default (home automation)
ha:context:dev:garden_room        ← dev/work context
ha:context:personal:garden_room   ← personal (calendar, email, etc.)
```

The plugin tracks the **active context** per satellite. On a context switch command:
1. Plugin intercepts the command (doesn't forward to agent)
2. Updates the active context mapping for that satellite
3. Confirms via TTS: "Switched to developer mode"
4. All subsequent messages from that satellite route to the new session
5. Auto-revert to home mode after configurable timeout (e.g. 15 min idle)

### Implementation

```typescript
// Per-satellite active context tracking
const activeContext = new Map<string, string>();
// Default: 'home' for all satellites

// Context switch detection (before routing to agent)
function detectContextSwitch(text: string): string | null {
  const patterns = [
    { match: /\b(developer|dev|coding|work)\s*mode\b/i, context: 'dev' },
    { match: /\b(home|house|automation)\s*mode\b/i, context: 'home' },
    { match: /\b(personal|private)\s*mode\b/i, context: 'personal' },
  ];
  for (const p of patterns) {
    if (p.match.test(text)) return p.context;
  }
  return null;
}

// Session key resolution
function getSessionKey(areaId: string, context: string): string {
  if (context === 'home') return `ha:satellite:${areaId}`;
  return `ha:context:${context}:${areaId}`;
}
```

### Auto-revert
- After 15 minutes of no voice input, revert to `home` context
- Configurable per-satellite timeout
- Prevents stale dev sessions from confusing home automation commands the next morning

### Context Indicators
- TTS confirmation on switch: "Developer mode" / "Home mode"
- Optional: HA entity `select.{area}_robin_context` exposed in dashboard
- Optional: LED colour change on Voice PE (if supported via HA automation)

### What each context gets

| Context | Session scope | Tools available |
|---------|--------------|-----------------|
| **home** | HA commands, device history | All HA tools + general (calendar, weather) |
| **dev** | Dev conversation, code discussion | All tools (HA + dev). History stays dev-focused |
| **personal** | Email, calendar, personal queries | All tools. History stays personal |

All contexts share the same agent (Robin) and the same capabilities — it's purely
the conversation history that stays scoped and clean.

---

## Security

- HA Long-Lived Access Token stored in OpenClaw config (encrypted at rest)
- Plugin HTTP endpoint authenticated via Bearer token
- HA custom component validates OpenClaw URL at setup
- No sensitive data (passwords, tokens) logged
- WebSocket connection uses TLS when available

---

## Network Topology

```
[HA on Dell OptiPlex] ←──WebSocket──→ [OpenClaw on Hostinger/Mac Mini]
         │                                        │
    (local LAN)                            (Tailscale tunnel)
         │                                        │
   [Voice PE]                              [Telegram, etc.]
   [Zigbee/Z-Wave]
   [Cameras]
```

HA and OpenClaw may not be on the same machine initially (OpenClaw on Hostinger, HA on Dell at home). Tailscale tunnel bridges them. Long-term (Mac Mini), both could be local.

---

*Last updated: 16 March 2026*
