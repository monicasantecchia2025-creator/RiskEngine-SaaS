# Risk Engine SaaS Backend (Producción)

Backend productivo para un SaaS multi-tenant de gestión de riesgo para traders en MT4/MT5.

## Stack
- Node.js + TypeScript + Fastify
- PostgreSQL + Prisma
- Stripe (Checkout + Webhooks firmados + idempotencia)
- MetaApi (conexión real contra API)
- Workers de sincronización/riesgo/suscripciones
- Pausa/reanudación automática de cuenta en MetaApi según estado de suscripción

## Qué resuelve (listo para operar)
- Multi-tenant por usuario.
- Conexión de cuentas MetaTrader (MT4/MT5) usando credenciales de broker para provisionar en MetaApi.
- TradingPlan inmutable por cuenta (creación única).
- Motor de reglas extensible con acciones reales (pausa, close positions, notify vía outbox).
- Ciclo de vida de suscripciones Stripe con IDs externos persistidos.
- Webhooks Stripe con verificación de firma + idempotencia por `providerEventId`.
- Si no hay pago activo: cuenta pausada en DB + pausa operativa en MetaApi + stop del risk engine por estado.
- Workers con locking/retry/backoff.

---

## 1) Requisitos previos
- Node.js 20+
- PostgreSQL 14+
- Cuenta Stripe (modo test/live)
- Cuenta MetaApi con una cuenta MT4/MT5 ya provisionada
- Stripe CLI (para pruebas locales de webhook)

---

## 2) Variables de entorno

```bash
cp .env.example .env
```

Completa obligatoriamente:
- `DATABASE_URL`
- `JWT_SECRET`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_ID_MONTHLY`
- `STRIPE_PRICE_ID_ANNUAL`
- `METAAPI_TOKEN`
- `METAAPI_BASE_URL`

---

## 3) Levantar backend local

```bash
npm install
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
npm run dev
```

API:
- `http://localhost:3000/docs` (Swagger)
- `http://localhost:3000/health`
- `http://localhost:3000/metrics`

---

## 4) Levantar workers (en 3 terminales)

```bash
npm run worker:metaapi
npm run worker:risk
npm run worker:subscription
```

---

## 5) Configurar Stripe webhooks reales

### 5.1 En local
```bash
stripe listen --forward-to localhost:3000/webhooks/stripe
```
Copia el `whsec_...` entregado por Stripe CLI y actualízalo en `.env`.

### 5.2 En producción
- Configura endpoint HTTPS real.
- Usa secreto de webhook productivo.
- Habilita eventos recomendados:
  - `checkout.session.completed`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.paid`
  - `invoice.payment_failed`

---

## 6) Flujo real end-to-end (paso a paso)

## Paso A: Crear usuario
```bash
curl -X POST http://localhost:3000/auth/register \
  -H "content-type: application/json" \
  -d '{"email":"owner@tuempresa.com","password":"Password123!","name":"Owner"}'
```

## Paso B: Login
```bash
curl -X POST http://localhost:3000/auth/login \
  -H "content-type: application/json" \
  -d '{"email":"owner@tuempresa.com","password":"Password123!"}'
```
Guarda `accessToken`.

## Paso C: Crear checkout session Stripe
```bash
curl -X POST http://localhost:3000/billing/checkout-session \
  -H "authorization: Bearer <JWT>" \
  -H "content-type: application/json" \
  -d '{"successUrl":"http://localhost:5173/success","cancelUrl":"http://localhost:5173/cancel","plan":"monthly"}'
```
Abre `url` devuelto y completa pago.

## Paso D: Verificar llegada de webhook
- Revisa logs del API.
- Debe existir un registro en `WebhookEvent` con `processedAt` completo.
- Debe actualizarse `Subscription.status` y `stripeSubscriptionId`.

## Paso E: Conectar cuenta MetaTrader (solo con datos del broker)

```bash
curl -X POST http://localhost:3000/accounts \
  -H "authorization: Bearer <JWT>" \
  -H "content-type: application/json" \
  -d '{"name":"Cuenta Broker","platform":"mt5","brokerLogin":"123456","brokerPassword":"secret","brokerServer":"Broker-Server","brokerName":"MiBroker"}'
```

El backend crea la cuenta en MetaApi, hace deploy + connect, guarda el `metaapiAccountId` generado y deja la cuenta en `PENDING_PLAN`.

Regla comercial aplicada: por cada suscripción activa solo se permite 1 cuenta conectada.

## Paso F: Crear TradingPlan inmutable
```bash
curl -X POST http://localhost:3000/accounts/<accountId>/trading-plan \
  -H "authorization: Bearer <JWT>" \
  -H "content-type: application/json" \
  -d '{
    "planNarrative":"Hoy cumplo mi plan: opero solo setup A+, máximo 10 operaciones, paro al llegar a +500 o -300.",
    "timezone":"America/New_York",
    "riskProfile":"moderate",
    "resetPolicy":{"dailyReset":true,"lockTradingUntilNextDayOnBreach":true},
    "executionControls":{"enforceStopLoss":true,"enforceTakeProfit":true,"slTpUnit":"percent","stopLossValue":1,"takeProfitValue":2,"minRiskRewardRatio":1.5},
    "rules":[
      {"key":"max_daily_loss","enabled":true,"value":-300,"action":"pause_account"},
      {"key":"max_daily_profit_target","enabled":true,"value":500,"action":"pause_account"},
      {"key":"max_total_loss","enabled":true,"value":-1000,"action":"pause_account"},
      {"key":"max_drawdown","enabled":true,"value":8,"action":"notify"},
      {"key":"max_trades_per_day","enabled":true,"value":10,"action":"pause_account"},
      {"key":"allowed_hours","enabled":true,"value":{"start":7,"end":20},"action":"notify"},
      {"key":"require_stop_loss_take_profit","enabled":true,"value":true,"action":"notify"},
      {"key":"close_all_at_midnight","enabled":true,"value":true,"action":"request_close_positions"}
    ]
  }'
```
Si la suscripción está activa, la cuenta pasa a `ACTIVE`.

Notas del plan profesional:
- `max_trades_per_day` y `max_daily_profit_target` bloquean hasta el siguiente día UTC.
- `require_stop_loss_take_profit` si falta SL/TP o no coincide con el plan, el sistema auto-coloca SL/TP según el plan (no cierra esa operación por este motivo).
- `executionControls.slTpUnit` permite fijar SL/TP por porcentaje (`percent`) o dinero por operación (`money`).
- El campo `planNarrative` guarda el compromiso escrito por el trader y queda inmutable junto al plan.
- `timezone` debe ser la zona horaria del broker (IANA), por ejemplo `America/New_York` (no UTC).

## Paso G: Verificar sincronización MetaApi
- Worker `metaapi-sync` debe crear/actualizar `DailyMetrics`.
- Debe insertar/actualizar `Deal` desde MetaApi.

## Paso H: Verificar motor de riesgo
- Con datos de métricas/deals que violen reglas, worker `risk-engine` creará `RiskEvent`.
- Si se alcanza límite diario/target diario o se viola una regla diaria, la cuenta queda bloqueada hasta el próximo día UTC y se cierran posiciones automáticamente.
- **Importante**: la cuenta de MetaApi no se pausa; el enforcement es 24/7 cerrando posiciones para impedir romper el plan.
- Si regla exige cierre, se invoca `requestClosePositions` en MetaApi.
- Cada incidente genera evento `notifications.multichannel` (in_app/email/telegram) para notificación inmediata.
- Frecuencia del motor: `RISK_ENGINE_POLL_MS` (default 500ms).

## Paso I: Validar dashboard
```bash
curl -X GET http://localhost:3000/dashboard/accounts/<accountId>/summary \
  -H "authorization: Bearer <JWT>"
```

## Paso J: Alertas preventivas + countdown de bloqueo
```bash
curl -X GET http://localhost:3000/dashboard/accounts/<accountId>/compliance-alerts \
  -H "authorization: Bearer <JWT>"
```
Devuelve alertas preventivas (por ejemplo: te quedan pocas operaciones o estás cerca del límite de pérdida) y `lock.secondsRemaining` cuando hay bloqueo diario activo.

## Paso K: Panel de soporte (causa-evidencia-acción)
```bash
curl -X GET http://localhost:3000/support/accounts/<accountId>/incidents \
  -H "authorization: Bearer <JWT>"
```
Devuelve incidentes con:
- causa (`ruleKey`, `severity`, `message`)
- evidencia (`actionPayload`)
- acción tomada (bloqueo/cierre)
- auditoría asociada.

## Paso L: Onboarding guiado de disciplina diaria
```bash
curl -X GET http://localhost:3000/onboarding/daily-discipline \
  -H "authorization: Bearer <JWT>"
```
Devuelve checklist guiado para que el trader confirme que está listo para operar bajo disciplina diaria.

---

## 7) Endpoints disponibles
- `POST /auth/register`
- `POST /auth/login`
- `GET /auth/me`
- `POST /billing/checkout-session`
- `POST /webhooks/stripe`
- `POST /accounts`
- `GET /accounts`
- `GET /accounts/:id`
- `POST /accounts/:id/trading-plan`
- `GET /dashboard/overview`
- `GET /dashboard/accounts/:id/summary`
- `GET /dashboard/accounts/:id/compliance-alerts`
- `GET /support/accounts/:id/incidents`
- `GET /onboarding/daily-discipline`

---

## 8) Guía Thunder Client (paso a paso, súper simple)

1. Instala la extensión **Thunder Client** en VSCode.
2. Crea una Collection llamada `Risk Engine E2E`.
3. Crea entorno con variables:
   - `baseUrl=http://localhost:3000`
   - `token=` (vacío al inicio)
   - `accountId=` (vacío al inicio)

Flujo recomendado:

1) `POST {{baseUrl}}/auth/register`
```json
{"email":"owner@demo.com","password":"Password123!","name":"Owner"}
```

2) `POST {{baseUrl}}/auth/login`
```json
{"email":"owner@demo.com","password":"Password123!"}
```
Guarda `accessToken` en la variable `token`.

3) `POST {{baseUrl}}/billing/checkout-session` con header `Authorization: Bearer {{token}}`.
```json
{"successUrl":"http://localhost:5173/success","cancelUrl":"http://localhost:5173/cancel","plan":"monthly"}
```
Abre la URL devuelta y termina el pago.

4) `POST {{baseUrl}}/accounts` con `Authorization: Bearer {{token}}`.
```json
{"name":"Cuenta Real","platform":"mt5","brokerLogin":"123456","brokerPassword":"secret","brokerServer":"Broker-Server","brokerName":"MiBroker"}
```
Guarda `id` en variable `accountId`.

5) `POST {{baseUrl}}/accounts/{{accountId}}/trading-plan` con `Authorization: Bearer {{token}}`.
Usa el JSON del **Paso F**.

6) `GET {{baseUrl}}/dashboard/accounts/{{accountId}}/summary`.

Cómo validar rápido:
- Si paga + conecta + crea plan => cuenta `ACTIVE`.
- Si rompe reglas o cumple target diario => `riskPausedUntil` con fecha del próximo día y evento en `risk.latest`.
- Si no paga => `PAUSED_SUBSCRIPTION`.
- Si llegó el nuevo día UTC, se limpia el lock diario y vuelve a poder operar según su mismo plan.

---

## 9) Checklist antes de comercializar
1. **Entorno productivo** con HTTPS y secretos en vault.
2. **Base de datos** con backups automáticos + PITR.
3. **Monitoreo**: alertas sobre `processingError` en `WebhookEvent`, jobs `FAILED`, y cuentas `DISCONNECTED`.
4. **Trazabilidad**: enviar logs estructurados a ELK/Datadog.
5. **Cierres de riesgo**: validar permisos reales de broker para `close positions`.
6. **Pruebas de carga** de workers en paralelo.
7. **Política de seguridad**: rotación de JWT secret, rate limits por IP + user, WAF.
8. **Facturación**: reconciliación diaria Stripe vs DB.
9. **Soporte**: panel interno para reprocesar webhooks y reintentar jobs.

---

## 10) Tests incluidos
```bash
npm test
```
- reglas del motor
- idempotencia de webhook



## 11) Dashboard profesional (datos para panel Base44)

El endpoint `GET /dashboard/overview` devuelve visión ejecutiva:
- cantidad de cuentas por estado
- estado de suscripción
- KPIs agregados
- últimos eventos de riesgo

El endpoint `GET /dashboard/accounts/:id/summary` devuelve panel completo por cuenta:
- datos de cuenta + suscripción + plan
- KPIs de trading (equity, balance, daily pnl, total pnl, win rate, avg win/loss, profit factor, best/worst day)
- series para gráficos (`pnlSeries`)
- riesgo (total, por severidad, últimos eventos)
- últimos trades
- auditoría de acciones

Con esto Base44 puede construir un dashboard profesional tipo prop firm/trading analytics sin lógica adicional en frontend.


### Nota sobre MetaApi único
Este backend usa un único token de MetaApi (`METAAPI_TOKEN`) a nivel plataforma.
Todas las cuentas de usuarios se provisionan dentro de ese mismo tenant de MetaApi y se segregan por `userId` en tu base de datos.
