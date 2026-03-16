/**
 * Types for the Home Assistant ↔ OpenClaw integration.
 */

/** HA WebSocket message envelope */
export interface HAMessage {
  id?: number;
  type: string;
  [key: string]: unknown;
}

/** HA auth required message */
export interface HAAuthRequired {
  type: 'auth_required';
  ha_version: string;
}

/** HA auth result */
export interface HAAuthResult {
  type: 'auth_ok' | 'auth_invalid';
  ha_version?: string;
  message?: string;
}

/** HA command result */
export interface HAResult {
  id: number;
  type: 'result';
  success: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

/** HA event message */
export interface HAEvent {
  id: number;
  type: 'event';
  event: {
    event_type: string;
    data: Record<string, unknown>;
    time_fired: string;
  };
}

/** HA entity state */
export interface HAState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

/** HA area */
export interface HAArea {
  area_id: string;
  name: string;
  aliases: string[];
}

/** HA device */
export interface HADevice {
  id: string;
  name: string | null;
  area_id: string | null;
  model: string | null;
  manufacturer: string | null;
}

/** Conversation request from HA custom component */
export interface ConversationRequest {
  text: string;
  conversation_id: string | null;
  device_id: string | null;
  satellite_id: string | null;
  area_id: string | null;
  area_name: string | null;
  language: string;
  user_id?: string;
}

/** Response back to HA custom component */
export interface ConversationResponse {
  text: string;
  conversation_id: string | null;
  continue_conversation: boolean;
}

/** Plugin config */
export interface HAPluginConfig {
  ha_url: string;
  ha_token: string;
  auto_discover_entities?: boolean;
  area_mapping?: Record<string, string>;
}
