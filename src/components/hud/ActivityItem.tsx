// HUD generic activity/event item — the unified small-event shape for the
// right activity rail (mission requirement 9). Deliberately NOT an
// exhaustive log: callers keep only a short recent list.
import type { WidgetStatus } from './StatusIndicator';
import StatusIndicator from './StatusIndicator';

export interface HudActivityEvent {
  id: string;
  module: string;
  type: string;
  label: string;
  status: WidgetStatus;
  timestamp: number;
}

export function formatRelativeTime(timestampMs: number, now = Date.now()): string {
  const diffSeconds = Math.max(0, Math.round((now - timestampMs) / 1000));
  if (diffSeconds < 60) return 'à l\'instant';
  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return `il y a ${diffMinutes} min`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `il y a ${diffHours} h`;
  const diffDays = Math.round(diffHours / 24);
  return `il y a ${diffDays} j`;
}

export default function ActivityItem({ event, now }: { event: HudActivityEvent; now?: number }) {
  return (
    <li className="hud2-activity-item">
      <StatusIndicator status={event.status} compact />
      <span className="hud2-activity-item-module">{event.module}</span>
      <span className="hud2-activity-item-label">{event.label}</span>
      <time className="hud2-activity-item-time" dateTime={new Date(event.timestamp).toISOString()}>
        {formatRelativeTime(event.timestamp, now)}
      </time>
    </li>
  );
}
