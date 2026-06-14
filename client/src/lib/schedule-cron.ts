/**
 * schedule-cron.ts
 * Pure mapping between a friendly Schedule object and a 5-field cron string,
 * plus a human-readable describer. No external dependencies.
 */

export type Frequency = 'daily' | 'weekdays' | 'hourly' | 'weekly' | 'custom'

export interface Schedule {
  frequency: Frequency
  time?: string    // "HH:MM" 24-hour, used by daily | weekdays | weekly
  weekday?: number // 0=Sun .. 6=Sat, used by weekly
  raw?: string     // used by custom: the raw cron string
}

const DEFAULT_TIME = '09:00'
const DEFAULT_WEEKDAY = 1 // Monday
const FALLBACK_CRON = '0 9 * * *'

const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
]

/** Parse "HH:MM" into { hour, minute } integers, defaulting to 09:00. */
function parseTime(time: string | undefined): { hour: number; minute: number } {
  const t = time ?? DEFAULT_TIME
  const [hStr, mStr] = t.split(':')
  const hour = parseInt(hStr ?? '9', 10)
  const minute = parseInt(mStr ?? '0', 10)
  return { hour, minute }
}

/** Zero-pad a number to two digits. */
function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

/** Format hour + minute as "HH:MM". */
function formatTime(hour: number, minute: number): string {
  return `${pad2(hour)}:${pad2(minute)}`
}

/** Format hour + minute as 12-hour clock string, e.g. "9:00 AM", "6:30 PM". */
function format12h(hour: number, minute: number): string {
  const period = hour < 12 ? 'AM' : 'PM'
  let h = hour % 12
  if (h === 0) h = 12
  const m = pad2(minute)
  return `${h}:${m} ${period}`
}

/**
 * Build a 5-field cron string from a friendly Schedule.
 */
export function scheduleToCron(s: Schedule): string {
  switch (s.frequency) {
    case 'daily': {
      const { hour, minute } = parseTime(s.time)
      return `${minute} ${hour} * * *`
    }
    case 'weekdays': {
      const { hour, minute } = parseTime(s.time)
      return `${minute} ${hour} * * 1-5`
    }
    case 'hourly': {
      return '0 * * * *'
    }
    case 'weekly': {
      const { hour, minute } = parseTime(s.time)
      const day = s.weekday ?? DEFAULT_WEEKDAY
      return `${minute} ${hour} * * ${day}`
    }
    case 'custom': {
      return s.raw && s.raw.trim() !== '' ? s.raw : FALLBACK_CRON
    }
  }
}

/**
 * Best-effort parse of a 5-field cron back into a Schedule.
 * Recognizes the exact shapes scheduleToCron emits; anything else
 * becomes { frequency: 'custom', raw: cron }.
 */
export function cronToSchedule(cron: string): Schedule {
  const trimmed = cron.trim()
  const parts = trimmed.split(/\s+/)

  if (parts.length !== 5) {
    return { frequency: 'custom', raw: trimmed }
  }

  const [minField, hourField, dom, month, dow] = parts as [string, string, string, string, string]

  // Common guard: dom and month must both be '*'
  if (dom !== '*' || month !== '*') {
    return { frequency: 'custom', raw: trimmed }
  }

  // hourly: 0 * * * *
  if (minField === '0' && hourField === '*' && dow === '*') {
    return { frequency: 'hourly' }
  }

  // Validate minute/hour are plain integers for the remaining patterns
  const minNum = parseInt(minField, 10)
  const hourNum = parseInt(hourField, 10)
  if (
    isNaN(minNum) || isNaN(hourNum) ||
    minField.includes('*') || minField.includes('/') || minField.includes(',') ||
    hourField.includes('*') || hourField.includes('/') || hourField.includes(',')
  ) {
    return { frequency: 'custom', raw: trimmed }
  }

  const time = formatTime(hourNum, minNum)

  // weekdays: M H * * 1-5
  if (dow === '1-5') {
    return { frequency: 'weekdays', time }
  }

  // daily: M H * * *
  if (dow === '*') {
    return { frequency: 'daily', time }
  }

  // weekly: M H * * D (single digit 0-6)
  if (/^[0-6]$/.test(dow)) {
    return { frequency: 'weekly', time, weekday: parseInt(dow, 10) }
  }

  return { frequency: 'custom', raw: trimmed }
}

/**
 * Human-readable description of a cron string.
 * For unrecognized cron, returns the raw string unchanged.
 */
export function describeCron(cron: string): string {
  const schedule = cronToSchedule(cron)

  switch (schedule.frequency) {
    case 'daily': {
      const { hour, minute } = parseTime(schedule.time)
      return `Every day at ${format12h(hour, minute)}`
    }
    case 'weekdays': {
      const { hour, minute } = parseTime(schedule.time)
      return `Every weekday at ${format12h(hour, minute)}`
    }
    case 'hourly': {
      return 'Every hour'
    }
    case 'weekly': {
      const { hour, minute } = parseTime(schedule.time)
      const dayName = WEEKDAY_NAMES[schedule.weekday ?? DEFAULT_WEEKDAY]
      return `Every ${dayName} at ${format12h(hour, minute)}`
    }
    case 'custom': {
      return schedule.raw ?? cron.trim()
    }
  }
}
