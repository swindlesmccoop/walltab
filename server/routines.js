const fs = require('fs');
const path = require('path');

const TASKS_DIR = path.join(__dirname, '..', 'data', 'tasks');

const WEEK_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const WEEKENDS = ['sat', 'sun'];
const FULL_DAY = {
  mon: 'monday', tue: 'tuesday', wed: 'wednesday', thu: 'thursday', fri: 'friday', sat: 'saturday', sun: 'sunday'
};
const PARTS = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', night: 'Evening', anytime: null, 'any time': null };

const TEMPLATE = `When: anytime
Days: every day

# Copy this file and rename it to the task's name, e.g. "Brush teeth.md".
# Every line is optional; an empty file means every day, anytime.
#
# When:   morning, afternoon, evening, anytime, or a time like 7:30am or noon
#          (repeat this line for something that happens more than once a day,
#          e.g. two "When:" lines for brushing teeth morning and night)
# Days:   every day, weekdays, weekends, Mon/Wed/Fri, MWF, Sundays, Mon-Thu
# Every:  other day, 3 days   (counts from the last time you checked it off,
#          or from when you added this file if you never have)
#
# Files starting with _ (like this one) are ignored.
`;

function init() {
  if (fs.existsSync(TASKS_DIR)) return;
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  fs.writeFileSync(path.join(TASKS_DIR, '_Template.md'), TEMPLATE);
}

// ---------- values ----------

function parseTime(raw) {
  const s = raw.toLowerCase().replace(/\s+/g, '').replace(/\./g, '');
  if (s === 'noon') return { value: '12:00' };
  if (s === 'midnight') return { value: '00:00' };
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?(am|pm|a|p)?$/);
  if (!m || (!m[2] && !m[3])) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3].startsWith('p') ? 12 : 0);
  }
  if (h > 23 || min > 59) return null;
  return { value: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` };
}

function parseWhen(raw) {
  const s = raw.trim().toLowerCase();
  if (s in PARTS) return { part: PARTS[s], time: null };
  const t = parseTime(s);
  if (t) return { part: null, time: t.value };
  return { error: `"${raw}" isn't a time of day (try morning, evening, anytime, 7:30am or noon)` };
}

function dayKey(word) {
  const key = word.slice(0, 3);
  return word.length >= 3 && FULL_DAY[key] && FULL_DAY[key].startsWith(word) ? key : null;
}

function parseDays(raw) {
  let s = raw.trim().toLowerCase().replace(/^every\s+/, '');
  if (['day', 'daily', 'everyday', 'all', 'every day', 'all days'].includes(s)) return { value: 'all' };
  s = s.replace(/\band\b|[&\/;]/g, ',');
  const set = new Set();
  for (let token of s.split(/[,\s]+/).filter(Boolean)) {
    if (token === 'weekdays' || token === 'weekday') { WEEKDAYS.forEach((d) => set.add(d)); continue; }
    if (token === 'weekends' || token === 'weekend') { WEEKENDS.forEach((d) => set.add(d)); continue; }
    if (token === 'mwf') { ['mon', 'wed', 'fri'].forEach((d) => set.add(d)); continue; }
    if (token === 'tth' || token === 'tr') { ['tue', 'thu'].forEach((d) => set.add(d)); continue; }
    const [a, b] = token.split('-').map((w) => w.replace(/s$/, ''));
    const start = dayKey(a || '');
    const end = b === undefined ? start : dayKey(b);
    if (!start || !end) return { error: `"${raw}" isn't a list of days (try every day, weekdays, Mon/Wed/Fri or Sundays)` };
    // Ranges walk forward through the week and may wrap, e.g. Fri-Mon.
    let i = WEEK_ORDER.indexOf(start);
    for (;;) {
      set.add(WEEK_ORDER[i]);
      if (WEEK_ORDER[i] === end) break;
      i = (i + 1) % 7;
    }
  }
  if (!set.size) return { error: `"${raw}" has no days in it` };
  if (set.size === 7) return { value: 'all' };
  return { value: WEEK_ORDER.filter((d) => set.has(d)) };
}

function parseEvery(raw) {
  const s = raw.trim().toLowerCase();
  const m = s.match(/^(?:every\s+)?(other|\d+)?\s*(?:days?)?$/);
  if (!m || (!m[1] && !/day/.test(s))) return { error: `"${raw}" isn't a repeat (try other day or 3 days)` };
  const n = m[1] === 'other' ? 2 : m[1] ? Number(m[1]) : 1;
  if (n < 1) return { error: `"${raw}" needs at least 1 day` };
  return { value: n };
}

// ---------- files ----------

function listFiles(dir, rel = '') {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    const relPath = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), relPath));
    else if (entry.name.toLowerCase().endsWith('.md')) out.push(relPath);
  }
  return out;
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'task';
}

function readRoutines() {
  const tasks = [];
  const problems = [];
  const seen = new Map();

  for (const rel of listFiles(TASKS_DIR)) {
    const name = path.basename(rel).replace(/\.md$/i, '').trim();
    const stat = fs.statSync(path.join(TASKS_DIR, rel));
    // birthtime is unreliable on some filesystems (comes back as epoch 0 or equal to mtime pre-change);
    // fall back to mtime, which always reflects at least the file's original creation.
    const created = stat.birthtimeMs > 0 && stat.birthtimeMs < stat.mtimeMs ? stat.birthtime : stat.mtime;
    const task = { text: name, file: rel, whens: [], days: 'all', every: null, created };
    let ok = true;
    const lines = fs.readFileSync(path.join(TASKS_DIR, rel), 'utf8').split(/\r?\n/);

    lines.forEach((rawLine, idx) => {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith('<!--')) return;
      const where = `${rel}, line ${idx + 1}`;
      const m = line.match(/^([A-Za-z][A-Za-z ]*?)\s*:\s*(.*)$/);
      if (!m) {
        problems.push({ reason: `${where}: expected something like "When: morning"` });
        ok = false;
        return;
      }
      const label = m[1].toLowerCase();
      const value = m[2].trim();
      if (!value) return;
      let parsed;
      if (label === 'when' || label === 'time') {
        parsed = parseWhen(value);
        if (!parsed.error) task.whens.push({ part: parsed.part, time: parsed.time });
      } else if (label === 'days' || label === 'day') {
        parsed = parseDays(value);
        if (!parsed.error) task.days = parsed.value;
      } else if (label === 'every' || label === 'repeat') {
        parsed = parseEvery(value);
        if (!parsed.error) task.every = parsed.value > 1 ? parsed.value : null;
      } else {
        parsed = { error: `"${m[1]}" isn't a label I know (use When, Days or Every)` };
      }
      if (parsed.error) {
        problems.push({ reason: `${where}: ${parsed.error}` });
        ok = false;
      }
    });

    if (!ok) continue;
    const base = slugify(name);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    tasks.push({ id: n === 1 ? base : `${base}-${n}`, ...task });
  }
  return { tasks, problems };
}

function formatTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h >= 12 ? 'pm' : 'am'}`;
}

function formatDays(days) {
  if (days === 'all') return 'every day';
  const set = new Set(days);
  if (set.size === 5 && WEEKDAYS.every((d) => set.has(d))) return 'weekdays';
  if (set.size === 2 && WEEKENDS.every((d) => set.has(d))) return 'weekends';
  return WEEK_ORDER.filter((d) => set.has(d)).map((d) => d[0].toUpperCase() + d.slice(1)).join(', ');
}

function addRoutine({ text, part, time, days, every }) {
  const name = text.replace(/[\/\\:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('task needs a name');
  const lines = [];
  if (time) {
    const t = parseTime(time);
    if (!t) throw new Error(`"${time}" isn't a valid time`);
    lines.push(`When: ${formatTime(t.value)}`);
  } else if (part) {
    if (!(part.toLowerCase() in PARTS)) throw new Error(`"${part}" isn't a part of the day`);
    lines.push(`When: ${part.toLowerCase()}`);
  }
  if (Array.isArray(days) && days.length) {
    const d = parseDays(days.join(','));
    if (d.error) throw new Error(d.error);
    if (d.value !== 'all') lines.push(`Days: ${formatDays(d.value)}`);
  }
  if (every && Number(every) > 1) lines.push(every === 2 ? 'Every: other day' : `Every: ${every} days`);

  fs.mkdirSync(TASKS_DIR, { recursive: true });
  let file = `${name}.md`;
  for (let i = 2; fs.existsSync(path.join(TASKS_DIR, file)); i++) file = `${name} ${i}.md`;
  fs.writeFileSync(path.join(TASKS_DIR, file), lines.length ? lines.join('\n') + '\n' : '');
}

// Deleting any one occurrence of a multi-When task removes the whole file.
function deleteRoutine(id) {
  const baseId = id.replace(/__\d+$/, '');
  const task = readRoutines().tasks.find((t) => t.id === baseId);
  if (!task) return false;
  fs.unlinkSync(path.join(TASKS_DIR, task.file));
  return true;
}

module.exports = { init, readRoutines, addRoutine, deleteRoutine, slugify };
