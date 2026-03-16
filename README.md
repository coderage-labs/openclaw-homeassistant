# openclaw-homeassistant

Connect [OpenClaw](https://github.com/openclaw/openclaw) AI agents to [Home Assistant](https://www.home-assistant.io/) voice pipeline.

Talk to your AI assistant through HA voice satellites with full context awareness — calendar, email, energy data, memory — plus native control of all your HA devices.

## What is this?

Two components that work together:

1. **OpenClaw Plugin** — registers Home Assistant as a channel in OpenClaw, connects via WebSocket, exposes HA entity control as AI tools
2. **HA Custom Integration** — registers as a conversation agent in HA's voice pipeline, bridges voice input to OpenClaw

## How it works

```
"Hey Robin, it's too warm"
    → HA Voice satellite detects wake word
    → Whisper STT transcribes speech
    → OpenClaw integration forwards to your AI agent (with area context)
    → Agent calls ha_call_service to set climate to 20°C
    → Agent responds: "Cooling the garden room to 20"
    → HA TTS speaks response through satellite
```

Your AI agent gets:
- **Area awareness** — knows which room you're speaking from
- **Full context** — calendar, email, weather, energy data, conversation memory
- **Device control** — lights, climate, covers, locks, media, alarms
- **Proactive announcements** — "Someone's at the door", "Your washing is done"

## Status

🚧 **In development** — not yet functional.

See [SPEC.md](docs/SPEC.md) for the full design document.

## Installation

### OpenClaw Plugin

```bash
# In your OpenClaw extensions directory
git clone https://github.com/coderage-labs/openclaw-homeassistant.git
```

Add to your `openclaw.json`:
```json
{
  "plugins": {
    "openclaw-homeassistant": {
      "ha_url": "http://homeassistant.local:8123",
      "ha_token": "YOUR_LONG_LIVED_ACCESS_TOKEN"
    }
  }
}
```

### HA Custom Integration

Copy `ha-integration/custom_components/openclaw/` to your HA `custom_components/` directory, then add via the HA UI: Settings → Devices & Services → Add Integration → OpenClaw.

## Tools

| Tool | Description |
|------|-------------|
| `ha_call_service` | Call any HA service (lights, climate, switches, etc.) |
| `ha_get_states` | Query entity states |
| `ha_get_areas` | List areas and their devices |
| `ha_announce` | TTS announcement on voice satellites |

## Requirements

- OpenClaw instance (any channel)
- Home Assistant 2025.1+ with voice pipeline configured
- Network connectivity between HA and OpenClaw (local or Tailscale)
- HA Long-Lived Access Token

## License

MIT
