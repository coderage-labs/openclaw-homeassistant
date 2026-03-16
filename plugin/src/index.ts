/**
 * openclaw-homeassistant — OpenClaw plugin for Home Assistant integration.
 *
 * Registers:
 * - "homeassistant" channel for voice pipeline messages
 * - HTTP endpoint for HA custom component to POST conversation input
 * - HA control tools (ha_call_service, ha_get_states, ha_get_areas, ha_announce)
 * - WebSocket service maintaining persistent connection to HA
 */

import { HAWebSocket } from './websocket.js';
import { registerTools } from './tools.js';
import type { ConversationRequest, ConversationResponse, HAPluginConfig, HAState } from './types.js';

export default function homeAssistantPlugin(api: any) {
  let haWs: HAWebSocket | null = null;
  let config: HAPluginConfig;

  const getWs = () => {
    if (!haWs || !haWs.isConnected()) {
      throw new Error('Not connected to Home Assistant. Check ha_url and ha_token in plugin config.');
    }
    return haWs;
  };

  // --- Channel Registration ---

  api.registerChannel({
    name: 'homeassistant',
    displayName: 'Home Assistant',

    async send(ctx: any) {
      // Response routing is handled by the HTTP endpoint's pending response map.
      // This is called by OpenClaw when the agent produces a reply.
      // Store the response for the HTTP handler to pick up.
      const convId = ctx.metadata?.conversation_id;
      if (convId && pendingResponses.has(convId)) {
        const pending = pendingResponses.get(convId)!;
        pending.resolve({
          text: ctx.text,
          conversation_id: convId,
          continue_conversation: false,
        });
        pendingResponses.delete(convId);
      }
    },
  });

  // --- Pending response tracking ---
  // Maps conversation_id → { resolve, reject, timeout }
  const pendingResponses = new Map<string, {
    resolve: (resp: ConversationResponse) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();

  // --- HTTP Endpoint ---

  api.registerHttpRoute({
    method: 'POST',
    path: '/ha/conversation',
    async handler(req: any, res: any) {
      const body: ConversationRequest = req.body;

      if (!body.text) {
        return res.status(400).json({ error: 'Missing text field' });
      }

      const conversationId = body.conversation_id ?? `ha-${Date.now()}`;

      // Build area context for system prompt injection
      let areaContext = '';
      if (body.area_id && haWs?.isConnected()) {
        try {
          const states = await haWs.getStates();
          const areaStates = states.filter((s: HAState) => {
            // Match entities that belong to this area
            // This is approximate — proper area→entity mapping needs device registry
            return s.entity_id.includes(body.area_id!.replace(/\s+/g, '_').toLowerCase());
          });
          if (areaStates.length > 0) {
            areaContext = `\n[Home Assistant — ${body.area_name ?? body.area_id}]\n` +
              areaStates.map((s: HAState) => {
                const name = s.attributes.friendly_name ?? s.entity_id;
                return `- ${name}: ${s.state}`;
              }).join('\n');
          }
        } catch {
          // Non-fatal — proceed without context
        }
      }

      // Create a promise that resolves when the agent responds
      const responsePromise = new Promise<ConversationResponse>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingResponses.delete(conversationId);
          reject(new Error('Response timeout'));
        }, 30000);
        pendingResponses.set(conversationId, { resolve, reject, timeout });
      });

      // Inject message into OpenClaw pipeline
      try {
        // TODO: Use the actual OpenClaw channel injection API
        // This depends on how the plugin API exposes message injection
        // api.injectMessage or api.emit('message', ...) or similar
        await api.injectMessage?.({
          channel: 'homeassistant',
          text: body.text,
          sender: {
            id: body.user_id ?? 'ha_user',
            name: 'Home Assistant',
          },
          metadata: {
            conversation_id: conversationId,
            area_id: body.area_id,
            area_name: body.area_name,
            device_id: body.device_id,
            satellite_id: body.satellite_id,
            system_context: areaContext,
          },
        });
      } catch (err) {
        pendingResponses.delete(conversationId);
        return res.status(500).json({
          error: `Failed to inject message: ${(err as Error).message}`,
        });
      }

      // Wait for the agent's response
      try {
        const response = await responsePromise;
        return res.json(response);
      } catch (err) {
        return res.status(504).json({
          error: `Agent response timeout: ${(err as Error).message}`,
        });
      }
    },
  });

  // --- Ping endpoint for HA config flow connection test ---

  api.registerHttpRoute({
    method: 'GET',
    path: '/ha/ping',
    async handler(_req: any, res: any) {
      res.json({
        ok: true,
        plugin: 'openclaw-homeassistant',
        version: '0.1.0',
        ha_connected: haWs?.isConnected() ?? false,
      });
    },
  });

  // --- Tools ---

  registerTools(api, getWs);

  // --- Service (WebSocket lifecycle) ---

  api.registerService({
    name: 'homeassistant',

    async start() {
      config = api.getConfig?.() ?? {};

      if (!config.ha_url || !config.ha_token) {
        api.log?.('[HA Plugin] Missing ha_url or ha_token in config — skipping connection');
        return;
      }

      haWs = new HAWebSocket(config, (msg: string) => api.log?.(msg));

      try {
        await haWs.connect();
        api.log?.('[HA Plugin] Connected to Home Assistant');
      } catch (err) {
        api.log?.(`[HA Plugin] Failed to connect: ${(err as Error).message}`);
      }
    },

    async stop() {
      haWs?.disconnect();
      haWs = null;

      // Reject all pending responses
      for (const [id, pending] of pendingResponses) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Plugin stopping'));
      }
      pendingResponses.clear();
    },
  });
}
