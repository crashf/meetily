// Auto-record service: settings bridge between the React UI and the Rust auto_record module.
import { invoke } from '@tauri-apps/api/core';

export interface AutoRecordConfig {
  enabled: boolean;
  /** "extension" | "audio" | "hybrid" */
  mode: string;
  port: number;
  token: string;
  speechThreshold: number;
  autoStartEnabled: boolean;
}

export interface AutoRecordSession {
  meeting_name: string;
  platform: string;
  trigger: string;
  started_at_ms: number;
  last_heartbeat_ms: number;
}

export interface AutoRecordStatus {
  config: AutoRecordConfig;
  enabled: boolean;
  mode: string;
  port: number;
  token: string;
  speechThreshold: number;
  serverRunning: boolean;
  recording: boolean;
  session: AutoRecordSession | null;
  lastHeartbeatMsAgo: number | null;
}

export const autoRecordService = {
  async getStatus(): Promise<AutoRecordStatus> {
    return invoke<AutoRecordStatus>('auto_record_get_status');
  },

  /** Partial patch: any subset of AutoRecordConfig fields. */
  async setConfig(patch: Partial<AutoRecordConfig>): Promise<{ ok: boolean }> {
    return invoke<{ ok: boolean }>('auto_record_set_config', { patch });
  },

  /** URL the Chrome extension should be pointed at (loopback). */
  triggerUrl(port: number): string {
    return `http://127.0.0.1:${port}/trigger`;
  },
};