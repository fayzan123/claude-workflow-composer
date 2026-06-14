import { describe, it, expect } from 'vitest'
import {
  scheduleToCron,
  cronToSchedule,
  describeCron,
  type Schedule,
} from '../client/src/lib/schedule-cron.ts'

// ---------------------------------------------------------------------------
// scheduleToCron
// ---------------------------------------------------------------------------

describe('scheduleToCron', () => {
  it('daily at 09:00', () => {
    // 09:00 → minute=0, hour=9 → "0 9 * * *"
    expect(scheduleToCron({ frequency: 'daily', time: '09:00' })).toBe('0 9 * * *')
  })

  it('daily — strips leading zero from minute and hour', () => {
    // 07:05 → minute=5, hour=7 → "5 7 * * *"
    expect(scheduleToCron({ frequency: 'daily', time: '07:05' })).toBe('5 7 * * *')
  })

  it('daily — defaults time to 09:00', () => {
    expect(scheduleToCron({ frequency: 'daily' })).toBe('0 9 * * *')
  })

  it('weekdays at 09:00', () => {
    expect(scheduleToCron({ frequency: 'weekdays', time: '09:00' })).toBe('0 9 * * 1-5')
  })

  it('weekdays at 18:30', () => {
    // 18:30 → minute=30, hour=18 → "30 18 * * 1-5"
    expect(scheduleToCron({ frequency: 'weekdays', time: '18:30' })).toBe('30 18 * * 1-5')
  })

  it('weekdays — defaults time to 09:00', () => {
    expect(scheduleToCron({ frequency: 'weekdays' })).toBe('0 9 * * 1-5')
  })

  it('hourly', () => {
    expect(scheduleToCron({ frequency: 'hourly' })).toBe('0 * * * *')
  })

  it('hourly — ignores time', () => {
    expect(scheduleToCron({ frequency: 'hourly', time: '15:00' })).toBe('0 * * * *')
  })

  it('weekly on Monday at 09:00', () => {
    expect(scheduleToCron({ frequency: 'weekly', time: '09:00', weekday: 1 })).toBe('0 9 * * 1')
  })

  it('weekly on Sunday (0) at 06:00', () => {
    // 06:00 → minute=0, hour=6 → "0 6 * * 0"
    expect(scheduleToCron({ frequency: 'weekly', time: '06:00', weekday: 0 })).toBe('0 6 * * 0')
  })

  it('weekly on Saturday (6) at 18:30', () => {
    expect(scheduleToCron({ frequency: 'weekly', time: '18:30', weekday: 6 })).toBe('30 18 * * 6')
  })

  it('weekly — defaults weekday to 1 (Monday)', () => {
    expect(scheduleToCron({ frequency: 'weekly', time: '09:00' })).toBe('0 9 * * 1')
  })

  it('weekly — defaults time to 09:00', () => {
    expect(scheduleToCron({ frequency: 'weekly', weekday: 3 })).toBe('0 9 * * 3')
  })

  it('custom — returns raw', () => {
    expect(scheduleToCron({ frequency: 'custom', raw: '15 4 * * 2' })).toBe('15 4 * * 2')
  })

  it('custom — falls back to 0 9 * * * when raw missing', () => {
    expect(scheduleToCron({ frequency: 'custom' })).toBe('0 9 * * *')
  })

  it('custom — falls back to 0 9 * * * when raw is empty string', () => {
    expect(scheduleToCron({ frequency: 'custom', raw: '' })).toBe('0 9 * * *')
  })
})

// ---------------------------------------------------------------------------
// cronToSchedule
// ---------------------------------------------------------------------------

describe('cronToSchedule', () => {
  it('daily pattern → daily schedule', () => {
    // cron "0 9 * * *" = minute 0, hour 9 = 09:00
    expect(cronToSchedule('0 9 * * *')).toEqual<Schedule>({
      frequency: 'daily',
      time: '09:00',
    })
  })

  it('daily — pads single-digit hour/minute', () => {
    // cron "5 7 * * *" = minute 5, hour 7 = 07:05
    expect(cronToSchedule('5 7 * * *')).toEqual<Schedule>({
      frequency: 'daily',
      time: '07:05',
    })
  })

  it('weekdays pattern → weekdays schedule', () => {
    expect(cronToSchedule('30 18 * * 1-5')).toEqual<Schedule>({
      frequency: 'weekdays',
      time: '18:30',
    })
  })

  it('hourly pattern → hourly schedule', () => {
    expect(cronToSchedule('0 * * * *')).toEqual<Schedule>({
      frequency: 'hourly',
    })
  })

  it('weekly pattern → weekly schedule (Monday)', () => {
    // cron "0 9 * * 1" = minute 0, hour 9, Monday = 09:00 on Monday
    expect(cronToSchedule('0 9 * * 1')).toEqual<Schedule>({
      frequency: 'weekly',
      time: '09:00',
      weekday: 1,
    })
  })

  it('weekly pattern → weekly schedule (Sunday=0)', () => {
    expect(cronToSchedule('0 6 * * 0')).toEqual<Schedule>({
      frequency: 'weekly',
      time: '06:00',
      weekday: 0,
    })
  })

  it('weekly pattern → weekly schedule (Saturday=6)', () => {
    expect(cronToSchedule('30 18 * * 6')).toEqual<Schedule>({
      frequency: 'weekly',
      time: '18:30',
      weekday: 6,
    })
  })

  it('unrecognized → custom with raw', () => {
    expect(cronToSchedule('15 4 1 * *')).toEqual<Schedule>({
      frequency: 'custom',
      raw: '15 4 1 * *',
    })
  })

  it('unrecognized complex → custom with raw', () => {
    expect(cronToSchedule('*/5 * * * *')).toEqual<Schedule>({
      frequency: 'custom',
      raw: '*/5 * * * *',
    })
  })

  it('trims whitespace before parsing', () => {
    expect(cronToSchedule('  0 9 * * *  ')).toEqual<Schedule>({
      frequency: 'daily',
      time: '09:00',
    })
  })
})

// ---------------------------------------------------------------------------
// Round-trip: scheduleToCron → cronToSchedule
// ---------------------------------------------------------------------------

describe('round-trip', () => {
  it('daily round-trips', () => {
    const s: Schedule = { frequency: 'daily', time: '09:00' }
    expect(cronToSchedule(scheduleToCron(s))).toEqual(s)
  })

  it('daily round-trips (non-standard time)', () => {
    const s: Schedule = { frequency: 'daily', time: '07:05' }
    expect(cronToSchedule(scheduleToCron(s))).toEqual(s)
  })

  it('weekdays round-trips', () => {
    const s: Schedule = { frequency: 'weekdays', time: '18:30' }
    expect(cronToSchedule(scheduleToCron(s))).toEqual(s)
  })

  it('hourly round-trips (no time/weekday fields expected)', () => {
    const s: Schedule = { frequency: 'hourly' }
    expect(cronToSchedule(scheduleToCron(s))).toEqual(s)
  })

  it('weekly round-trips (Monday)', () => {
    const s: Schedule = { frequency: 'weekly', time: '09:00', weekday: 1 }
    expect(cronToSchedule(scheduleToCron(s))).toEqual(s)
  })

  it('weekly round-trips (Sunday)', () => {
    const s: Schedule = { frequency: 'weekly', time: '06:00', weekday: 0 }
    expect(cronToSchedule(scheduleToCron(s))).toEqual(s)
  })

  it('weekly round-trips (Saturday)', () => {
    const s: Schedule = { frequency: 'weekly', time: '18:30', weekday: 6 }
    expect(cronToSchedule(scheduleToCron(s))).toEqual(s)
  })
})

// ---------------------------------------------------------------------------
// describeCron
// ---------------------------------------------------------------------------

describe('describeCron', () => {
  it('daily at 09:00 → "Every day at 9:00 AM"', () => {
    expect(describeCron('0 9 * * *')).toBe('Every day at 9:00 AM')
  })

  it('daily at 18:30 → "Every day at 6:30 PM"', () => {
    expect(describeCron('30 18 * * *')).toBe('Every day at 6:30 PM')
  })

  it('daily at 00:00 → "Every day at 12:00 AM"', () => {
    expect(describeCron('0 0 * * *')).toBe('Every day at 12:00 AM')
  })

  it('daily at 12:00 → "Every day at 12:00 PM"', () => {
    expect(describeCron('0 12 * * *')).toBe('Every day at 12:00 PM')
  })

  it('weekdays at 09:00 → "Every weekday at 9:00 AM"', () => {
    expect(describeCron('0 9 * * 1-5')).toBe('Every weekday at 9:00 AM')
  })

  it('weekdays at 18:30 → "Every weekday at 6:30 PM"', () => {
    expect(describeCron('30 18 * * 1-5')).toBe('Every weekday at 6:30 PM')
  })

  it('hourly → "Every hour"', () => {
    expect(describeCron('0 * * * *')).toBe('Every hour')
  })

  it('weekly Monday at 09:00 → "Every Monday at 9:00 AM"', () => {
    expect(describeCron('0 9 * * 1')).toBe('Every Monday at 9:00 AM')
  })

  it('weekly Sunday at 06:00 → "Every Sunday at 6:00 AM"', () => {
    expect(describeCron('0 6 * * 0')).toBe('Every Sunday at 6:00 AM')
  })

  it('weekly Saturday at 18:30 → "Every Saturday at 6:30 PM"', () => {
    expect(describeCron('30 18 * * 6')).toBe('Every Saturday at 6:30 PM')
  })

  it('weekly Wednesday at 12:00 → "Every Wednesday at 12:00 PM"', () => {
    expect(describeCron('0 12 * * 3')).toBe('Every Wednesday at 12:00 PM')
  })

  it('custom passthrough — returns raw cron unchanged', () => {
    expect(describeCron('15 4 1 * *')).toBe('15 4 1 * *')
  })

  it('custom passthrough — */5 pattern', () => {
    expect(describeCron('*/5 * * * *')).toBe('*/5 * * * *')
  })
})
