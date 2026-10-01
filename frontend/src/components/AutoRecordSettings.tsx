import React, { useState, useEffect } from 'react';
import { Switch } from '@/components/ui/switch';
import { Copy, Check } from 'lucide-react';
import { autoRecordService, AutoRecordStatus } from '@/services/autoRecordService';
import { toast } from 'sonner';

/**
 * Pund-IT fork: auto-record settings (browser extension trigger + audio gate).
 * Rendered inside the Preferences settings tab.
 */
export function AutoRecordSettings() {
  const [status, setStatus] = useState<AutoRecordStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    autoRecordService
      .getStatus()
      .then(setStatus)
      .catch((e) => console.error('auto-record: failed to load status', e));
  }, []);

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
          on 127.0.0.1:{cfg.port}
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
    </div>
  );
}