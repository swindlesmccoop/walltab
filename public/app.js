(function () {
  const $ = (id) => document.getElementById(id);

  const els = {
    greeting: $('greeting'), time: $('time'), ampm: $('ampm'), seconds: $('seconds'), date: $('date'),
    wIcon: $('w-icon'), wTemp: $('w-temp'), wLabel: $('w-label'), wFeels: $('w-feels'), wCity: $('w-city'),
    wHiLo: $('w-hilo'), wRain: $('w-rain'), wHum: $('w-hum'), wWind: $('w-wind'),
    wSunK: $('w-sun-k'), wSun: $('w-sun'), wForecast: $('w-forecast'),
    pane: $('tasks-pane'), scroll: $('task-scroll'), sub: $('tasks-sub'),
    ringFill: $('ring-fill'), ringPct: $('ring-pct'),
    editBtn: $('edit-btn'), addBtn: $('add-btn'),
    modal: $('add-modal'), addText: $('add-text'), addTime: $('add-time'),
    presets: $('presets'), daysRow: $('days-row'), cancelBtn: $('cancel-btn'), saveBtn: $('save-btn'),
    refreshBtn: $('refresh-btn'), weekBtn: $('week-btn'), weekModal: $('week-modal'), weekGrid: $('week-grid'), weekClose: $('week-close'),
    weekPrev: $('week-prev'), weekNext: $('week-next'), weekTitle: $('week-title'), weekRange: $('week-range'),
    whenRow: $('when-row'), whenField: $('when-field')
  };

  const RING_LEN = 119.38; // 2πr, r=19
  const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
  const WEEKENDS = ['sat', 'sun'];

  let tasks = [];
  let problems = [];
  let lastTasksJSON = '';
  let weather = null;
  let editing = false;
  let rolloverHour = 0; // how late "today" runs before rolling to tomorrow; loaded from /api/config
  let currentDateKey = localDateKey(new Date()); // refined once config loads, see boot()
  let clockFade = 0; // seconds for the minute/hour change to fade out and back in; 0 = jump
  let countEvents = false; // calendar events count toward the ring once they've ended
  let countTodos = true;   // one-off to-dos count toward the ring
  let lastMinute = -1;

  function localDateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // The "effective" day: real time shifted back by the rollover hour, so e.g. 2am with a 4am
  // rollover still renders and keys everything as the previous calendar day.
  function shiftForRollover(d) {
    return new Date(d.getTime() - rolloverHour * 60 * 60 * 1000);
  }

  function to12h(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
  }

  function minutesOf(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  // Clock changes animate when clockFade > 0 (CLOCK_FADE_SECONDS). Changing digits roll like a
  // dial: the old one slides up and out while the new one slides up in from below, clipped to
  // the digit's box. When the hour gains or loses a digit (9:59 -> 10:00) its slot opens or closes.
  function fadeOutIn(targets, apply) {
    const half = clockFade / 2;
    targets.forEach((t) => { t.style.transition = `opacity ${half}s ease`; t.style.opacity = '0'; });
    setTimeout(() => {
      apply();
      targets.forEach((t) => { t.style.opacity = '1'; });
    }, half * 1000);
  }

  // A digit slot is always .ch > .roll-in (even at rest) so the text is rendered the same way
  // before, during and after a roll and nothing visibly re-rasterises when an animation ends.
  function makeChar(text) {
    const slot = el('span', 'ch');
    slot.appendChild(el('span', 'roll-in', text));
    return slot;
  }

  // Rolls a digit slot to `to`. A slot with no digit yet rolls one in and opens up; to === null
  // rolls the digit out and closes the slot (used when the hour gains or loses a digit).
  function rollChar(span, to) {
    const entering = !span.firstElementChild;
    const w0 = entering ? 0 : span.offsetWidth;
    const prev = span.firstElementChild;
    if (prev) prev.className = 'roll-out';
    const next = to === null ? null : span.appendChild(el('span', 'roll-in', to));
    const w1 = to === null ? 0 : span.offsetWidth;
    if (w0 !== w1) {
      span.style.width = `${w0}px`;
      span.style.setProperty('--ext', `${Math.abs(w1 - w0)}px`);
    }
    if (next) next.style.transform = 'translateY(100%)';
    void span.offsetWidth; // commit the start state before transitioning
    // Long, soft deceleration so digits glide into place instead of snapping the last few pixels.
    const curve = 'cubic-bezier(0.45, 0.1, 0.2, 1)';
    const t = `${clockFade}s ${curve}`;
    span.style.animation = `roll-fade ${t}`;
    if (w0 !== w1) {
      // Growing, the box opens early to make room. Shrinking, it waits until the old digits have
      // mostly rolled out so they don't slide over the colon and the minutes.
      const shrink = w1 < w0;
      span.style.transition = `width ${clockFade * (shrink ? 0.5 : 0.4)}s ${curve} ${shrink ? clockFade * 0.5 : 0}s`;
      span.style.width = `${w1}px`;
    }
    if (next) { next.style.transition = `transform ${t}`; next.style.transform = 'none'; }
    if (prev) { prev.style.transition = `transform ${t}`; prev.style.transform = 'translateY(-100%)'; }
    // Finish just after the animations end so they always reach their final frame first.
    setTimeout(() => {
      if (prev) prev.remove();
      if (next) next.style.cssText = '';
      if (to === null) span.remove();
      else span.style.cssText = '';
    }, clockFade * 1000 + 100);
  }

  function setChars(node, text) {
    node.textContent = '';
    for (const ch of text) node.appendChild(makeChar(ch));
  }

  function fadeTime(node, text) {
    const prev = node.textContent;
    if (prev === text) return;
    if (!clockFade || !/^\d{1,2}:\d{2}$/.test(prev)) { setChars(node, text); return; }
    if (node.children.length !== prev.length) setChars(node, prev); // settle any leftover group from last time
    if (prev.length !== text.length) {
      // The hour gains or loses a digit (9:59 -> 10:00, 12:59 -> 1:00). Digits are matched left to
      // right: unchanged ones stay put, a new one rolls in and opens a slot, a lost one rolls out.
      const [oldHour, newHour] = [prev, text].map((v) => v.split(':')[0]);
      const slots = [...node.children];
      for (let i = 0; i < Math.max(oldHour.length, newHour.length); i++) {
        if (i >= oldHour.length) {
          const slot = el('span', 'ch');
          node.insertBefore(slot, slots[oldHour.length]); // before the colon
          rollChar(slot, newHour[i]);
        } else if (i >= newHour.length) rollChar(slots[i], null);
        else if (oldHour[i] !== newHour[i]) rollChar(slots[i], newHour[i]);
      }
      const minutesStart = oldHour.length + 1;
      [...prev.slice(-2)].forEach((ch, k) => { if (ch !== text.slice(-2)[k]) rollChar(slots[minutesStart + k], text.slice(-2)[k]); });
      return;
    }
    const changed = [...text].map((ch, i) => (ch === prev[i] ? -1 : i)).filter((i) => i >= 0);
    changed.forEach((i) => rollChar(node.children[i], text[i]));
  }

  function fadeText(node, text) {
    if (node.textContent === text) return;
    if (!clockFade || node.textContent === '--') { setText(node, text); return; }
    fadeOutIn([node], () => { node.textContent = text; });
  }

  // ---------- Sky: background colours blended continuously through the day ----------
  // Each stop: glowA, glowB (rgba), bgTop, accent, ink (rgb). Positions are anchored
  // to the real sunrise/sunset from the weather when known.
  const SKY = {
    night:   { glowA: [70, 90, 230, 0.20],   glowB: [140, 70, 240, 0.13], bgTop: [10, 13, 26], accent: [157, 180, 255], ink: [10, 20, 48] },
    predawn: { glowA: [110, 80, 200, 0.22],  glowB: [200, 90, 160, 0.14], bgTop: [16, 14, 32], accent: [190, 170, 255], ink: [22, 14, 48] },
    sunrise: { glowA: [255, 140, 90, 0.26],  glowB: [255, 90, 140, 0.16], bgTop: [30, 18, 26], accent: [255, 178, 122], ink: [46, 20, 5] },
    morning: { glowA: [255, 190, 120, 0.20], glowB: [80, 170, 255, 0.14], bgTop: [20, 22, 32], accent: [255, 205, 140], ink: [48, 30, 6] },
    midday:  { glowA: [70, 150, 255, 0.24],  glowB: [60, 220, 210, 0.12], bgTop: [12, 20, 34], accent: [122, 184, 255], ink: [6, 26, 51] },
    golden:  { glowA: [255, 170, 80, 0.24],  glowB: [255, 110, 90, 0.14], bgTop: [28, 20, 22], accent: [255, 190, 120], ink: [46, 24, 5] },
    sunset:  { glowA: [255, 100, 120, 0.25], glowB: [150, 80, 255, 0.18], bgTop: [30, 14, 30], accent: [255, 159, 176], ink: [48, 10, 20] },
    dusk:    { glowA: [130, 90, 255, 0.22],  glowB: [90, 60, 200, 0.16],  bgTop: [16, 12, 34], accent: [190, 160, 255], ink: [24, 12, 52] }
  };

  function skyStops() {
    const sr = weather ? minutesOf(weather.today.sunrise) : 7 * 60;
    const ss = weather ? minutesOf(weather.today.sunset) : 19 * 60;
    return [
      [0, SKY.night],
      [sr - 90, SKY.predawn],
      [sr, SKY.sunrise],
      [sr + 90, SKY.morning],
      [Math.round((sr + ss) / 2), SKY.midday],
      [ss - 90, SKY.golden],
      [ss, SKY.sunset],
      [ss + 75, SKY.dusk],
      [Math.max(ss + 180, 22 * 60), SKY.night],
      [24 * 60, SKY.night]
    ];
  }

  function mix(a, b, t) {
    return a.map((v, i) => v + (b[i] - v) * t);
  }

  const smooth = (x) => { const c = Math.min(1, Math.max(0, x)); return c * c * (3 - 2 * c); };
  const rgb = (c) => `rgb(${c.slice(0, 3).map(Math.round).join(',')})`;
  const rgba = (c) => `rgba(${c.slice(0, 3).map(Math.round).join(',')},${c[3].toFixed(3)})`;

  // Night palette = the original dark look; day palette = light, to blend with a white wall.
  const THEME = {
    night: {
      bg: [7, 9, 15, 1], card: [255, 255, 255, 0.045], cardHi: [255, 255, 255, 0.075],
      line: [255, 255, 255, 0.08], lineHi: [255, 255, 255, 0.16],
      text: [242, 244, 250, 1], text2: [232, 236, 246, 0.62], text3: [232, 236, 246, 0.38],
      surface: [255, 255, 255, 0.035], surfaceHi: [255, 255, 255, 0.06], footBg: [0, 0, 0, 0.12],
      sheet: [18, 23, 37, 1], scrim: [3, 5, 10, 0.78], shadow: [0.6],
      done: [94, 224, 168, 1], warn: [255, 184, 107, 1], danger: [255, 122, 133, 1],
      classes: [122, 167, 255, 1], work: [255, 184, 107, 1], personal: [94, 224, 168, 1], canvas: [201, 160, 255, 1]
    },
    day: {
      bg: [238, 236, 232, 1], card: [255, 255, 255, 0.6], cardHi: [255, 255, 255, 0.85],
      line: [30, 35, 50, 0.09], lineHi: [30, 35, 50, 0.17],
      text: [24, 28, 40, 1], text2: [24, 28, 40, 0.64], text3: [24, 28, 40, 0.44],
      surface: [255, 255, 255, 0.55], surfaceHi: [255, 255, 255, 0.92], footBg: [255, 255, 255, 0.35],
      sheet: [250, 249, 247, 1], scrim: [60, 58, 55, 0.35], shadow: [0.12],
      done: [28, 165, 108, 1], warn: [196, 108, 0, 1], danger: [208, 48, 64, 1],
      classes: [47, 111, 214, 1], work: [201, 112, 14, 1], personal: [22, 150, 100, 1], canvas: [128, 78, 200, 1]
    }
  };

  // Same hue, darker and stronger, so pastel night accents stay readable on a light background.
  function deepen(c) {
    const [r, g, b] = c.map((v) => v / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0;
    if (max !== min) {
      const d = max - min;
      h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
    }
    const sat = 0.75, light = 0.42;
    const k = (n) => (n + h / 30) % 12;
    const a = sat * Math.min(light, 1 - light);
    const f = (n) => light - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return [f(0) * 255, f(8) * 255, f(4) * 255];
  }

  // 0 at night, 1 in full daylight; eases over ~1.5h around sunrise and sunset.
  function daylight(m) {
    const sr = weather ? minutesOf(weather.today.sunrise) : 7 * 60;
    const ss = weather ? minutesOf(weather.today.sunset) : 19 * 60;
    return Math.min(smooth((m - (sr - 30)) / 90), smooth(((ss + 30) - m) / 90));
  }

  // WCAG relative luminance of an sRGB colour (0-255 channels).
  function luminance(c) {
    const [r, g, b] = c.slice(0, 3).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function updateSky(now) {
    const m = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
    const stops = skyStops();
    let i = stops.findIndex(([at], idx) => idx > 0 && m < at) - 1;
    if (i < 0) i = stops.length - 2;
    const [aAt, a] = stops[i];
    const [bAt, b] = stops[i + 1];
    const t = smooth(bAt > aAt ? (m - aAt) / (bAt - aAt) : 0);
    const L = daylight(m);

    const glowA = mix(a.glowA, b.glowA, t);
    const glowB = mix(a.glowB, b.glowB, t);
    const accent = mix(a.accent, b.accent, t);
    const N = THEME.night, D = THEME.day;
    // Everything that is a backdrop (page background, card/surface tints) fades continuously
    // with Lb, recomputed every second so there are no visible steps. Text and accents can't
    // blend through the middle (mid-grey text on a mid-grey page is unreadable), so they are
    // chosen from the luminance of what is actually underneath them: whichever of the night or
    // day ink has the better contrast. That swap lands exactly where both are equally readable.
    const Lb = smooth((L - 0.3) / 0.4);
    const v = (key) => mix(N[key], D[key], Lb);
    const bgTop = mix(mix(a.bgTop, b.bgTop, t), mix(D.bg, glowA, 0.18), Lb);
    const bg = v('bg');
    const card = v('card'), cardHi = v('cardHi');
    const under = mix(mix(bg, bgTop, 0.5), [255, 255, 255], card[3]); // bg as seen through a card
    const Y = luminance(under);
    const Yn = luminance(N.text), Yd = luminance(D.text);
    const cross = Math.sqrt((Yn + 0.05) * (Yd + 0.05)) - 0.05; // equal contrast with either ink
    const isDay = Y >= cross;
    const f = (key) => (isDay ? D : N)[key];
    // Faint secondary text gets more opaque near the swap, where contrast is at its lowest.
    const bump = 1 - smooth(Math.abs(Y - cross) / 0.2);
    const boost = (c, to) => [c[0], c[1], c[2], c[3] + (to - c[3]) * bump];

    const set = (name, value) => document.documentElement.style.setProperty(name, value);
    set('--glow-a', rgba(glowA));
    set('--glow-b', rgba(glowB));
    set('--bg-top', rgb(bgTop));
    set('--bg', rgb(bg));
    set('--accent', rgb(isDay ? deepen(accent) : accent));
    set('--accent-ink', rgb(isDay ? [255, 255, 255] : mix(a.ink, b.ink, t)));
    set('--card', rgba(card));
    set('--card-hi', rgba(cardHi));
    set('--line', rgba(f('line')));
    set('--line-hi', rgba(f('lineHi')));
    set('--text', rgb(f('text')));
    set('--text-2', rgba(boost(f('text2'), 0.92)));
    set('--text-3', rgba(boost(f('text3'), 0.78)));
    set('--surface', rgba(v('surface')));
    set('--surface-hi', rgba(v('surfaceHi')));
    set('--foot-bg', rgba(v('footBg')));
    set('--sheet', rgb(f('sheet')));
    set('--scrim', rgba(v('scrim')));
    set('--shadow-a', v('shadow')[0].toFixed(3));
    set('--done', rgb(f('done')));
    set('--warn', rgb(f('warn')));
    set('--danger', rgb(f('danger')));
    set('--cal-classes', rgb(f('classes')));
    set('--cal-work', rgb(f('work')));
    set('--cal-personal', rgb(f('personal')));
    set('--cal-canvas', rgb(f('canvas')));
    document.querySelector('meta[name="theme-color"]').setAttribute('content', rgb(bg));
  }

  // ---------- Clock (only touches DOM nodes whose text changed) ----------
  function tick() {
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();

    setText(els.seconds, String(now.getSeconds()).padStart(2, '0'));
    updateSky(now);

    if (m === lastMinute) return;
    lastMinute = m;

    fadeTime(els.time, `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}`);
    fadeText(els.ampm, h >= 12 ? 'PM' : 'AM');
    // The header shows the real calendar date; the rollover hour only shifts which day's tasks are shown.
    setText(els.date, now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }));
    setText(els.greeting, h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : h < 21 ? 'Good evening' : 'Good night');

    const dateKey = localDateKey(shiftForRollover(now));
    if (dateKey !== currentDateKey) {
      currentDateKey = dateKey;
      loadTasks();
    } else {
      renderTasks(); // re-evaluate "next" / "late" each minute
    }
  }

  // ---------- Weather ----------
  async function loadWeather() {
    try {
      const res = await fetch('/api/weather');
      const w = await res.json();
      if (!res.ok) throw new Error(w.error);
      weather = w;
      renderWeather();
      updateSky(new Date());
      maybeShareLocation();
    } catch (err) {
      setText(els.wLabel, 'Weather unavailable');
    }
  }

  // Geolocation only works on secure origins (HTTPS/localhost); elsewhere the server's IP fallback is used.
  let locationAsked = false;
  function maybeShareLocation() {
    if (locationAsked || weather.locationSource === 'env') return;
    if (!window.isSecureContext || !navigator.geolocation) return;
    locationAsked = true;
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const res = await fetch('/api/location', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lat: pos.coords.latitude, lon: pos.coords.longitude })
        });
        const result = await res.json();
        if (!result.ignored) loadWeather();
      } catch (err) { /* keep current weather */ }
    }, () => {}, { maximumAge: 6 * 60 * 60 * 1000, timeout: 20000 });
  }

  function renderWeather() {
    const w = weather;
    if (!w) return;
    setText(els.wIcon, w.current.icon);
    setText(els.wTemp, String(w.current.temp));
    setText(els.wLabel, w.current.label);
    setText(els.wFeels, `Feels like ${w.current.feelsLike}°`);
    setText(els.wCity, w.city);
    setText(els.wHiLo, `${w.today.high}° / ${w.today.low}°`);
    setText(els.wRain, `${w.today.rainChance}%`);
    setText(els.wHum, `${w.current.humidity}%`);
    setText(els.wWind, `${w.current.wind} ${w.windUnit}`);

    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const beforeSunrise = nowMin < minutesOf(w.today.sunrise);
    const afterSunset = nowMin >= minutesOf(w.today.sunset);
    const showSunrise = beforeSunrise || afterSunset;
    setText(els.wSunK, showSunrise ? 'Sunrise' : 'Sunset');
    setText(els.wSun, to12h(showSunrise ? w.today.sunrise : w.today.sunset).replace(' ', ' '));

    els.wForecast.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const day of w.forecast) {
      const d = new Date(day.date + 'T12:00:00');
      const col = document.createElement('div');
      col.className = 'fc';
      col.innerHTML =
        `<div class="fc-day"></div><div class="fc-icon"></div>` +
        `<div class="fc-temps"><span class="hi"></span><span class="lo"></span></div><div class="fc-rain"></div>`;
      col.querySelector('.fc-day').textContent = d.toLocaleDateString(undefined, { weekday: 'short' });
      col.querySelector('.fc-icon').textContent = day.icon;
      col.querySelector('.hi').textContent = `${day.high}°`;
      col.querySelector('.lo').textContent = `${day.low}°`;
      col.querySelector('.fc-rain').textContent = day.rainChance >= 20 ? `${day.rainChance}%` : '';
      col.title = day.label;
      frag.appendChild(col);
    }
    els.wForecast.appendChild(frag);
  }

  // ---------- Tasks ----------
  async function loadTasks() {
    try {
      const res = await fetch(`/api/today?date=${currentDateKey}`);
      const data = await res.json();
      const json = JSON.stringify([data.tasks, data.problems]);
      if (json === lastTasksJSON) return;
      lastTasksJSON = json;
      tasks = data.tasks;
      problems = data.problems || [];
      renderTasks();
    } catch (err) {
      /* keep showing last known list */
    }
  }

  const CHECK_SVG = '<svg viewBox="0 0 24 24"><polyline points="5 12.5 10 17.5 19 7"></polyline></svg>';

  function timeRange(start, end) {
    const a = to12h(start).split(' ');
    const b = to12h(end).split(' ');
    return a[1] === b[1] ? `${a[0]} – ${b[0]} ${b[1]}` : `${a.join(' ')} – ${b.join(' ')}`;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderProblems(frag) {
    if (!problems.length) return;
    const box = el('div', 'problems');
    box.appendChild(el('div', 'problems-title', 'Heads up'));
    for (const p of problems) {
      box.appendChild(el('div', 'problem', p.line ? `tasks.txt line ${p.line}: ${p.reason}` : p.reason));
    }
    frag.appendChild(box);
  }

  // 'past' once an event has ended, 'now' while it's running; all-day events have no state.
  // Minutes into the day being shown. Between midnight and the rollover hour the list is still
  // the previous calendar day's, so the clock is past all of it (not early in it).
  function dayMinutes(now) {
    const mins = now.getHours() * 60 + now.getMinutes();
    return currentDateKey < localDateKey(now) ? mins + 24 * 60 : mins;
  }

  function eventState(task, nowMin) {
    if (task.allDay || !task.time || !task.endTime) return '';
    const e = task.endTime > task.time ? minutesOf(task.endTime) : 24 * 60;
    if (nowMin >= e) return 'past';
    return nowMin >= minutesOf(task.time) ? 'now' : '';
  }

  function eventRow(task, nowMin) {
    const row = el('div', `task event cal-${task.calendar}`);
    const state = eventState(task, nowMin);
    if (state) row.classList.add(state);

    row.appendChild(el('div', 'cal-bar'));
    const body = el('div', 'task-body');
    body.appendChild(el('div', 'task-text', task.text));
    if (task.meta || state === 'now') {
      const meta = el('div', 'task-meta');
      if (state === 'now') meta.appendChild(el('span', 'badge', 'Now'));
      if (task.meta) meta.appendChild(el('span', '', task.meta));
      body.appendChild(meta);
    }
    row.appendChild(body);
    if (task.time && task.endTime) row.appendChild(el('div', 'task-time', timeRange(task.time, task.endTime)));
    return row;
  }

  function checkRow(task, next, nowMin) {
    const late = !task.done && task.time && minutesOf(task.time) < nowMin && task !== next;
    const row = el('div', 'task' + (task.done ? ' done' : '') + (task === next ? ' next' : '') + (late ? ' late' : ''));
    if (task.kind === 'assignment') row.classList.add('assignment', `cal-${task.calendar}`);

    const check = el('div', 'check');
    check.innerHTML = CHECK_SVG;
    row.appendChild(check);

    const body = el('div', 'task-body');
    const text = el('div', 'task-text');
    text.appendChild(el('span', 'strike', task.text));
    body.appendChild(text);
    const metaText = task.kind === 'routine'
      ? [task.meta, Array.isArray(task.days) ? formatDays(task.days) : ''].filter(Boolean).join(' · ')
      : task.meta || '';
    if (metaText || task === next) {
      const meta = el('div', 'task-meta');
      if (task === next) meta.appendChild(el('span', 'badge', 'Up next'));
      if (metaText) meta.appendChild(el('span', '', metaText));
      body.appendChild(meta);
    }
    row.appendChild(body);

    if (task.time) row.appendChild(el('div', 'task-time', to12h(task.time)));

    if (task.kind === 'routine' || task.kind === 'todo') {
      const del = el('button', 'task-del', '✕');
      del.setAttribute('aria-label', 'Delete');
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteTask(task); });
      row.appendChild(del);
    }

    row.addEventListener('click', () => { if (!editing) toggleTask(task, row); });
    return row;
  }

  function updateSummary(now = new Date()) {
    const nowMin = dayMinutes(now);
    const checkable = tasks.filter((t) => t.kind !== 'event');
    // Timed events join the count as done once they've ended (all-day ones can't finish, so they never count).
    const events = countEvents ? tasks.filter((t) => t.kind === 'event' && t.time && t.endTime) : [];
    const counted = [...(countTodos ? checkable : checkable.filter((t) => t.kind !== 'todo')), ...events];
    const isDone = (t) => (t.kind === 'event' ? eventState(t, nowMin) === 'past' : t.done);
    const doneCount = counted.filter(isDone).length;
    const total = counted.length;
    const pct = total ? Math.round((doneCount / total) * 100) : 0;
    els.ringFill.style.strokeDashoffset = String(RING_LEN * (1 - (total ? doneCount / total : 0)));
    setText(els.ringPct, `${pct}%`);
    setText(els.sub, total ? `${doneCount} of ${total} done` : 'Nothing to check off');
    return { checkable, doneCount, total };
  }

  function renderTasks() {
    if (lastTasksJSON === '' && !tasks.length) return; // not loaded yet; avoid flashing the empty state
    const now = new Date();
    const nowMin = dayMinutes(now);

    const { checkable, doneCount, total } = updateSummary(now);

    // "Next" = earliest unfinished timed item that isn't more than 30 min overdue
    const next = checkable.find((t) => !t.done && t.time && minutesOf(t.time) >= nowMin - 30);

    els.scroll.innerHTML = '';
    const frag = document.createDocumentFragment();
    renderProblems(frag);

    if (!tasks.length) {
      const empty = el('div', 'empty');
      empty.innerHTML = '<div class="empty-big">A clear day</div><div>Tap “New task” to add one.</div>';
      frag.appendChild(empty);
    }

    let lastGroup = null;
    for (const task of tasks) {
      if (task.group !== lastGroup) {
        frag.appendChild(el('div', 'group-label', task.group));
        lastGroup = task.group;
      }
      frag.appendChild(task.kind === 'event' ? eventRow(task, nowMin) : checkRow(task, next, nowMin));
    }

    if (total && doneCount === total) frag.appendChild(el('div', 'all-done', 'All done for today'));
    els.scroll.appendChild(frag);
  }

  function formatDays(days) {
    const set = new Set(days);
    if (WEEKDAYS.every((d) => set.has(d)) && set.size === 5) return 'Weekdays';
    if (WEEKENDS.every((d) => set.has(d)) && set.size === 2) return 'Weekends';
    const order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    return order.filter((d) => set.has(d)).map((d) => d[0].toUpperCase() + d.slice(1)).join(' · ');
  }

  // Flip the row in place so its CSS transitions play; rebuild once they finish to move "Up next".
  let settleTimer = null;
  function applyToggle(task, row) {
    task.done = !task.done;
    row.classList.toggle('done', task.done);
    row.classList.remove('pop');
    void row.offsetWidth; // restart the press animation
    row.classList.add('pop');
    updateSummary();
    clearTimeout(settleTimer);
    settleTimer = setTimeout(renderTasks, 650);
  }

  async function toggleTask(task, row) {
    applyToggle(task, row);
    const id = encodeURIComponent(task.id);
    const url = task.kind === 'assignment' ? `/api/assignments/${id}/toggle`
      : task.kind === 'todo' ? `/api/todos/${id}/toggle?date=${currentDateKey}`
      : `/api/today/${id}/toggle?date=${currentDateKey}`;
    try {
      const res = await fetch(url, { method: 'POST' });
      if (!res.ok) throw new Error();
      lastTasksJSON = JSON.stringify([tasks, problems]);
    } catch (err) {
      applyToggle(task, row);
    }
  }

  async function deleteTask(task) {
    const base = task.kind === 'todo' ? '/api/todos/' : '/api/tasks/';
    await fetch(base + encodeURIComponent(task.id), { method: 'DELETE' });
    lastTasksJSON = '';
    loadTasks();
  }

  // ---------- Edit mode ----------
  els.editBtn.addEventListener('click', () => {
    editing = !editing;
    els.pane.classList.toggle('editing', editing);
    els.editBtn.classList.toggle('active', editing);
    els.editBtn.textContent = editing ? 'Done' : 'Edit';
  });

  // ---------- Add modal ----------
  let selectedDays = new Set();
  let preset = 'all';
  let when = 'anytime';

  function syncForm() {
    els.daysRow.querySelectorAll('button').forEach((b) => b.classList.toggle('selected', selectedDays.has(b.dataset.day)));
    els.presets.querySelectorAll('button').forEach((b) => b.classList.toggle('selected', b.dataset.preset === preset));
    els.whenRow.querySelectorAll('button').forEach((b) => b.classList.toggle('selected', !els.addTime.value && b.dataset.when === when));
    els.addTime.classList.toggle('selected', !!els.addTime.value);
    // One-time to-dos have no schedule; "every other day" has no fixed weekdays.
    els.whenField.classList.toggle('muted', preset === 'once');
    els.daysRow.classList.toggle('muted', preset === 'once' || preset === 'every2');
  }

  function presetFromDays() {
    const n = selectedDays.size;
    if (n === 0) return 'all';
    if (n === 5 && WEEKDAYS.every((d) => selectedDays.has(d))) return 'weekdays';
    if (n === 2 && WEEKENDS.every((d) => selectedDays.has(d))) return 'weekends';
    return null;
  }

  function openModal() {
    els.addText.value = '';
    els.addTime.value = '';
    selectedDays = new Set();
    preset = 'all';
    when = 'anytime';
    syncForm();
    els.modal.classList.add('open');
    setTimeout(() => els.addText.focus(), 50);
  }

  function closeModal() {
    els.modal.classList.remove('open');
    els.addText.blur();
  }

  els.addBtn.addEventListener('click', openModal);
  els.cancelBtn.addEventListener('click', closeModal);
  els.modal.addEventListener('click', (e) => { if (e.target === els.modal) closeModal(); });

  els.whenRow.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      when = btn.dataset.when;
      els.addTime.value = '';
      syncForm();
    });
  });
  els.addTime.addEventListener('input', syncForm);

  els.presets.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      preset = btn.dataset.preset;
      selectedDays = new Set(preset === 'weekdays' ? WEEKDAYS : preset === 'weekends' ? WEEKENDS : []);
      syncForm();
    });
  });

  els.daysRow.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (preset === 'once' || preset === 'every2') return;
      const day = btn.dataset.day;
      if (selectedDays.has(day)) selectedDays.delete(day); else selectedDays.add(day);
      if (selectedDays.size === 7) selectedDays.clear();
      preset = presetFromDays();
      syncForm();
    });
  });

  async function saveTask() {
    const text = els.addText.value.trim();
    if (!text) { els.addText.focus(); return; }
    const body = preset === 'once'
      ? { text, once: true }
      : {
        text,
        time: els.addTime.value || null,
        part: els.addTime.value ? null : when,
        days: preset === 'every2' ? [] : [...selectedDays],
        every: preset === 'every2' ? 2 : null
      };
    await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    closeModal();
    lastTasksJSON = '';
    loadTasks();
  }

  els.saveBtn.addEventListener('click', saveTask);
  els.addText.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveTask(); });

  // ---------- Week view (calendars only, no routines; weeks run Sunday–Saturday) ----------
  const fmtDay = (key, opts) => new Date(key + 'T12:00:00').toLocaleDateString(undefined, opts);

  function addDaysKey(key, n) {
    const d = new Date(key + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return localDateKey(d);
  }

  const sundayOf = (key) => addDaysKey(key, -new Date(key + 'T12:00:00').getDay());

  function weekItem(item) {
    const card = el('div', `wk-item cal-${item.calendar}` + (item.done ? ' done' : ''));
    const when = item.allDay ? 'All day'
      : item.kind === 'assignment' ? (item.time ? `Due ${to12h(item.time)}` : 'Due')
      : item.endTime ? timeRange(item.time, item.endTime) : to12h(item.time);
    card.appendChild(el('div', 'wk-time', when));
    card.appendChild(el('div', 'wk-title', item.text));
    const meta = item.kind === 'assignment' ? item.meta.split(' · ')[0] : item.meta;
    if (meta) card.appendChild(el('div', 'wk-meta', meta));
    return card;
  }

  // Weeks are cached by their Sunday; the current one is prefetched so the button opens instantly
  // (the Fire takes seconds per request).
  const weekCache = new Map();
  let weekOffset = 0;

  const shownWeekStart = () => addDaysKey(sundayOf(currentDateKey), weekOffset * 7);

  function renderWeek(animate) {
    const start = shownWeekStart();
    const end = addDaysKey(start, 6);
    setText(els.weekTitle, weekOffset === 0 ? 'This week' : weekOffset === 1 ? 'Next week' : weekOffset === -1 ? 'Last week'
      : fmtDay(start, { month: 'long', day: 'numeric' }));
    setText(els.weekRange, `${fmtDay(start, { month: 'short', day: 'numeric' })} – ${fmtDay(end, { month: 'short', day: 'numeric' })}`);

    const data = weekCache.get(start);
    if (!data) {
      els.weekGrid.innerHTML = '<div class="wk-loading">Loading…</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    data.days.forEach((day, i) => {
      const isToday = day.date === currentDateKey;
      const col = el('div', 'wk-day' + (isToday ? ' today' : '') + (day.date < currentDateKey ? ' past' : '') + (animate ? ' rise' : ''));
      if (animate) col.style.animationDelay = `${40 + i * 30}ms`;
      const head = el('div', 'wk-head');
      head.appendChild(el('div', 'wk-name', isToday ? 'Today' : fmtDay(day.date, { weekday: 'long' })));
      head.appendChild(el('div', 'wk-date', fmtDay(day.date, { month: 'short', day: 'numeric' })));
      col.appendChild(head);
      if (!day.items.length) col.appendChild(el('div', 'wk-empty', 'Nothing scheduled'));
      day.items.forEach((item) => col.appendChild(weekItem(item)));
      frag.appendChild(col);
    });
    els.weekGrid.innerHTML = '';
    els.weekGrid.appendChild(frag);
  }

  async function loadWeek(start = shownWeekStart()) {
    try {
      const res = await fetch(`/api/week?start=${start}`);
      weekCache.set(start, await res.json());
      if (els.weekModal.classList.contains('open') && start === shownWeekStart()) renderWeek(false);
    } catch (err) { /* keep the last copy */ }
  }

  function openWeek() {
    weekOffset = 0;
    renderWeek(true);
    els.weekModal.classList.add('open');
    loadWeek();
  }

  function stepWeek(delta) {
    weekOffset += delta;
    const start = shownWeekStart();
    renderWeek(true);
    loadWeek(start);
    // Warm the next step in the same direction so repeated taps feel instant.
    const ahead = addDaysKey(start, delta * 7);
    if (!weekCache.has(ahead)) loadWeek(ahead);
  }

  els.weekBtn.addEventListener('click', openWeek);
  els.weekPrev.addEventListener('click', () => stepWeek(-1));
  els.weekNext.addEventListener('click', () => stepWeek(1));
  els.weekClose.addEventListener('click', () => els.weekModal.classList.remove('open'));
  els.weekModal.addEventListener('click', (e) => { if (e.target === els.weekModal) els.weekModal.classList.remove('open'); });

  // ---------- Calendar refresh ----------
  els.refreshBtn.addEventListener('click', async () => {
    if (els.refreshBtn.classList.contains('spinning')) return;
    els.refreshBtn.classList.add('spinning');
    const minSpin = new Promise((r) => setTimeout(r, 700));
    try {
      await fetch('/api/calendars/refresh', { method: 'POST' });
      lastTasksJSON = '';
      weekCache.clear();
      await Promise.all([loadTasks(), loadWeek(), minSpin]);
    } finally {
      els.refreshBtn.classList.remove('spinning');
    }
  });

  // ---------- Fullscreen ----------
  // Browsers only allow fullscreen from a user gesture, so any tap (re-)enters it.
  const root = document.documentElement;
  function enterFullscreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) return;
    if (root.requestFullscreen) {
      root.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    } else if (root.webkitRequestFullscreen) {
      root.webkitRequestFullscreen();
    }
  }
  document.addEventListener('click', enterFullscreen, true);

  // ---------- Boot ----------
  async function boot() {
    try {
      const res = await fetch('/api/config');
      const cfg = await res.json();
      rolloverHour = Number(cfg.dayRolloverHour) || 0;
      clockFade = Number(cfg.clockFadeSeconds) || 0;
      countEvents = !!cfg.countEvents;
      countTodos = cfg.countTodos !== false;
    } catch (err) { /* default: rolls over at midnight */ }
    currentDateKey = localDateKey(shiftForRollover(new Date()));

    tick();
    setInterval(tick, 1000);
    loadTasks();
    setInterval(loadTasks, 30 * 1000);
    loadWeather();
    setInterval(loadWeather, 10 * 60 * 1000);
    loadWeek(sundayOf(currentDateKey));
    setInterval(() => loadWeek(sundayOf(currentDateKey)), 5 * 60 * 1000);
  }
  boot();
})();
