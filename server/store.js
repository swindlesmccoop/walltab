const fs = require('fs');
const path = require('path');
const calendar = require('./calendar');
const routines = require('./routines');
const todo = require('./todo');

const DATA_DIR = path.join(__dirname, '..', 'data');
const COMPLETIONS_FILE = path.join(DATA_DIR, 'completions.json');
const ASSIGNMENTS_FILE = path.join(DATA_DIR, 'assignments-done.json');

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const GROUP_ORDER = ['All day', 'Morning', 'Afternoon', 'Evening', 'Anytime', 'To-do'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(COMPLETIONS_FILE)) fs.writeFileSync(COMPLETIONS_FILE, '{}');
  routines.init();
  todo.init();
}

// DAY_ROLLOVER_HOUR delays "today" becoming "tomorrow" until that hour (e.g. 4 = stays
// "today" until 4am), for people who are up past midnight. 0/unset = rolls over at midnight.
function rolloverHours() {
  const n = Number(process.env.DAY_ROLLOVER_HOUR);
  return Number.isFinite(n) && n > 0 && n < 24 ? n : 0;
}

// CLOCK_FADE_SECONDS softens the minute/hour change on the clock instead of jumping.
// Blank/0 = no fade.
function clockFadeSeconds() {
  const n = Number(process.env.CLOCK_FADE_SECONDS);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Which items count toward the day's completion ring. Events (classes, work, ...) are off by
// default and count as done once they've ended; to-dos are on by default.
function envFlag(name, fallback) {
  const v = (process.env[name] || '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return fallback;
}

// Shifts a real timestamp back by the rollover so formatting it gives the *effective* day.
function shiftForRollover(date) {
  return new Date(date.getTime() - rolloverHours() * 60 * 60 * 1000);
}

// The tablet sends its local date so the daily reset follows its clock (and the rollover hour).
function resolveDate(dateKey) {
  if (dateKey && DATE_RE.test(dateKey)) return dateKey;
  return dateKeyOf(shiftForRollover(new Date()));
}

const utcDay = (key) => Date.parse(key + 'T00:00:00Z');
const daysBetween = (a, b) => Math.round((utcDay(b) - utcDay(a)) / DAY_MS);
const addDaysKey = (key, n) => new Date(utcDay(key) + n * DAY_MS).toISOString().slice(0, 10);
const weekdayOf = (key) => DAY_KEYS[new Date(key + 'T12:00:00Z').getUTCDay()];

// Local (not UTC) calendar date, matching how the rest of the app keys days by the tablet's clock.
function dateKeyOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// A newly-created recurring task anchors to the day it was added, in the same "effective day"
// terms as everything else — so adding one at 2am with a 4am rollover still counts as yesterday.
function createdDateKey(date) {
  return dateKeyOf(shiftForRollover(date));
}

// First date on/after startKey whose weekday is in days ('all' matches immediately).
function nextMatchingDate(startKey, days) {
  if (days === 'all') return startKey;
  let d = startKey;
  for (let i = 0; i < 7; i++) {
    if (days.includes(weekdayOf(d))) return d;
    d = addDaysKey(d, 1);
  }
  return startKey;
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

// Most recent day before `key` on which the routine was checked off.
function lastDoneBefore(id, key, completions) {
  return Object.keys(completions)
    .filter((k) => k < key && completions[k][id])
    .sort()
    .pop();
}

function everyLabel(n) {
  return n === 2 ? 'Every other day' : `Every ${n} days`;
}

// Routines due on `key`. "Every N days" counts from the last check-off, so a late
// shower pushes the next one back instead of keeping a fixed rhythm. A task that has never
// been checked off anchors to the day it was added instead, so "every other Sunday" starts
// spacing itself out immediately — nobody has to type a start date to get that.
// A task can list "When:" more than once (e.g. brush teeth morning + night); each occurrence
// is tracked and checked off independently, using an id suffixed "__2", "__3", etc. so it
// never collides with the "-2" suffix used to disambiguate two different tasks with the same name.
function routinesFor(key, completions) {
  const { tasks, problems } = routines.readRoutines();
  const doneToday = completions[key] || {};
  const rows = [];
  for (const t of tasks) {
    if (t.days !== 'all' && !t.days.includes(weekdayOf(key))) continue;
    const occurrences = t.whens.length ? t.whens : [{ part: null, time: null }];
    occurrences.forEach((occ, i) => {
      const occId = i === 0 ? t.id : `${t.id}__${i + 1}`;
      let meta = '';
      if (t.every) {
        let last = lastDoneBefore(occId, key, completions);
        if (last === undefined) {
          const anchor = nextMatchingDate(createdDateKey(t.created), t.days);
          last = addDaysKey(anchor, -t.every);
        }
        const since = daysBetween(last, key);
        if (!doneToday[occId] && since < t.every) return;
        const overdue = since - t.every;
        meta = everyLabel(t.every) + (overdue > 0 ? ` · ${overdue} day${overdue > 1 ? 's' : ''} overdue` : '');
      }
      rows.push({
        id: occId,
        kind: 'routine',
        text: t.text,
        time: occ.time,
        group: occ.part || undefined,
        days: t.days,
        meta,
        done: !!doneToday[occId]
      });
    });
  }
  return { rows, problems };
}

function groupFor(item) {
  if (item.group) return item.group;
  if (item.allDay) return 'All day';
  if (!item.time) return 'Anytime';
  const h = Number(item.time.slice(0, 2));
  return h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening';
}

async function getDayView(dateKey) {
  const key = resolveDate(dateKey);
  const completions = readJSON(COMPLETIONS_FILE);
  const r = routinesFor(key, completions);
  const cal = await calendar.dayItems(key, new Set(Object.keys(readJSON(ASSIGNMENTS_FILE))));

  // Stable sort keeps file order among untimed items in the same group.
  const list = [...r.rows, ...cal.rows, ...todo.todosFor(key)]
    .map((item) => ({ ...item, group: groupFor(item) }))
    .sort((a, b) => {
      const g = GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group);
      if (g) return g;
      if (a.time && b.time) return a.time.localeCompare(b.time);
      if (a.time) return -1;
      if (b.time) return 1;
      return 0;
    });
  return { date: key, tasks: list, problems: [...r.problems, ...cal.problems] };
}

// WEEK_CALENDARS picks which calendars appear in the week view (default: all).
function weekCalendars() {
  const raw = (process.env.WEEK_CALENDARS || '').trim();
  if (!raw) return null;
  return new Set(raw.split(/[\s,]+/).filter(Boolean).map((s) => s.toLowerCase()));
}

async function getWeekView(startKey) {
  const key = resolveDate(startKey);
  return calendar.weekItems(key, new Set(Object.keys(readJSON(ASSIGNMENTS_FILE))), weekCalendars());
}

function toggleCompletion(taskId, dateKey) {
  const completions = readJSON(COMPLETIONS_FILE);
  const key = resolveDate(dateKey);
  if (!completions[key]) completions[key] = {};
  completions[key][taskId] = !completions[key][taskId];
  if (!completions[key][taskId]) delete completions[key][taskId];
  fs.writeFileSync(COMPLETIONS_FILE, JSON.stringify(completions, null, 2));
  return !!completions[key][taskId];
}

// Assignment check-offs stick across days (checking it the night before also covers the due day).
function toggleAssignment(uid) {
  const done = readJSON(ASSIGNMENTS_FILE);
  if (done[uid]) delete done[uid];
  else done[uid] = true;
  fs.writeFileSync(ASSIGNMENTS_FILE, JSON.stringify(done, null, 2));
  return !!done[uid];
}

module.exports = {
  init,
  resolveDate,
  rolloverHours,
  clockFadeSeconds,
  envFlag,
  getDayView,
  getWeekView,
  toggleCompletion,
  toggleAssignment,
  addRoutine: routines.addRoutine,
  deleteRoutine: routines.deleteRoutine,
  toggleTodo: todo.toggleTodo,
  addTodo: todo.addTodo,
  deleteTodo: todo.deleteTodo
};
