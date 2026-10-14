const fs = require('fs');
const path = require('path');
const { slugify } = require('./routines');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TODO_FILE = path.join(DATA_DIR, 'todo.md');
const DONE_FILE = path.join(DATA_DIR, 'todo-done.json');

const DEFAULT_TODO = `# To-do

<!-- One-off things to do any day. Unchecked items show on the dashboard every day
     until you check them off; checked ones disappear the next day.
     - [ ] Something to do
     - [x] Something done -->
`;

const ITEM_RE = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.*)$/;

function init() {
  if (!fs.existsSync(TODO_FILE)) fs.writeFileSync(TODO_FILE, DEFAULT_TODO);
}

function readDone() {
  try {
    return JSON.parse(fs.readFileSync(DONE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function readTodos() {
  const lines = fs.readFileSync(TODO_FILE, 'utf8').split('\n');
  const items = [];
  const seen = new Map();
  let inComment = false;
  lines.forEach((line, idx) => {
    // Example items inside <!-- --> comments aren't real.
    if (line.includes('<!--')) inComment = true;
    const commented = inComment;
    if (line.includes('-->')) inComment = false;
    if (commented) return;
    const m = line.match(ITEM_RE);
    if (!m || !m[4].trim()) return;
    const text = m[4].trim();
    const base = 'todo-' + slugify(text);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    items.push({ id: n === 1 ? base : `${base}-${n}`, text, checked: m[2] !== ' ', line: idx });
  });
  return { items, lines };
}

// Unchecked items always show; checked ones only on the day they were checked.
function todosFor(dateKey) {
  const done = readDone();
  return readTodos().items
    .filter((it) => !it.checked || done[it.id] === dateKey)
    .map((it) => ({ id: it.id, kind: 'todo', text: it.text, time: null, group: 'To-do', done: it.checked }));
}

function toggleTodo(id, dateKey) {
  const { items, lines } = readTodos();
  const item = items.find((it) => it.id === id);
  if (!item) return null;
  const checked = !item.checked;
  lines[item.line] = lines[item.line].replace(ITEM_RE, (_, a, _mark, b, rest) => `${a}${checked ? 'x' : ' '}${b}${rest}`);
  fs.writeFileSync(TODO_FILE, lines.join('\n'));
  const done = readDone();
  if (checked) done[id] = dateKey;
  else delete done[id];
  fs.writeFileSync(DONE_FILE, JSON.stringify(done, null, 2));
  return checked;
}

function addTodo(text) {
  const clean = text.replace(/[\r\n]+/g, ' ').trim();
  if (!clean) throw new Error('to-do needs some text');
  let content = fs.readFileSync(TODO_FILE, 'utf8');
  if (content && !content.endsWith('\n')) content += '\n';
  fs.writeFileSync(TODO_FILE, `${content}- [ ] ${clean}\n`);
}

function deleteTodo(id) {
  const { items, lines } = readTodos();
  const item = items.find((it) => it.id === id);
  if (!item) return false;
  lines.splice(item.line, 1);
  fs.writeFileSync(TODO_FILE, lines.join('\n'));
  return true;
}

module.exports = { init, todosFor, toggleTodo, addTodo, deleteTodo };
