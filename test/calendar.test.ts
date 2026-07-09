import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachCalendar, parseCalendarOutput, type RawCalendarEvent } from '../src/calendar.ts';
import type { Digest } from '../src/digest.ts';

function digestWithChunks(chunks: { start: string; end: string }[]): Digest {
  return {
    date: '2026-07-09',
    coverage: { first: '09:00', last: '18:00', captured_minutes: 400, gap_minutes: 140 },
    app_summary: [],
    chunks: chunks.map((c) => ({
      ...c,
      dominant_app: 'Chrome',
      window_titles: [],
      ocr_highlights: '',
      gap_before_minutes: 0,
    })),
  };
}

function ev(start: string, end: string, opts: Partial<RawCalendarEvent> = {}): RawCalendarEvent {
  return {
    start: `2026-07-09T${start}:00+09:00`,
    end: `2026-07-09T${end}:00+09:00`,
    title: 'MTG',
    calendar: 'me@example.com',
    all_day: false,
    my_status: 'accepted',
    attendee_count: 3,
    ...opts,
  };
}

test('event fully inside a captured chunk → overlap: captured', () => {
  const d = attachCalendar(digestWithChunks([{ start: '10:00', end: '11:00' }]), true, [
    ev('10:00', '10:30'),
  ]);
  assert.equal(d.calendar_events![0].overlap, 'captured');
});

test('event fully outside chunks (gap) → overlap: gap', () => {
  const d = attachCalendar(digestWithChunks([{ start: '09:00', end: '10:00' }]), true, [
    ev('13:00', '14:00'),
  ]);
  assert.equal(d.calendar_events![0].overlap, 'gap');
});

test('event with exactly half captured → overlap: partial', () => {
  // chunk 10:00-10:30, event 10:00-11:00 → captured 30/60 = 0.5(どちらも過半でない)
  const d = attachCalendar(digestWithChunks([{ start: '10:00', end: '10:30' }]), true, [
    ev('10:00', '11:00'),
  ]);
  assert.equal(d.calendar_events![0].overlap, 'partial');
});

test('event mostly captured across two chunks → overlap: captured', () => {
  // chunks 10:00-10:25, 10:30-11:00 / event 10:00-11:00 → captured 55/60
  const d = attachCalendar(
    digestWithChunks([
      { start: '10:00', end: '10:25' },
      { start: '10:30', end: '11:00' },
    ]),
    true,
    [ev('10:00', '11:00')],
  );
  assert.equal(d.calendar_events![0].overlap, 'captured');
});

test('all-day event gets no overlap and keeps all_day flag', () => {
  const d = attachCalendar(digestWithChunks([{ start: '09:00', end: '18:00' }]), true, [
    ev('00:00', '00:00', { all_day: true }),
  ]);
  assert.equal(d.calendar_events![0].all_day, true);
  assert.equal(d.calendar_events![0].overlap, undefined);
});

test('zero-length event gets no overlap', () => {
  const d = attachCalendar(digestWithChunks([{ start: '09:00', end: '18:00' }]), true, [
    ev('10:00', '10:00'),
  ]);
  assert.equal(d.calendar_events![0].overlap, undefined);
});

test('digest events use HH:MM and drop the calendar field, keep status fields', () => {
  const d = attachCalendar(digestWithChunks([{ start: '09:00', end: '18:00' }]), true, [
    ev('10:00', '10:30', { my_status: 'declined', attendee_count: 7 }),
  ]);
  const e = d.calendar_events![0];
  assert.equal(e.start, '10:00');
  assert.equal(e.end, '10:30');
  assert.equal(e.my_status, 'declined');
  assert.equal(e.attendee_count, 7);
  assert.equal('calendar' in e, false);
});

test('attachCalendar with available=false sets flag and omits events', () => {
  const d = attachCalendar(digestWithChunks([]), false, []);
  assert.equal(d.calendar_available, false);
  assert.equal(d.calendar_events, undefined);
});

test('attachCalendar does not mutate the input digest', () => {
  const original = digestWithChunks([{ start: '09:00', end: '10:00' }]);
  attachCalendar(original, true, [ev('09:00', '09:30')]);
  assert.equal(original.calendar_events, undefined);
  assert.equal(original.calendar_available, undefined);
});

test('event crossing midnight into next day is clamped and judged', () => {
  const d = attachCalendar(digestWithChunks([{ start: '09:00', end: '18:00' }]), true, [
    {
      start: '2026-07-09T23:30:00+09:00',
      end: '2026-07-10T00:30:00+09:00',
      title: '深夜MTG',
      calendar: 'me@example.com',
      all_day: false,
      my_status: 'accepted',
      attendee_count: 2,
    },
  ]);
  // 当日分は23:30-24:00の30分、キャプチャなし → gap
  assert.equal(d.calendar_events![0].overlap, 'gap');
});

test('event started the previous day is clamped to day start', () => {
  const d = attachCalendar(digestWithChunks([{ start: '00:00', end: '01:00' }]), true, [
    {
      start: '2026-07-08T23:00:00+09:00',
      end: '2026-07-09T01:00:00+09:00',
      title: '日跨ぎ',
      calendar: 'me@example.com',
      all_day: false,
      my_status: 'accepted',
      attendee_count: 2,
    },
  ]);
  // 当日分は00:00-01:00、全部キャプチャ済み → captured
  assert.equal(d.calendar_events![0].overlap, 'captured');
});

// --- parseCalendarOutput ---

test('parseCalendarOutput accepts valid output', () => {
  const out = parseCalendarOutput(
    JSON.stringify({
      authorized: true,
      events: [
        {
          start: '2026-07-09T10:00:00+09:00',
          end: '2026-07-09T11:00:00+09:00',
          title: 'チーム定例',
          calendar: 'me@example.com',
          all_day: false,
          my_status: 'accepted',
          attendee_count: 5,
        },
      ],
    }),
  );
  assert.equal(out.available, true);
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].title, 'チーム定例');
});

test('parseCalendarOutput treats unauthorized as unavailable', () => {
  const out = parseCalendarOutput(JSON.stringify({ authorized: false, events: [] }));
  assert.equal(out.available, false);
  assert.deepEqual(out.events, []);
});

test('parseCalendarOutput treats broken JSON or wrong shape as unavailable', () => {
  assert.equal(parseCalendarOutput('not json').available, false);
  assert.equal(parseCalendarOutput(JSON.stringify({ authorized: true })).available, false);
  assert.equal(
    parseCalendarOutput(JSON.stringify({ authorized: true, events: [{ title: 1 }] })).available,
    false,
  );
});
