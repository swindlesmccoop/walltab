const ICAL = require('ical.js');

const CACHE_MS = 5 * 60 * 1000;
const NIGHT_DUE_FROM = 22 * 60; // due at/after 10pm counts as "tomorrow night"

const CALENDARS = [
  { key: 'classes', label: 'Classes', env: 'CLASSES' },
  { key: 'work', label: 'Work', env: 'WORK' },
  { key: 'personal', label: 'Personal', env: 'PERSONAL' },
  { key: 'canvas', label: 'Canvas', env: 'CANVAS' }
];

const cache = new Map(); // key -> { fetchedAt, events, error }

function configured() {
  const { CALDAV_URL, CALDAV_USERNAME, CALDAV_PASSWORD } = process.env;
  if (!CALDAV_URL || !CALDAV_USERNAME) return [];
  const base = CALDAV_URL.replace(/\/+$/, '');
  const auth = 'Basic ' + Buffer.from(`${CALDAV_USERNAME}:${CALDAV_PASSWORD || ''}`).toString('base64');
  return CALENDARS
    .filter((c) => process.env[c.env])
    .map((c) => ({
      ...c,
      url: `${base}/${encodeURIComponent(CALDAV_USERNAME)}/${encodeURIComponent(process.env[c.env])}/`,
      auth
    }));
}

function parseCalendar(text) {
  const root = new ICAL.Component(ICAL.parse(text));
  root.getAllSubcomponents('vtimezone').forEach((tz) => ICAL.TimezoneService.register(tz));

  const vevents = root.getAllSubcomponents('vevent');
  const exceptionsByUid = new Map();
  for (const ve of vevents) {
    if (!ve.hasProperty('recurrence-id')) continue;
    const uid = ve.getFirstPropertyValue('uid');
    if (!exceptionsByUid.has(uid)) exceptionsByUid.set(uid, []);
    exceptionsByUid.get(uid).push(ve);
  }
  // Passing exceptions explicitly keeps overrides attached to their own event (one .ics holds many).
  return vevents
    .filter((ve) => !ve.hasProperty('recurrence-id'))
    .map((ve) => new ICAL.Event(ve, { exceptions: exceptionsByUid.get(ve.getFirstPropertyValue('uid')) || [] }));
}

async function loadCalendar(cal) {
  const hit = cache.get(cal.key);
  if (hit && Date.now() - hit.fetchedAt < CACHE_MS) return hit;
  try {
    const res = await fetch(cal.url, { headers: { Authorization: cal.auth } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const entry = { fetchedAt: Date.now(), events: parseCalendar(await res.text()), error: null };
    cache.set(cal.key, entry);
    return entry;
  } catch (err) {
    // Keep showing the last good copy; retry on the next request after a short pause.
    const entry = { fetchedAt: Date.now() - CACHE_MS + 60 * 1000, events: hit ? hit.events : [], error: err.message };
    cache.set(cal.key, entry);
    return entry;
  }
}

// ---------- time helpers (server TZ must match the tablet's) ----------

function dayStart(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function keyOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function hhmm(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function label12(date) {
  const h = date.getHours();
  const m = date.getMinutes();
  return `${((h + 11) % 12) + 1}${m ? ':' + String(m).padStart(2, '0') : ''} ${h >= 12 ? 'PM' : 'AM'}`;
}

function icalDate(t) {
  return t.isDate ? new Date(t.year, t.month - 1, t.day) : t.toJSDate();
}

// ---------- occurrences ----------

function occurrencesIn(event, from, to) {
  const out = [];
  const push = (item, start, end) => {
    const s = icalDate(start);
    let e = end ? icalDate(end) : s;
    if (start.isDate && e <= s) e = addDays(s, 1);
    // Zero-length items (Canvas due dates) count if they start inside the window.
    if (s < to && (e > from || (e.getTime() === s.getTime() && s >= from))) {
      out.push({ item, start: s, end: e, allDay: start.isDate });
    }
  };

  if (!event.isRecurring()) {
    push(event, event.startDate, event.endDate);
    return out;
  }
  const it = event.iterator();
  for (let next = it.next(), guard = 0; next && guard < 5000; next = it.next(), guard++) {
    if (icalDate(next) >= to) break;
    const details = event.getOccurrenceDetails(next);
    push(details.item, details.startDate, details.endDate);
  }
  return out;
}

const unescape = (s) => (s || '').replace(/\\([,;\\])/g, '$1').trim();

// "Problem Set 1 [ECON 333, Section 001: International Economics (...)]" -> title + "ECON 333"
function splitCanvasTitle(summary) {
  const m = unescape(summary).match(/^(.*?)\s*\[(.*)\]\s*$/);
  if (!m) return { title: unescape(summary), course: '' };
  const code = m[2].match(/\b([A-Z]{2,5})\s?(\d{3}[A-Z]?)\b/);
  return { title: m[1].trim() || unescape(summary), course: code ? `${code[1]} ${code[2]}` : '' };
}

async function collect(from, to) {
  const items = [];
  const problems = [];
  for (const cal of configured()) {
    const { events, error } = await loadCalendar(cal);
    if (error) problems.push({ reason: `Couldn't refresh the ${cal.label} calendar (${error})` });
    for (const event of events) {
      for (const occ of occurrencesIn(event, from, to)) {
        const uid = occ.item.uid;
        const isAssignment = cal.key === 'canvas' && /^event-assignment/.test(uid);
        const base = cal.key === 'canvas' ? splitCanvasTitle(occ.item.summary) : { title: unescape(occ.item.summary), course: '' };
        items.push({
          uid,
          calendar: cal.key,
          calendarLabel: cal.label,
          kind: isAssignment ? 'assignment' : 'event',
          title: base.title || '(untitled)',
          course: base.course,
          location: unescape(occ.item.location),
          start: occ.start,
          end: occ.end,
          allDay: occ.allDay
        });
      }
    }
  }
  return { items, problems };
}

// ---------- views ----------

function eventRow(it) {
  return {
    id: `${it.uid}@${it.start.getTime()}`,
    kind: 'event',
    calendar: it.calendar,
    text: it.title,
    time: it.allDay ? null : hhmm(it.start),
    endTime: it.allDay ? null : hhmm(it.end),
    allDay: it.allDay,
    meta: [it.course, it.location].filter(Boolean).join(' · ')
  };
}

function assignmentRow(it, due, done) {
  return {
    id: it.uid,
    kind: 'assignment',
    calendar: it.calendar,
    text: it.title,
    time: due.time,
    group: due.group,
    allDay: false,
    meta: [it.course, due.label].filter(Boolean).join(' · '),
    done
  };
}

// Today's calendar rows, including heads-ups for assignments due tomorrow.
async function dayItems(dateKey, doneIds) {
  const today = dayStart(dateKey);
  const tomorrowKey = keyOf(addDays(today, 1));
  const { items, problems } = await collect(today, addDays(today, 2));
  const rows = [];

  for (const it of items) {
    const startKey = keyOf(it.start);
    if (it.kind === 'assignment') {
      const done = doneIds.has(it.uid);
      const mins = it.start.getHours() * 60 + it.start.getMinutes();
      if (startKey === dateKey) {
        rows.push(assignmentRow(it, it.allDay
          ? { time: null, group: 'Anytime', label: 'Due today' }
          : { time: hhmm(it.start), label: `Due ${label12(it.start)}` }, done));
      } else if (startKey === tomorrowKey) {
        if (it.allDay) {
          rows.push(assignmentRow(it, { time: null, group: 'Anytime', label: 'Due tomorrow' }, done));
        } else if (mins >= NIGHT_DUE_FROM) {
          rows.push(assignmentRow(it, { time: null, group: 'Anytime', label: 'Due tomorrow night' }, done));
        } else {
          rows.push(assignmentRow(it, { time: null, group: 'Evening', label: `Due tomorrow ${label12(it.start)} · do it tonight` }, done));
        }
      }
      continue;
    }
    // Events only show on the days they actually touch.
    if (it.start < addDays(today, 1) && it.end > today) rows.push(eventRow(it));
  }
  return { rows, problems };
}

// Canvas course events are class meetings, so they follow the "classes" setting;
// Canvas assignments follow "canvas".
function weekKey(it) {
  return it.calendar === 'canvas' && it.kind === 'event' ? 'classes' : it.calendar;
}

// 7 days of calendar items starting at dateKey (no routines), grouped by day.
// `allowed` is a set of calendar keys to include, or null for all.
async function weekItems(dateKey, doneIds, allowed) {
  const start = dayStart(dateKey);
  const collected = await collect(start, addDays(start, 7));
  const items = allowed ? collected.items.filter((it) => allowed.has(weekKey(it))) : collected.items;
  const problems = collected.problems;
  const days = [];
  for (let i = 0; i < 7; i++) {
    const day = addDays(start, i);
    const next = addDays(day, 1);
    const key = keyOf(day);
    const rows = items
      .filter((it) => (it.kind === 'assignment' ? keyOf(it.start) === key : it.start < next && it.end > day))
      .map((it) => it.kind === 'assignment'
        ? assignmentRow(it, it.allDay
          ? { time: null, label: 'Due today' }
          : { time: hhmm(it.start), label: `Due ${label12(it.start)}` }, doneIds.has(it.uid))
        : eventRow(it))
      .sort((a, b) => (a.allDay === b.allDay ? (a.time || '').localeCompare(b.time || '') : a.allDay ? -1 : 1));
    days.push({ date: key, items: rows });
  }
  return { days, problems };
}

function clearCache() {
  cache.clear();
}

module.exports = { dayItems, weekItems, clearCache };
