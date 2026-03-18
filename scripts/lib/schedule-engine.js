const WEEKDAY_ALIASES = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

const MONTH_ALIASES = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

const formatterCache = new Map();

function getFormatter(timeZone) {
  const key = timeZone || 'UTC';
  if (!formatterCache.has(key)) {
    formatterCache.set(key, new Intl.DateTimeFormat('en-US', {
      timeZone: key,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    }));
  }
  return formatterCache.get(key);
}

function getTimeZoneParts(date, timeZone) {
  const parts = getFormatter(timeZone).formatToParts(date);
  const map = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return {
    year: Number.parseInt(map.year, 10),
    month: Number.parseInt(map.month, 10),
    day: Number.parseInt(map.day, 10),
    hour: Number.parseInt(map.hour, 10),
    minute: Number.parseInt(map.minute, 10),
    weekday: WEEKDAY_ALIASES[String(map.weekday || '').toUpperCase()],
    localDate: `${map.year}-${map.month}-${map.day}`,
  };
}

function shiftDate(dateKey, deltaDays) {
  const base = new Date(`${dateKey}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + deltaDays);
  return base.toISOString().slice(0, 10);
}

function parseDurationMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value || '').trim();
  const match = text.match(/^(\d+)(ms|s|m|h|d)$/i);
  if (!match) {
    throw new Error(`Invalid duration: ${value}`);
  }

  const amount = Number.parseInt(match[1], 10);
  const multipliers = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  return amount * multipliers[match[2].toLowerCase()];
}

function normalizeAlias(value, aliases = {}) {
  const upper = String(value).toUpperCase();
  if (Object.prototype.hasOwnProperty.call(aliases, upper)) {
    return aliases[upper];
  }
  return Number.parseInt(value, 10);
}

function expandRange(base, min, max, aliases, normalizer = (value) => value) {
  if (base === '*') {
    return Array.from({ length: max - min + 1 }, (_, index) => min + index);
  }

  if (base.includes('-')) {
    const [rawStart, rawEnd] = base.split('-');
    const start = normalizer(normalizeAlias(rawStart, aliases));
    const end = normalizer(normalizeAlias(rawEnd, aliases));
    const values = [];
    for (let value = start; value <= end; value += 1) {
      values.push(value);
    }
    return values;
  }

  return [normalizer(normalizeAlias(base, aliases))];
}

function parseCronField(fieldText, min, max, aliases = {}, normalizer = (value) => value) {
  const values = new Set();

  for (const segment of String(fieldText).split(',')) {
    const [rangeText, stepText] = segment.split('/');
    const step = stepText ? Number.parseInt(stepText, 10) : 1;
    const baseValues = expandRange(rangeText, min, max, aliases, normalizer);
    if (rangeText === '*') {
      for (const value of baseValues) {
        if ((value - min) % step === 0) values.add(value);
      }
      continue;
    }
    for (const value of baseValues) {
      if (value >= min && value <= max) values.add(value);
    }
  }

  return values;
}

function parseCronExpression(expr) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Only 5-field cron expressions are supported in workflow schedules: ${expr}`);
  }

  return {
    minute: parseCronField(fields[0], 0, 59),
    hour: parseCronField(fields[1], 0, 23),
    day: parseCronField(fields[2], 1, 31),
    month: parseCronField(fields[3], 1, 12, MONTH_ALIASES),
    weekday: parseCronField(fields[4], 0, 6, WEEKDAY_ALIASES, (value) => (value === 7 ? 0 : value)),
  };
}

function isScheduleEnabled(schedule) {
  return schedule.enabled !== false && schedule.enabledByDefault !== false;
}

function countsTowardExpected(schedule) {
  if (typeof schedule.countsTowardExpected === 'boolean') return schedule.countsTowardExpected;
  return schedule.kind !== 'at';
}

function getScheduleTimeZone(schedule) {
  return schedule.timezone || 'UTC';
}

function getWindowBoundsForDate(dateKey) {
  return {
    start: Date.parse(`${dateKey}T00:00:00.000Z`) - (36 * 60 * 60 * 1000),
    end: Date.parse(`${dateKey}T23:59:00.000Z`) + (36 * 60 * 60 * 1000),
  };
}

function listCronOccurrencesForDate(workflowId, schedule, dateKey) {
  const parsed = parseCronExpression(schedule.cron);
  const timeZone = getScheduleTimeZone(schedule);
  const { start, end } = getWindowBoundsForDate(dateKey);
  const occurrences = [];

  for (let current = start; current <= end; current += 60 * 1000) {
    const instant = new Date(current);
    const local = getTimeZoneParts(instant, timeZone);
    if (local.localDate !== dateKey) continue;
    if (!parsed.minute.has(local.minute)) continue;
    if (!parsed.hour.has(local.hour)) continue;
    if (!parsed.day.has(local.day)) continue;
    if (!parsed.month.has(local.month)) continue;
    if (!parsed.weekday.has(local.weekday)) continue;

    occurrences.push({
      workflowId,
      scheduleId: schedule.scheduleId,
      kind: schedule.kind,
      timezone: timeZone,
      dueAt: instant.toISOString(),
      countsTowardExpected: countsTowardExpected(schedule),
    });
  }

  return occurrences;
}

function listEveryOccurrencesForDate(workflowId, schedule, dateKey) {
  const intervalMs = parseDurationMs(schedule.every);
  const startMs = Date.parse(schedule.startAt);
  if (!Number.isFinite(startMs)) {
    throw new Error(`every schedule ${schedule.scheduleId} requires a valid startAt`);
  }

  const timeZone = getScheduleTimeZone(schedule);
  const { start, end } = getWindowBoundsForDate(dateKey);
  const firstIndex = Math.max(0, Math.ceil((start - startMs) / intervalMs));
  const occurrences = [];

  for (let index = firstIndex; ; index += 1) {
    const dueMs = startMs + (index * intervalMs);
    if (dueMs > end) break;
    const instant = new Date(dueMs);
    const local = getTimeZoneParts(instant, timeZone);
    if (local.localDate !== dateKey) continue;

    occurrences.push({
      workflowId,
      scheduleId: schedule.scheduleId,
      kind: schedule.kind,
      timezone: timeZone,
      dueAt: instant.toISOString(),
      countsTowardExpected: countsTowardExpected(schedule),
    });
  }

  return occurrences;
}

function listAtOccurrencesForDate(workflowId, schedule, dateKey) {
  const dueMs = Date.parse(schedule.at);
  if (!Number.isFinite(dueMs)) {
    throw new Error(`at schedule ${schedule.scheduleId} requires a valid at timestamp`);
  }

  const instant = new Date(dueMs);
  const local = getTimeZoneParts(instant, getScheduleTimeZone(schedule));
  if (local.localDate !== dateKey) return [];

  return [{
    workflowId,
    scheduleId: schedule.scheduleId,
    kind: schedule.kind,
    timezone: getScheduleTimeZone(schedule),
    dueAt: instant.toISOString(),
    countsTowardExpected: countsTowardExpected(schedule),
  }];
}

function expandScheduleOccurrencesForDate(workflowId, schedule, dateKey) {
  if (!isScheduleEnabled(schedule)) return [];

  switch (schedule.kind) {
    case 'cron':
      return listCronOccurrencesForDate(workflowId, schedule, dateKey);
    case 'every':
      return listEveryOccurrencesForDate(workflowId, schedule, dateKey);
    case 'at':
      return listAtOccurrencesForDate(workflowId, schedule, dateKey);
    default:
      throw new Error(`Unsupported schedule kind: ${schedule.kind}`);
  }
}

function getOccurrenceMatchWindowMs(schedule) {
  if (typeof schedule.matchWindowMs === 'number') return schedule.matchWindowMs;
  if (schedule.matchWindow) return parseDurationMs(schedule.matchWindow);
  return 2 * 60 * 60 * 1000;
}

function resolveScheduledOccurrence({ workflowId, schedule, startedAt }) {
  const timeZone = getScheduleTimeZone(schedule);
  const started = new Date(startedAt);
  const localDate = getTimeZoneParts(started, timeZone).localDate;
  const dates = [shiftDate(localDate, -1), localDate];
  const occurrences = dates.flatMap((dateKey) => expandScheduleOccurrencesForDate(workflowId, schedule, dateKey));
  const windowMs = getOccurrenceMatchWindowMs(schedule);

  return occurrences
    .filter((occurrence) => {
      const delta = started.getTime() - Date.parse(occurrence.dueAt);
      return delta >= 0 && delta <= windowMs;
    })
    .sort((left, right) => Date.parse(right.dueAt) - Date.parse(left.dueAt))[0] || null;
}

module.exports = {
  countsTowardExpected,
  expandScheduleOccurrencesForDate,
  getOccurrenceMatchWindowMs,
  getTimeZoneParts,
  isScheduleEnabled,
  parseCronExpression,
  parseDurationMs,
  resolveScheduledOccurrence,
  shiftDate,
};
