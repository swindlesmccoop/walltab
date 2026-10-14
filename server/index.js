const express = require('express');
const path = require('path');
const store = require('./store');
const { fetchWeather, clearCache } = require('./weather');
const { saveBrowserLocation } = require('./location');
const calendar = require('./calendar');

store.init();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Client-tunable settings the dashboard needs at boot (e.g. how late "today" runs before rolling to tomorrow).
app.get('/api/config', (req, res) => {
  res.json({
    dayRolloverHour: store.rolloverHours(),
    clockFadeSeconds: store.clockFadeSeconds(),
    countEvents: store.envFlag('COUNT_EVENTS', false),
    countTodos: store.envFlag('COUNT_TODOS', true)
  });
});

app.get('/api/today', async (req, res) => {
  res.json(await store.getDayView(req.query.date));
});

app.get('/api/week', async (req, res) => {
  res.json(await store.getWeekView(req.query.start));
});

app.post('/api/calendars/refresh', (req, res) => {
  calendar.clearCache();
  res.status(204).end();
});

app.post('/api/assignments/:uid/toggle', (req, res) => {
  res.json({ uid: req.params.uid, done: store.toggleAssignment(req.params.uid) });
});

app.post('/api/today/:taskId/toggle', (req, res) => {
  const done = store.toggleCompletion(req.params.taskId, req.query.date);
  res.json({ taskId: req.params.taskId, done });
});

app.post('/api/todos/:id/toggle', (req, res) => {
  const done = store.toggleTodo(req.params.id, store.resolveDate(req.query.date));
  if (done === null) return res.status(404).end();
  res.json({ id: req.params.id, done });
});

// Creates a routine file in data/tasks/, or a checklist line in data/todo.md when once is set.
app.post('/api/tasks', (req, res) => {
  const { text, part, time, days, every, once } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  try {
    if (once) store.addTodo(text);
    else store.addRoutine({ text: text.trim(), part, time, days, every: Number(every) || null });
    res.status(201).end();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/tasks/:id', (req, res) => {
  res.status(store.deleteRoutine(req.params.id) ? 204 : 404).end();
});

app.delete('/api/todos/:id', (req, res) => {
  res.status(store.deleteTodo(req.params.id) ? 204 : 404).end();
});

app.get('/api/weather', async (req, res) => {
  try {
    const data = await fetchWeather();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'weather unavailable', detail: err.message });
  }
});

app.post('/api/location', async (req, res) => {
  const lat = Number(req.body?.lat);
  const lon = Number(req.body?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return res.status(400).json({ error: 'lat/lon required' });
  }
  const result = await saveBrowserLocation(lat, lon);
  if (!result.ignored) clearCache();
  res.json(result);
});

const PORT = process.env.PORT || 4040;
app.listen(PORT, () => {
  console.log(`walltab listening on :${PORT}`);
});
