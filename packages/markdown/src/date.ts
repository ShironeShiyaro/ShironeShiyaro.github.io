/**
 * Asia/Shanghai calendar date and file timestamp helpers.
 *
 * The publication date is always a server-derived calendar day; the author UI
 * never offers a date input. `Intl.DateTimeFormat` gives the same result in
 * Node (unit tests), Cloudflare Workers (mock API) and browsers (preview).
 */

export const AUTHOR_TIME_ZONE = 'Asia/Shanghai';

export interface ShanghaiTimestamp {
  /** Calendar date in Asia/Shanghai, `YYYY-MM-DD`. */
  date: string;
  /** Clock time in Asia/Shanghai, `HH-mm-ss` (safe inside a file name). */
  time: string;
  /** Combined `YYYY-MM-DD-HH-mm-ss` file-name timestamp. */
  timestamp: string;
}

let formatter: Intl.DateTimeFormat | undefined;

function shanghaiFormatter(): Intl.DateTimeFormat {
  formatter ??= new Intl.DateTimeFormat('en-CA', {
    timeZone: AUTHOR_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  return formatter;
}

function assertInstant(instant: Date | number): number {
  const milliseconds = instant instanceof Date ? instant.getTime() : instant;
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError('The publication instant is not a valid date.');
  }
  return milliseconds;
}

/** Returns the Asia/Shanghai date and file timestamp for an instant. */
export function getShanghaiTimestamp(instant: Date | number): ShanghaiTimestamp {
  const parts = shanghaiFormatter().formatToParts(new Date(assertInstant(instant)));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get('year') ?? '';
  const month = values.get('month') ?? '';
  const day = values.get('day') ?? '';
  const hour = values.get('hour') ?? '';
  const minute = values.get('minute') ?? '';
  const second = values.get('second') ?? '';
  const date = `${year}-${month}-${day}`;
  const time = `${hour}-${minute}-${second}`;
  return { date, time, timestamp: `${date}-${time}` };
}

/** Returns the Asia/Shanghai calendar date (`YYYY-MM-DD`) for an instant. */
export function getShanghaiDate(instant: Date | number): string {
  return getShanghaiTimestamp(instant).date;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in `YYYY-MM-DD` form (2026-02-30 is rejected). */
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
