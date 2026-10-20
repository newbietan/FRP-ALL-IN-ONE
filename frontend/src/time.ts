/** Format Unix seconds (API), milliseconds or ISO dates in the browser's local time. */
export function formatLastSeen(value: number | string | null | undefined): string {
  if (value == null || (typeof value === 'string' && !value.trim())) return '-';

  const numeric = typeof value === 'number' || /^-?\d+(\.\d+)?$/.test(value.trim());
  let date: Date;
  if (numeric) {
    const timestamp = Number(value);
    // Zero means this device has never reported a heartbeat.
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '-';
    date = new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
  } else {
    date = new Date(value);
  }
  if (!Number.isFinite(date.getTime())) return '-';

  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
