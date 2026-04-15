import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const sourceOptions = [
  ['avito', 'Авито'],
  ['cian', 'ЦИАН'],
  ['yandex', 'Яндекс'],
  ['domclick', 'ДомКлик']
];

const propertyOptions = [
  ['room', 'Комнаты'],
  ['flat', 'Квартиры']
];

const defaultConfig = {
  enabled: true,
  city: 'Москва',
  query: '',
  sources: ['avito', 'cian', 'yandex', 'domclick'],
  propertyTypes: ['room', 'flat'],
  rooms: [1],
  priceMin: 14000,
  priceMax: 40000,
  areaMin: '',
  areaMax: '',
  metroMinutesMin: '',
  metroMinutesMax: 30,
  metroMode: 'any',
  buildYearMin: 1995,
  buildYearMax: '',
  floorMin: '',
  floorMax: '',
  floorsTotalMin: '',
  floorsTotalMax: '',
  autostart: true
};

function toRequest(path, options = {}) {
  return fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  }).then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  });
}

function ToggleGroup({ label, options, value, onChange }) {
  const selected = Array.isArray(value) ? value : [];
  return (
    <fieldset className="fieldSet">
      <legend>{label}</legend>
      <div className="toggleGrid">
        {options.map(([id, text]) => (
          <label className={selected.includes(id) ? 'toggle active' : 'toggle'} key={id}>
            <input
              type="checkbox"
              checked={selected.includes(id)}
              onChange={(event) => {
                const next = event.target.checked
                  ? [...selected, id]
                  : selected.filter((item) => item !== id);
                onChange(next);
              }}
            />
            <span>{text}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function NumberInput({ label, value, onChange, placeholder }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value === '' ? '' : Number(event.target.value))}
      />
    </label>
  );
}

function App() {
  const [config, setConfig] = useState(defaultConfig);
  const [status, setStatus] = useState(null);
  const [targets, setTargets] = useState([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const dirtyRef = useRef(false);

  const roomOptions = useMemo(() => [1, 2, 3, 4, 5].map((room) => [room, `${room}`]), []);

  const loadStatus = ({ syncConfig = false } = {}) => {
    toRequest('/api/status')
      .then((data) => {
        setStatus(data);
        if (syncConfig || !dirtyRef.current) {
          setConfig(data.config || defaultConfig);
          setTargets(data.targets || []);
          dirtyRef.current = false;
        }
      })
      .catch((error) => setMessage(`Ошибка статуса: ${error.message}`));
  };

  useEffect(() => {
    loadStatus({ syncConfig: true });
    const timer = window.setInterval(loadStatus, 5000);
    return () => window.clearInterval(timer);
  }, []);

  const updateConfig = (key, value) => {
    dirtyRef.current = true;
    setConfig((current) => ({ ...current, [key]: value }));
  };

  const saveConfig = async () => {
    setBusy(true);
    setMessage('');
    try {
      const data = await toRequest('/api/config', {
        method: 'PUT',
        body: JSON.stringify(config)
      });
      setConfig(data.config);
      setTargets(data.targets || []);
      dirtyRef.current = false;
      setMessage(data.restarted ? 'Фильтры сохранены, бот перезапускается' : 'Фильтры сохранены');
      loadStatus();
    } catch (error) {
      setMessage(`Ошибка сохранения: ${error.message}`);
    } finally {
      setBusy(false);
    }
  };

  const controlBot = async (action) => {
    setBusy(true);
    setMessage('');
    try {
      const data = await toRequest(`/api/bot/${action}`, { method: 'POST' });
      setStatus(data);
      setMessage(action === 'start' ? 'Бот запускается' : 'Бот останавливается');
      window.setTimeout(loadStatus, 1200);
    } catch (error) {
      setMessage(`Ошибка команды: ${error.message}`);
    } finally {
      setBusy(false);
    }
  };

  const logs = status?.logs || [];
  const running = Boolean(status?.running);

  return (
    <main className="page">
      <section className="topBar">
        <div>
          <p className="eyebrow">Недвижимость</p>
          <h1>Авито ЦИАН</h1>
        </div>
        <div className={running ? 'status running' : 'status stopped'}>
          <span>{running ? 'Работает' : 'Остановлен'}</span>
          <strong>{status?.pid ? `PID ${status.pid}` : 'PID нет'}</strong>
        </div>
      </section>

      <section className="actions">
        <button disabled={busy || running} onClick={() => controlBot('start')}>Запустить бота</button>
        <button className="danger" disabled={busy || !running} onClick={() => controlBot('stop')}>Остановить бота</button>
        <button className="secondary" disabled={busy} onClick={saveConfig}>Сохранить фильтры</button>
        <label className="check">
          <input
            type="checkbox"
            checked={Boolean(config.autostart)}
            onChange={(event) => updateConfig('autostart', event.target.checked)}
          />
          <span>Автозапуск после деплоя</span>
        </label>
      </section>

      {message && <div className="notice">{message}</div>}

      <section className="layout">
        <form className="panel" onSubmit={(event) => event.preventDefault()}>
          <div className="sectionTitle">
            <h2>Фильтры</h2>
            <p>Ссылки на найденные объекты отправляются в Telegram.</p>
          </div>

          <div className="grid two">
            <label className="field">
              <span>Город</span>
              <input value={config.city || ''} onChange={(event) => updateConfig('city', event.target.value)} />
            </label>
            <label className="field">
              <span>Что ищем</span>
              <input value={config.query || ''} placeholder="метро, район, ключевые слова" onChange={(event) => updateConfig('query', event.target.value)} />
            </label>
          </div>

          <div className="grid two">
            <ToggleGroup label="Источники" options={sourceOptions} value={config.sources} onChange={(value) => updateConfig('sources', value)} />
            <ToggleGroup label="Тип объекта" options={propertyOptions} value={config.propertyTypes} onChange={(value) => updateConfig('propertyTypes', value)} />
          </div>

          <ToggleGroup label="Количество комнат" options={roomOptions} value={config.rooms} onChange={(value) => updateConfig('rooms', value.map(Number))} />

          <div className="grid four">
            <NumberInput label="Цена от" value={config.priceMin} onChange={(value) => updateConfig('priceMin', value)} />
            <NumberInput label="Цена до" value={config.priceMax} onChange={(value) => updateConfig('priceMax', value)} />
            <NumberInput label="Площадь от" value={config.areaMin} onChange={(value) => updateConfig('areaMin', value)} />
            <NumberInput label="Площадь до" value={config.areaMax} onChange={(value) => updateConfig('areaMax', value)} />
          </div>

          <div className="grid three">
            <NumberInput label="Метро от, мин" value={config.metroMinutesMin} onChange={(value) => updateConfig('metroMinutesMin', value)} />
            <NumberInput label="Метро до, мин" value={config.metroMinutesMax} onChange={(value) => updateConfig('metroMinutesMax', value)} />
            <label className="field">
              <span>Как добираться</span>
              <select value={config.metroMode || 'any'} onChange={(event) => updateConfig('metroMode', event.target.value)}>
                <option value="any">Любой вариант</option>
                <option value="foot">Пешком</option>
                <option value="transport">На транспорте</option>
              </select>
            </label>
          </div>

          <div className="grid four">
            <NumberInput label="Год от" value={config.buildYearMin} onChange={(value) => updateConfig('buildYearMin', value)} />
            <NumberInput label="Год до" value={config.buildYearMax} onChange={(value) => updateConfig('buildYearMax', value)} />
            <NumberInput label="Этаж от" value={config.floorMin} onChange={(value) => updateConfig('floorMin', value)} />
            <NumberInput label="Этаж до" value={config.floorMax} onChange={(value) => updateConfig('floorMax', value)} />
          </div>

          <div className="grid two">
            <NumberInput label="Этажность от" value={config.floorsTotalMin} onChange={(value) => updateConfig('floorsTotalMin', value)} />
            <NumberInput label="Этажность до" value={config.floorsTotalMax} onChange={(value) => updateConfig('floorsTotalMax', value)} />
          </div>
        </form>

        <aside className="side">
          <div className="panel compact">
            <h2>Поиск</h2>
            <div className="targetList">
              {targets.map((target) => (
                <a key={`${target.type}-${target.propertyType}`} href={target.url} target="_blank" rel="noreferrer">
                  <span>{target.label}</span>
                  <small>{target.url}</small>
                </a>
              ))}
            </div>
          </div>

          <div className="panel compact logPanel">
            <h2>Логи</h2>
            <div className="logs">
              {logs.length === 0 && <p>Логов пока нет</p>}
              {logs.slice().reverse().map((log, index) => (
                <div className="logLine" key={`${log.time}-${index}`}>
                  <time>{new Date(log.time).toLocaleTimeString('ru-RU')}</time>
                  <span>{log.text}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
