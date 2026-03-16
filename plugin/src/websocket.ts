/**
 * Home Assistant WebSocket client.
 *
 * Maintains a persistent connection to HA, handles authentication,
 * command/response tracking, and event subscriptions.
 */

import WebSocket from 'ws';
import type { HAMessage, HAResult, HAState, HAArea, HADevice, HAPluginConfig } from './types.js';

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class HAWebSocket {
  private ws: WebSocket | null = null;
  private msgId = 0;
  private pending = new Map<number, PendingCommand>();
  private eventCallbacks = new Map<number, (event: unknown) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private logger: (msg: string) => void;

  constructor(
    private config: HAPluginConfig,
    logger?: (msg: string) => void,
  ) {
    this.logger = logger ?? console.log;
  }

  /** Connect and authenticate */
  async connect(): Promise<void> {
    const wsUrl = this.config.ha_url
      .replace(/^http/, 'ws')
      .replace(/\/$/, '') + '/api/websocket';

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('message', (data) => {
        const msg: HAMessage = JSON.parse(data.toString());
        this.handleMessage(msg);
      });

      this.ws.on('open', () => {
        this.logger('[HA WebSocket] Connected');
      });

      this.ws.on('close', () => {
        this.logger('[HA WebSocket] Disconnected');
        this.connected = false;
        this.rejectAllPending(new Error('WebSocket closed'));
        this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        this.logger(`[HA WebSocket] Error: ${err.message}`);
        if (!this.connected) reject(err);
      });

      // Store resolve/reject for auth flow
      (this as any)._authResolve = resolve;
      (this as any)._authReject = reject;
    });
  }

  /** Disconnect */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.rejectAllPending(new Error('Disconnected'));
  }

  /** Send a command and wait for result */
  async send(msg: Omit<HAMessage, 'id'>, timeoutMs = 15000): Promise<unknown> {
    if (!this.ws || !this.connected) {
      throw new Error('Not connected to Home Assistant');
    }
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`HA command timeout (id=${id})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.ws!.send(JSON.stringify({ ...msg, id }));
    });
  }

  /** Call a HA service */
  async callService(
    domain: string,
    service: string,
    data: Record<string, unknown> = {},
    target: Record<string, unknown> = {},
  ): Promise<unknown> {
    return this.send({
      type: 'call_service',
      domain,
      service,
      service_data: data,
      target,
      return_response: true,
    });
  }

  /** Get all entity states */
  async getStates(): Promise<HAState[]> {
    return this.send({ type: 'get_states' }) as Promise<HAState[]>;
  }

  /** Get all areas */
  async getAreas(): Promise<HAArea[]> {
    return this.send({ type: 'config/area_registry/list' }) as Promise<HAArea[]>;
  }

  /** Get all devices */
  async getDevices(): Promise<HADevice[]> {
    return this.send({ type: 'config/device_registry/list' }) as Promise<HADevice[]>;
  }

  /** Subscribe to events */
  async subscribeEvents(
    eventType: string,
    callback: (event: unknown) => void,
  ): Promise<void> {
    const id = this.msgId + 1; // Pre-assign the ID that send() will use
    this.eventCallbacks.set(id, callback);
    await this.send({ type: 'subscribe_events', event_type: eventType });
  }

  /** Check if connected */
  isConnected(): boolean {
    return this.connected;
  }

  // --- Private ---

  private handleMessage(msg: HAMessage): void {
    switch (msg.type) {
      case 'auth_required':
        // Send auth token
        this.ws?.send(JSON.stringify({
          type: 'auth',
          access_token: this.config.ha_token,
        }));
        break;

      case 'auth_ok':
        this.connected = true;
        this.logger('[HA WebSocket] Authenticated');
        (this as any)._authResolve?.();
        break;

      case 'auth_invalid':
        this.logger(`[HA WebSocket] Auth failed: ${(msg as any).message}`);
        (this as any)._authReject?.(new Error(`HA auth failed: ${(msg as any).message}`));
        break;

      case 'result': {
        const result = msg as unknown as HAResult;
        const pending = this.pending.get(result.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(result.id);
          if (result.success) {
            pending.resolve(result.result);
          } else {
            pending.reject(new Error(result.error?.message ?? 'Unknown HA error'));
          }
        }
        break;
      }

      case 'event': {
        const id = (msg as any).id;
        const callback = this.eventCallbacks.get(id);
        if (callback) {
          callback((msg as any).event);
        }
        break;
      }
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.logger('[HA WebSocket] Reconnecting in 10s...');
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch (err) {
        this.logger(`[HA WebSocket] Reconnect failed: ${(err as Error).message}`);
        this.scheduleReconnect();
      }
    }, 10000);
  }
}
