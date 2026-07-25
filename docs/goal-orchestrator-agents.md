# Goal Orchestrator Agents

Документ фиксирует, где находятся промпты и логика агентов `goal-orchestrator`, как устроена эскалация к smart-manager и какие настройки менять без привязки к конкретной предметной области.

## Сервер и сервисы

Рабочий сервер:

```bash
ssh suflo-se
cd /opt/goal-orchestrator
```

Контейнеры:

```bash
docker compose ps
docker compose logs -f app
```

Локальный туннель для Open WebUI:

```bash
ssh -N -L 8751:127.0.0.1:8751 -L 8750:127.0.0.1:8750 root@135.106.174.76
```

UI:

```text
http://127.0.0.1:8751
```

API:

```text
http://127.0.0.1:8750
```

## Промпты агентов

Промпты обычных агентов:

```text
/opt/goal-orchestrator/prompts/planner.md
/opt/goal-orchestrator/prompts/worker.md
/opt/goal-orchestrator/prompts/verifier.md
```

Текущий prompt-pack сделан универсальным. В базовых ролях не должно быть правил, привязанных к одной теме: VLESS, x-ui, React, SQL, SSH, маркетинг, парсинг и другие предметные сценарии не должны управлять всеми задачами. Такие правила можно держать только как отдельные навыки, RAG-документы, тестовые фикстуры или динамический контекст конкретной задачи.

Роли:

- `planner.md`: восстанавливает исходную цель, выбирает один следующий атомарный шаг, задает машинно-проверяемые критерии и read-only команды проверки.
- `worker.md`: превращает текущий шаг в минимальный набор неинтерактивных действий, печатает доказательства результата и не возвращает пустой actions-list при незавершенной цели.
- `verifier.md`: судит только по реальному stdout/stderr/файлам/status/test-output и не принимает setup, пустую директорию или exit code 0 как полноценный результат без доказательств.

Код, который собирает промпты:

```text
/opt/goal-orchestrator/app/agents/planner.py
/opt/goal-orchestrator/app/agents/worker.py
/opt/goal-orchestrator/app/agents/verifier.py
```

Smart-manager:

```text
/opt/goal-orchestrator/app/agents/smart_manager.py
```

Главная логика графа, recovery, маршрутов и условий эскалации:

```text
/opt/goal-orchestrator/app/graph.py
```

Настройки моделей, ключей, лимитов и Docker secrets:

```text
/opt/goal-orchestrator/app/config.py
/opt/goal-orchestrator/docker-compose.yml
/opt/goal-orchestrator/.env
```

## Smart-manager

Smart-manager использует отдельный ключ через Docker secret:

```text
/opt/goal-orchestrator/secrets/smart_manager_api_key
```

Ключ не должен попадать в markdown, git, stdout и логи.

Модель и endpoint настраиваются через env:

```text
SMART_MANAGER_BASE_URL
SMART_MANAGER_MODEL
SMART_MANAGER_FALLBACK_MODELS
SMART_MANAGER_ITERATION_BUDGET
SMART_MANAGER_MODEL_TIMEOUT
SMART_MANAGER_TRIGGER_FAILURES
```

Текущая идея: основной агент выполняет рутину, а smart-manager подключается только когда обычный контур перестал двигаться.

Smart-manager prompt находится в:

```text
/opt/goal-orchestrator/app/agents/smart_manager.py
```

Он должен работать как старший менеджер итераций: восстановить исходную цель, отделить факты от предположений, найти реальный блокер, предложить другой путь, выдать один следующий шаг, критерии приемки, read-only проверку и инструкции worker'у. Он не должен закрывать задачу словами вместо обычного агента.

## Универсальные триггеры

Триггеры должны быть поведенческими, а не тематическими. Нельзя завязывать систему на конкретные темы вроде React, SSH, SQL, маркетинга или парсинга.

Smart-manager вызывается, когда:

- достигнут лимит итераций;
- повторяется одна и та же ошибка;
- граф попал в `recovery`;
- несколько раз подряд `worker` вернул пустой список действий;
- policy получила `policy_no_actions`;
- накоплены подряд идущие failures без прогресса.

Текущий короткий триггер:

```text
SMART_MANAGER_TRIGGER_FAILURES=3
```

Это значит, что после нескольких пустых попыток агент должен уйти в `recovery` и запросить инструкцию smart-manager, даже если общий лимит итераций большой.

## Что smart-manager получает

Smart-manager получает доступный контекст задачи:

- исходную цель;
- контекст диалога;
- текущий шаг;
- критерии приемки;
- команды проверки;
- последние планы;
- последние действия;
- последние результаты выполнения;
- последние проверки;
- счетчики итераций, repeated errors и consecutive failures.

Ответ smart-manager должен быть не рассуждением для пользователя, а следующей порцией инструкций для обычного агента:

- один конкретный следующий шаг;
- критерии приемки;
- команды проверки;
- чем новый подход отличается от предыдущих;
- условия, когда действительно нужно остановиться.

## Поведение при сбое smart-manager

Если smart-manager временно недоступен, задача не должна сразу завершаться. Граф должен создать fallback recovery-шаг, продлить бюджет итераций и продолжить выполнение другим безопасным способом.

События:

```text
smart_manager_advice
smart_manager_unavailable_recovery
```

## Проверки после правок

Запуск тестов:

```bash
cd /opt/goal-orchestrator
docker run --rm -v /opt/goal-orchestrator:/src -w /src goal-orchestrator:1.0.0 sh -lc "pip install -q -e .[dev] && pytest -q"
```

Пересборка и перезапуск:

```bash
cd /opt/goal-orchestrator
docker compose build app
docker compose up -d --no-deps --force-recreate app
```

Health:

```bash
curl http://127.0.0.1:8750/health
```

Проверка, что ключ не утек в логи:

```bash
docker compose logs --no-color app | grep -E "sk-cxr|smart_manager_api_key"
```

Ожидаемо: пустой вывод.

## Важные правила

- Промпты должны быть универсальными.
- Тематические костыли допустимы только как тестовые примеры, не как рабочая логика.
- Основная логика должна смотреть на прогресс, ошибки, пустые действия, отсутствие доказательств и повторяемость.
- Нельзя пушить secrets.
- Нельзя логировать ключи.
- Нельзя считать задачу успешной без проверяемых доказательств.
- Нельзя бесконечно повторять пустой worker-output.

## Источники prompt-pack

Новый prompt-pack не является копией закрытых системных промптов. Он собран как универсальная рабочая схема из публичных паттернов coding-agent систем:

- Claude Code SDK: preset `claude_code`, project memory через `CLAUDE.md`, append/custom system prompt и output styles. Вывод: базовый агент должен иметь стабильную роль, а проектные правила нужно добавлять отдельным контекстом, не зашивая их в общий prompt.
- OpenCode agents: агенты разделяются по ролям, моделям и доступу к инструментам. Вывод: planner/worker/verifier/smart-manager должны иметь разные обязанности.
- OpenHands: open-source контрольный центр для разных coding agents. Вывод: система должна быть совместима с разными задачами и средами, а не с одной предметной областью.
- Aider: агент работает внутри существующего git-проекта и проверяет изменения через реальные файлы/git/test-output. Вывод: нельзя принимать успех без артефактов и проверяемого состояния.
- OpenCode GitHub: open-source terminal coding agent с провайдерами и моделями. Вывод: конфигурация моделей должна быть заменяемой, а prompts должны оставаться переносимыми.

Ссылки:

```text
https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts
https://opencode.ai/docs/agents/
https://github.com/OpenHands/openhands
https://aider.chat/
https://github.com/opencode-ai/opencode
```
