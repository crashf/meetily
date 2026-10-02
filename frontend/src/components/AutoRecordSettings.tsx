import React, { useState, useEffect } from 'react';
import { Switch } from '@/components/ui/switch';
import { Copy, Check, RefreshCw, Loader2 } from 'lucide-react';
import {
  autoRecordService,
  AutoRecordStatus,
  AutoRecordDiagnostics,
  AutoRecordDebugEntry,
} from '@/services/autoRecordService';
import { toast } from 'sonner';

/**
 * Pund-IT fork: auto-record settings (browser extension trigger + audio gate).
 * Rendered inside the Preferences settings tab.
 */
export function AutoRecordSettings() {
  const [status, setStatus] = useState<AutoRecordStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [diag, setDiag] = useState<AutoRecordDiagnostics | null>(null);

  // Poll server status live (2s): a one-shot fetch on mount kept showing a stale
  // "Trigger server: not running" for minutes after the watchdog recovered
  // (PUN-801 field finding).
  useEffect(() => {
    let alive = true;
    const load = () =>
      autoRecordService
        .getStatus()
        .then((s) => alive && setStatus(s))
        .catch((e) => console.error('auto-record: failed to load status', e));
    load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Poll diagnostics while the debug panel is open.
  useEffect(() => {
    if (!diag) return;
    const t = setInterval(() => {
      autoRecordService
        .getDiagnostics()
        .then(setDiag)
        .catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [diag]);

  const patch = async (p: Record<string, unknown>) => {
    setSaving(true);
    try {
      const res = await autoRecordService.setConfig(p);
      if (res?.ok) {
        const fresh = await autoRecordService.getStatus();
        setStatus(fresh);
        toast.success('Auto-record settings saved');
      } else {
        toast.error('Failed to save auto-record settings');
      }
    } catch (e) {
      console.error('auto-record: save failed', e);
      toast.error('Failed to save auto-record settings');
    } finally {
      setSaving(false);
    }
  };

  if (!status) {
    return (
      <div className="px-4 py-6 text-sm text-gray-500">Loading auto-record settings…</div>
    );
  }

  const cfg = status;

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(cfg.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy token');
    }
  };

  const restartServer = async () => {
    setRestarting(true);
    try {
      await autoRecordService.restartServer();
      toast.success('Restarting trigger server…');
      // The live status poll reflects the new state within ~2s.
    } catch (e) {
      console.error('auto-record: restart failed', e);
      toast.error('Failed to restart trigger server');
    } finally {
      setTimeout(() => setRestarting(false), 2500);
    }
  };

  const copyDiag = async () => {
    if (!diag) return;
    const text = diag.logEntries
      .map((e) => `${new Date(e.at).toLocaleTimeString()} [${e.level}] ${e.source}: ${e.message}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text || '(log empty)');
      toast.success('Debug log copied');
    } catch {
      toast.error('Could not copy log');
    }
  };

  const levelColor = (level: string) =>
    level === 'error'
      ? 'text-red-600 dark:text-red-400'
      : level === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-muted-foreground';

  const renderEntry = (e: AutoRecordDebugEntry, i: number) => (
    <div key={i} className="font-mono text-[11px] leading-4 break-all">
      <span className="text-muted-foreground/70">{new Date(e.at).toLocaleTimeString()} </span>
      <span className={levelColor(e.level)}>
        [{e.source}] {e.message}
      </span>
    </div>
  );

  return (
    <div className="space-y-4 border-t pt-4 mt-4">
      <div>
        <h3 className="text-sm font-semibold">Auto-record</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Start recording automatically when a meeting is detected. Primary trigger is the
          Pund-IT browser extension (Chrome/Edge/Brave); audio detection acts as fallback for
          desktop-app meetings.
        </p>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-sm">Enable auto-record</span>
        <Switch
          checked={cfg.enabled}
          disabled={saving}
          onCheckedChange={(v) => patch({ enabled: v })}
        />
      </div>

      <div className="flex items-center justify-between">
        <span className="text-sm">Trigger mode</span>
        <select
          className="text-sm border rounded px-2 py-1 bg-background"
          value={cfg.mode}
          disabled={saving || !cfg.enabled}
          onChange={(e) => patch({ mode: e.target.value })}
        >
          <option value="extension">Extension only</option>
          <option value="hybrid">Extension + audio fallback</option>
          <option value="audio">Audio detection only</option>
        </select>
      </div>

      {cfg.mode !== 'extension' && cfg.enabled && (
        <div className="flex items-center justify-between">
          <span className="text-sm">Speech threshold (audio gate)</span>
          <input
            type="range"
            min={0.01}
            max={0.3}
            step={0.01}
            value={cfg.speechThreshold}
            disabled={saving}
            onChange={(e) => patch({ speechThreshold: Number(e.target.value) })}
            className="w-40"
          />
          <span className="text-xs text-muted-foreground w-10 text-right">
            {cfg.speechThreshold.toFixed(2)}
          </span>
        </div>
      )}

      <div className="text-xs text-muted-foreground space-y-1">
        <div>
          Trigger server: {status.serverRunning ? (
            <span className="text-green-600 dark:text-green-400">running</span>
          ) : (
            <span className="text-amber-600 dark:text-amber-400">not running</span>
          )}{' '}
          on 127.0.0.1:{cfg.port}{' '}
          <button
            type="button"
            className="inline-flex items-center ml-1 text-muted-foreground hover:text-foreground align-middle"
            onClick={restartServer}
            disabled={restarting}
            title="Restart the local trigger server (watchdog respawns it within ~1s)"
          >
            {restarting ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          </button>
        </div>
        <div>
          Extension endpoint:{' '}
          <code className="px-1 py-0.5 rounded bg-muted">
            http://127.0.0.1:{cfg.port}/trigger
          </code>
          <button
            type="button"
            className="inline-flex items-center ml-2 text-muted-foreground hover:text-foreground align-middle"
            onClick={copyToken}
            title="Copy access token"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
        <div>
          Token: <code className="px-1 py-0.5 rounded bg-muted">{cfg.token.slice(0, 8)}…</code>{' '}
          (click the icon to copy — paste into the extension options)
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-sm">Notifications</span>
        <Switch
          checked={cfg.notifyEnabled}
          disabled={saving}
          onCheckedChange={(v) => patch({ notifyEnabled: v })}
        />
      </div>
      <p className="text-xs text-muted-foreground -mt-3">
        Windows notification when a meeting is detected and recording starts or stops — this is
        how you can tell detection is working.
      </p>

      <div className="border-t pt-4 mt-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold">Debug &amp; diagnostics</span>
          <button
            type="button"
            className="text-xs border rounded px-2 py-1 hover:bg-muted"
            onClick={() => {
              if (diag) {
                setDiag(null);
              } else {
                autoRecordService
                  .getDiagnostics()
                  .then(setDiag)
                  .catch((e) => toast.error(`Diagnostics failed: ${e}`));
              }
            }}
          >
            {diag ? 'Hide' : 'Show'}
          </button>
        </div>

        {diag && (
          <div className="space-y-3 mt-3">
            <div className="flex items-center justify-between">
              <span className="text-sm">Debug log file</span>
              <Switch
                checked={cfg.debugLogEnabled}
                disabled={saving}
                onCheckedChange={(v) => patch({ debugLogEnabled: v })}
              />
            </div>
            <p className="text-xs text-muted-foreground -mt-2">
              Appends every auto-record event to{' '}
              <code className="text-[10px]">AppData\Roaming\com.meetily.ai\auto_record_debug.log</code>{' '}
              (rotates at 1 MB).
            </p>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="text-xs border rounded px-2 py-1 hover:bg-muted"
                onClick={async () => {
                  try {
                    await autoRecordService.testNotification();
                    toast.success('Notification sent — check your desktop');
                  } catch (e) {
                    toast.error(`Test failed: ${e}`);
                  }
                }}
              >
                Send test notification
              </button>
              <button
                type="button"
                className="text-xs border rounded px-2 py-1 hover:bg-muted"
                onClick={copyDiag}
              >
                Copy log
              </button>
              <button
                type="button"
                className="text-xs border rounded px-2 py-1 hover:bg-muted"
                onClick={async () => {
                  try {
                    await autoRecordService.clearDiagnostics();
                    setDiag(await autoRecordService.getDiagnostics());
                  } catch (e) {
                    toast.error(`Clear failed: ${e}`);
                  }
                }}
              >
                Clear
              </button>
            </div>

            <div className="text-xs">
              <div>
                Trigger server:{' '}
                {diag.serverRunning ? (
                  <span className="text-green-600 dark:text-green-400">running</span>
                ) : (
                  <span className="text-red-600 dark:text-red-400">NOT running</span>
                )}{' '}
                · recording: {String(diag.recording)}
                {diag.lastHeartbeatMsAgo != null && (
                  <> · last heartbeat: {Math.round(diag.lastHeartbeatMsAgo / 1000)}s ago</>
                )}
              </div>
            </div>

            <div className="rounded border bg-muted/40 p-2 max-h-64 overflow-auto space-y-0.5">
              {diag.logEntries.length === 0 ? (
                <div className="text-xs text-muted-foreground p-2">
                  Log empty. It fills when the server/gate log events — toggle debug log file ON
                  and reproduce a meeting for the full trail.
                </div>
              ) : (
                [...diag.logEntries].reverse().map(renderEntry)
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Reads as a chain: HTTP requests arriving = extension→app transport works; "recording
              started" = the recorder itself. Where the chain stops is where the fault is.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}