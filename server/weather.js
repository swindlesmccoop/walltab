const { getLocation } = require('./location');

const TEMP_UNIT = process.env.TEMP_UNIT === 'celsius' ? 'celsius' : 'fahrenheit';

const CACHE_MS = 10 * 60 * 1000; // 10 minutes
let cache = { data: null, fetchedAt: 0 };

function clearCache() {
  cache = { data: null, fetchedAt: 0 };
}

// Rough WMO weather_code -> { icon, label } mapping
function describeCode(code) {
  const table = {
    0: ['☀️', 'Clear'],
    1: ['🌤️', 'Mostly clear'],
    2: ['⛅', 'Partly cloudy'],
    3: ['☁️', 'Overcast'],
    45: ['🌫️', 'Fog'],
    48: ['🌫️', 'Fog'],
    51: ['🌦️', 'Light drizzle'],
    53: ['🌦️', 'Drizzle'],
    55: ['🌦️', 'Heavy drizzle'],
    56: ['🌦️', 'Freezing drizzle'],
    57: ['🌦️', 'Freezing drizzle'],
    61: ['🌧️', 'Light rain'],
    63: ['🌧️', 'Rain'],
    65: ['🌧️', 'Heavy rain'],
    66: ['🌧️', 'Freezing rain'],
    67: ['🌧️', 'Freezing rain'],
    71: ['🌨️', 'Light snow'],
    73: ['🌨️', 'Snow'],
    75: ['❄️', 'Heavy snow'],
    77: ['❄️', 'Snow grains'],
    80: ['🌦️', 'Rain showers'],
    81: ['🌧️', 'Rain showers'],
    82: ['🌧️', 'Violent showers'],
    85: ['🌨️', 'Snow showers'],
    86: ['❄️', 'Snow showers'],
    95: ['⛈️', 'Thunderstorm'],
    96: ['⛈️', 'Thunderstorm, hail'],
    99: ['⛈️', 'Severe thunderstorm']
  };
  return table[code] || ['❓', 'Unknown'];
}

async function fetchWeather() {
  const now = Date.now();
  if (cache.data && now - cache.fetchedAt < CACHE_MS) {
    return cache.data;
  }

  const loc = await getLocation();
  const windUnit = TEMP_UNIT === 'celsius' ? 'kmh' : 'mph';
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,wind_speed_10m` +
    `&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,sunrise,sunset` +
    `&temperature_unit=${TEMP_UNIT}&wind_speed_unit=${windUnit}&forecast_days=6&timezone=auto`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`weather upstream ${res.status}`);
  const json = await res.json();
  const d = json.daily;

  let [icon, label] = describeCode(json.current.weather_code);
  if (!json.current.is_day && json.current.weather_code <= 1) icon = '🌙';

  const data = {
    city: loc.city,
    locationSource: loc.source,
    unit: TEMP_UNIT === 'celsius' ? 'C' : 'F',
    windUnit: windUnit === 'kmh' ? 'km/h' : 'mph',
    current: {
      temp: Math.round(json.current.temperature_2m),
      feelsLike: Math.round(json.current.apparent_temperature),
      humidity: Math.round(json.current.relative_humidity_2m),
      wind: Math.round(json.current.wind_speed_10m),
      isDay: !!json.current.is_day,
      icon,
      label
    },
    today: {
      high: Math.round(d.temperature_2m_max[0]),
      low: Math.round(d.temperature_2m_min[0]),
      rainChance: d.precipitation_probability_max[0] ?? 0,
      sunrise: d.sunrise[0].slice(11, 16),
      sunset: d.sunset[0].slice(11, 16)
    },
    forecast: d.time.slice(1, 6).map((date, i) => {
      const [fIcon, fLabel] = describeCode(d.weather_code[i + 1]);
      return {
        date,
        icon: fIcon,
        label: fLabel,
        high: Math.round(d.temperature_2m_max[i + 1]),
        low: Math.round(d.temperature_2m_min[i + 1]),
        rainChance: d.precipitation_probability_max[i + 1] ?? 0
      };
    }),
    updatedAt: new Date().toISOString()
  };

  cache = { data, fetchedAt: now };
  return data;
}

module.exports = { fetchWeather, clearCache };
