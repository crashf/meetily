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
  /** Native notifications for auto-record events (PUN-801). */
  notifyEnabled: boolean;
  /** Append diagnostics to app_data_dir/auto_record_debug.log (PUN-801). */
  debugLogEnabled: boolean;
}

export interface AutoRecordSession {
  meeting_name: string;
  platform: string;
  trigger: string;
  started_at_ms: number;
  last_heartbeat_ms: number;
}

export interface AutoRecordDebugEntry {
  at: number;
  source: string;
  level: string;
  message: string;
}

export interface AutoRecordDiagnostics {
  config: {
    enabled: boolean;
    mode: string;
    port: number;
    tokenPrefix: string;
    notifyEnabled: boolean;
    debugLogEnabled: boolean;
  };
  serverRunning: boolean;
  recording: boolean;
  lastHeartbeatMsAgo: number | null;
  logEntries: AutoRecordDebugEntry[];
}

export interface AutoRecordStatus {
  config: AutoRecordConfig;
  enabled: boolean;
  mode: string;
  port: number;
  token: string;
  speechThreshold: number;
  notifyEnabled: boolean;
  debugLogEnabled: boolean;
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

  /** Diagnostics snapshot: config echo + server state + ring-buffer log entries. */
  async getDiagnostics(): Promise<AutoRecordDiagnostics> {
    return invoke<AutoRecordDiagnostics>('auto_record_get_diagnostics');
  },

  /** Fire a native notification immediately (plumbing test). */
  async testNotification(): Promise<{ ok: boolean }> {
    return invoke<{ ok: boolean }>('auto_record_test_notification');
  },

  /** Ask the watchdog to recycle the trigger server (manual restart button). */
  async restartServer(): Promise<{ ok: boolean }> {
    return invoke<{ ok: boolean }>('auto_record_restart_server');
  },

  /** Clear the in-memory diagnostic ring. */
  async clearDiagnostics(): Promise<{ ok: boolean }> {
    return invoke<{ ok: boolean }>('auto_record_clear_diagnostics');
  },

  /** URL the Chrome extension should be pointed at (loopback). */
  triggerUrl(port: number): string {
    return `http://127.0.0.1:${port}/trigger`;
  },
};