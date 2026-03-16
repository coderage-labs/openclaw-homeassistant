/**
 * HA control tools exposed to OpenClaw agents.
 */

import type { HAWebSocket } from './websocket.js';
import type { HAState, HAArea } from './types.js';

/**
 * Register all HA tools with the OpenClaw plugin API.
 */
export function registerTools(api: any, haWs: () => HAWebSocket) {
  api.registerTool({
    name: 'ha_call_service',
    description:
      'Call a Home Assistant service to control devices. ' +
      'Examples: turn on/off lights, set climate temperature, lock/unlock doors, ' +
      'open/close covers (blinds, garage), play/pause media.',
    parameters: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Service domain (light, climate, switch, cover, lock, media_player, alarm_control_panel, etc.)',
        },
        service: {
          type: 'string',
          description: 'Service name (turn_on, turn_off, toggle, set_temperature, set_hvac_mode, open_cover, close_cover, lock, unlock, etc.)',
        },
        entity_id: {
          type: 'string',
          description: 'Target entity ID (e.g. light.garden_room, climate.bedroom)',
        },
        data: {
          type: 'object',
          description: 'Service data. Examples: {brightness: 200} for lights, {temperature: 21} for climate, {position: 50} for covers',
        },
      },
      required: ['domain', 'service', 'entity_id'],
    },
    async execute({ domain, service, entity_id, data }: {
      domain: string;
      service: string;
      entity_id: string;
      data?: Record<string, unknown>;
    }) {
      const ws = haWs();
      if (!ws.isConnected()) throw new Error('Not connected to Home Assistant');
      await ws.callService(domain, service, data ?? {}, { entity_id });
      return { success: true, message: `Called ${domain}.${service} on ${entity_id}` };
    },
  });

  api.registerTool({
    name: 'ha_get_states',
    description:
      'Get current state of Home Assistant entities. ' +
      'Returns state, attributes (temperature, brightness, etc.), and last changed time. ' +
      'Omit entity_ids to get all entities (can be large).',
    parameters: {
      type: 'object',
      properties: {
        entity_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Entity IDs to query. Omit for all entities.',
        },
      },
    },
    async execute({ entity_ids }: { entity_ids?: string[] }) {
      const ws = haWs();
      if (!ws.isConnected()) throw new Error('Not connected to Home Assistant');
      const states = await ws.getStates();
      if (entity_ids && entity_ids.length > 0) {
        const filtered = states.filter((s: HAState) => entity_ids.includes(s.entity_id));
        return filtered.map(formatState);
      }
      // Return summary for all — don't dump thousands of entities
      return {
        total: states.length,
        hint: 'Pass specific entity_ids for details. Use ha_get_areas to discover entities by room.',
      };
    },
  });

  api.registerTool({
    name: 'ha_get_areas',
    description:
      'List all Home Assistant areas (rooms) and their assigned devices/entities. ' +
      'Use this to discover what devices are in each room.',
    parameters: {
      type: 'object',
      properties: {},
    },
    async execute() {
      const ws = haWs();
      if (!ws.isConnected()) throw new Error('Not connected to Home Assistant');
      const [areas, devices] = await Promise.all([
        ws.getAreas(),
        ws.getDevices(),
      ]);
      return areas.map((area: HAArea) => ({
        id: area.area_id,
        name: area.name,
        devices: devices
          .filter((d: any) => d.area_id === area.area_id)
          .map((d: any) => ({
            name: d.name,
            manufacturer: d.manufacturer,
            model: d.model,
          })),
      }));
    },
  });

  api.registerTool({
    name: 'ha_announce',
    description:
      'Make a TTS announcement through a Home Assistant voice satellite or media player. ' +
      'Use for proactive alerts like "Someone is at the door" or "Your washing is done".',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The message to announce via TTS',
        },
        entity_id: {
          type: 'string',
          description: 'Media player entity to announce on (e.g. media_player.garden_room_voice). Omit to announce on all.',
        },
      },
      required: ['message'],
    },
    async execute({ message, entity_id }: { message: string; entity_id?: string }) {
      const ws = haWs();
      if (!ws.isConnected()) throw new Error('Not connected to Home Assistant');

      const target = entity_id
        ? { entity_id }
        : { entity_id: 'all' }; // TODO: discover satellite media_players

      await ws.callService('tts', 'speak', {
        message,
        cache: false,
      }, target);

      return { success: true, message: `Announced: "${message}"` };
    },
  });
}

/** Format a state for concise display */
function formatState(state: HAState) {
  const attrs = state.attributes;
  const info: Record<string, unknown> = {
    entity_id: state.entity_id,
    state: state.state,
  };

  // Include useful attributes based on domain
  const domain = state.entity_id.split('.')[0];
  switch (domain) {
    case 'climate':
      info.temperature = attrs.temperature;
      info.current_temperature = attrs.current_temperature;
      info.hvac_mode = state.state;
      info.hvac_action = attrs.hvac_action;
      break;
    case 'light':
      info.brightness = attrs.brightness;
      info.color_mode = attrs.color_mode;
      break;
    case 'sensor':
      info.unit = attrs.unit_of_measurement;
      info.device_class = attrs.device_class;
      break;
    case 'cover':
      info.position = attrs.current_position;
      break;
    case 'media_player':
      info.media_title = attrs.media_title;
      info.volume = attrs.volume_level;
      break;
  }

  info.friendly_name = attrs.friendly_name;
  info.last_changed = state.last_changed;
  return info;
}
