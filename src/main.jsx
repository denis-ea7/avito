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
  sources: ['avito', 'cian', 'yandex', 'domclick'],
  propertyTypes: ['room', 'flat'],
  rooms: [1],
  priceMin: 14000,
  priceMax: 40000,
  flatRooms: [1],
  roomFlatRooms: [],
  flatPriceMin: 14000,
  flatPriceMax: 40000,
  roomPriceMin: 14000,
  roomPriceMax: 40000,
  totalAreaMin: '',
  totalAreaMax: '',
  roomAreaMin: '',
  roomAreaMax: '',
  metroMinutesMin: '',
  metroMinutesMax: 30,
  metroMode: 'any',
  centerTransitMinutesMax: '',
  buildYearMin: 1995,
  buildYearMax: '',
  floorMin: '',
  floorMax: '',
  floorsTotalMin: '',
  floorsTotalMax: '',
  sellerType: 'any',
  deposit: 'any',
  roomOwnerOnly: false,
  roomNoDepositOnly: false,
  aiEnabled: false,
  aiProvider: 'deepseek',
  aiModel: 'deepseek-chat',
  deepseekApiKey: '',
  deepseekApiKeySet: false,
  autostart: true,
  proxyMode: 'off',
  proxyList: ''
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

function ToggleGroup({ label, options, value, onChange, variant = 'fieldset' }) {
  const selected = Array.isArray(value) ? value : [];
  const content = (
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
  );
  if (variant === 'block') {
    return (
      <div className="toggleBlock">
        <div>{label}</div>
        {content}
      </div>
    );
  }
  return (
    <fieldset className="fieldSet">
      <legend>{label}</legend>
      {content}
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

function CheckboxField({ label, checked, onChange }) {
  return (
    <label className="check inlineCheck">
      <input
        type="checkbox"
        checked={Boolean(checked)}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function LogText({ log }) {
  if (!log.url) return log.text;
  const match = log.text.match(/(Комната|Квартира)/);
  if (!match) {
    return <a href={log.url} target="_blank" rel="noreferrer">{log.text}</a>;
  }
  const start = match.index;
  const end = start + match[0].length;
  return (
    <>
      {log.text.slice(0, start)}
      <a href={log.url} target="_blank" rel="noreferrer">{match[0]}</a>
      {log.text.slice(end)}
    </>
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
            <ToggleGroup label="Источники" options={sourceOptions} value={config.sources} onChange={(value) => updateConfig('sources', value)} />
            <ToggleGroup label="Тип объекта" options={propertyOptions} value={config.propertyTypes} onChange={(value) => updateConfig('propertyTypes', value)} />
          </div>

          <fieldset className="fieldSet">
            <legend>Квартиры</legend>
            <ToggleGroup variant="block" label="Количество комнат" options={roomOptions} value={config.flatRooms || config.rooms} onChange={(value) => updateConfig('flatRooms', value.map(Number))} />
            <div className="grid two noBottom">
              <NumberInput label="Цена квартиры от" value={config.flatPriceMin} onChange={(value) => updateConfig('flatPriceMin', value)} />
              <NumberInput label="Цена квартиры до" value={config.flatPriceMax} onChange={(value) => updateConfig('flatPriceMax', value)} />
            </div>
          </fieldset>

          <fieldset className="fieldSet">
            <legend>Комнаты</legend>
            <ToggleGroup variant="block" label="Комнат в квартире" options={roomOptions} value={config.roomFlatRooms} onChange={(value) => updateConfig('roomFlatRooms', value.map(Number))} />
            <div className="grid four">
              <NumberInput label="Цена комнаты от" value={config.roomPriceMin} onChange={(value) => updateConfig('roomPriceMin', value)} />
              <NumberInput label="Цена комнаты до" value={config.roomPriceMax} onChange={(value) => updateConfig('roomPriceMax', value)} />
              <NumberInput label="Площадь комнаты от" value={config.roomAreaMin} onChange={(value) => updateConfig('roomAreaMin', value)} />
              <NumberInput label="Площадь комнаты до" value={config.roomAreaMax} onChange={(value) => updateConfig('roomAreaMax', value)} />
            </div>
            <div className="checkRow">
              <CheckboxField label="Только собственник" checked={config.roomOwnerOnly} onChange={(value) => updateConfig('roomOwnerOnly', value)} />
              <CheckboxField label="Только без залога" checked={config.roomNoDepositOnly} onChange={(value) => updateConfig('roomNoDepositOnly', value)} />
            </div>
          </fieldset>

          <div className="grid two">
            <NumberInput label="Общая площадь от" value={config.totalAreaMin} onChange={(value) => updateConfig('totalAreaMin', value)} />
            <NumberInput label="Общая площадь до" value={config.totalAreaMax} onChange={(value) => updateConfig('totalAreaMax', value)} />
          </div>

          <div className="grid two">
            <label className="field">
              <span>Кто сдает, если известно</span>
              <select value={config.sellerType || 'any'} onChange={(event) => updateConfig('sellerType', event.target.value)}>
                <option value="any">Не важно</option>
                <option value="owner">Собственник</option>
                <option value="agent">Посредник</option>
              </select>
            </label>
            <label className="field">
              <span>Залог, если известно</span>
              <select value={config.deposit || 'any'} onChange={(event) => updateConfig('deposit', event.target.value)}>
                <option value="any">Не важно</option>
                <option value="yes">Есть залог</option>
                <option value="no">Без залога</option>
              </select>
            </label>
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

          <div className="grid two">
            <NumberInput label="От Охотного ряда на транспорте до, мин" value={config.centerTransitMinutesMax} onChange={(value) => updateConfig('centerTransitMinutesMax', value)} />
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

          <fieldset className="fieldSet">
            <legend>ИИ-фильтр DeepSeek</legend>
            <label className="check inlineCheck">
              <input
                type="checkbox"
                checked={Boolean(config.aiEnabled)}
                onChange={(event) => updateConfig('aiEnabled', event.target.checked)}
              />
              <span>Использовать ИИ для финальной проверки объявлений</span>
            </label>
            <div className="grid two aiGrid">
              <label className="field">
                <span>Модель</span>
                <input value={config.aiModel || ''} placeholder="deepseek-chat" onChange={(event) => updateConfig('aiModel', event.target.value)} />
              </label>
              <label className="field">
                <span>API ключ DeepSeek</span>
                <input
                  type="password"
                  value={config.deepseekApiKey || ''}
                  placeholder={config.deepseekApiKeySet ? 'Ключ сохранен, новый можно вставить сюда' : 'sk-...'}
                  onChange={(event) => updateConfig('deepseekApiKey', event.target.value)}
                />
              </label>
            </div>
          </fieldset>

          <fieldset className="fieldSet">
            <legend>Прокси</legend>
            <div className="grid two aiGrid">
              <label className="field">
                <span>Режим прокси</span>
                <select value={config.proxyMode || 'off'} onChange={(event) => updateConfig('proxyMode', event.target.value)}>
                  <option value="off">Выключены</option>
                  <option value="on">Всегда использовать</option>
                  <option value="alternate">Через раз</option>
                </select>
              </label>
              <label className="field">
                <span>Формат строк</span>
                <input value="host:port:user:pass или http://user:pass@host:port" readOnly />
              </label>
            </div>
            <label className="field">
              <span>Список прокси, по одному на строку</span>
              <textarea
                className="proxyTextarea"
                value={config.proxyList || ''}
                placeholder={'193.8.164.45:63142:LdlgSr3R4:ufKRLJ13y\nhttp://appuser:N7vL2xQp9sH3mK8t@121.127.37.208:3128'}
                onChange={(event) => updateConfig('proxyList', event.target.value)}
              />
            </label>
          </fieldset>
        </form>

        <aside className="side">
          <div className="panel compact">
            <h2>Поиск</h2>
            <div className="targetList">
              {targets.map((target) => (
                <a key={`${target.type}-${target.region || 'region'}-${target.propertyType}`} href={target.url} target="_blank" rel="noreferrer">
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
                  <span><LogText log={log} /></span>
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
