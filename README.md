# CardioSense — Backend API

REST API + WebSocket server para el sistema de predicción cardiovascular.

## Stack

| Capa          | Tecnología                 |
| ------------- | --------------------------- |
| Runtime       | Node.js 20                  |
| Framework     | Express 4                   |
| Lenguaje      | TypeScript 5                |
| ORM           | Prisma 5                    |
| Base de datos | PostgreSQL                  |
| Auth          | JWT (HS256) + bcrypt        |
| Tiempo real   | Socket.IO 4                 |
| Validación   | Zod                         |
| Logging       | Winston                     |
| Seguridad     | Helmet, CORS, Rate Limiting |

## Estructura

```
src/
├── config/
│   ├── env.ts          # Variables de entorno validadas con Zod
│   └── prisma.ts       # Singleton del cliente Prisma
├── lib/
│   ├── aiClient.ts     # HTTP client para FastAPI (con fallback mock)
│   ├── errors.ts       # Clases de error personalizadas
│   ├── jwt.ts          # sign/verify access y refresh tokens
│   ├── logger.ts       # Winston logger
│   └── timezone.ts     # Zona horaria UTC-6
├── middlewares/
│   ├── authenticate.ts # JWT verify → req.user
│   ├── authorize.ts    # RBAC por roles
│   ├── errorHandler.ts # Global error handler
│   ├── rateLimiter.ts  # express-rate-limit
│   └── validate.ts     # Zod schema validation
├── modules/
│   ├── auth/           # register, login, refresh, logout, me
│   ├── users/          # CRUD usuarios (admin)
│   ├── patients/       # CRUD pacientes + historial
│   ├── health-records/ # Registros clínicos
│   ├── predictions/    # Predicción IA + historial
│   ├── dashboard/      # Historial métrico general
│   └── alerts/         # Alertas + marcar leídas
├── socket/
│   └── socketServer.ts # Socket.IO con autenticación JWT
├── types/
│   └── index.ts        # AuthRequest, AIPredictionResponse, paginate()
├── app.ts              # Express factory
└── index.ts            # Entry point + graceful shutdown
```

## Instalación

```bash
# Instalar dependencias
npm install

# Copiar y configurar variables
cp .env.example .env

# Generar cliente Prisma
npm run prisma:generate

# Crear tablas en la base de datos
npm run prisma:migrate

# Poblar datos de prueba
npm run prisma:seed

# Iniciar en desarrollo
npm run dev
```

## API Endpoints

### Auth

| Método | Ruta                   | Descripción         |
| ------- | ---------------------- | -------------------- |
| POST    | `/api/auth/register` | Registrar médico    |
| POST    | `/api/auth/login`    | Iniciar sesión      |
| POST    | `/api/auth/refresh`  | Renovar access token |
| POST    | `/api/auth/logout`   | Cerrar sesión       |
| GET     | `/api/auth/me`       | Perfil propio        |

### Pacientes

| Método | Ruta                          | Descripción                  |
| ------- | ----------------------------- | ----------------------------- |
| GET     | `/api/patients`             | Listar (paginado + búsqueda) |
| POST    | `/api/patients`             | Crear paciente                |
| GET     | `/api/patients/:id`         | Detalle                       |
| PUT     | `/api/patients/:id`         | Actualizar                    |
| DELETE  | `/api/patients/:id`         | Desactivar                    |
| GET     | `/api/patients/:id/history` | Historial clínico            |

### Registros de Salud

| Método | Ruta                                       | Descripción   |
| ------- | ------------------------------------------ | -------------- |
| POST    | `/api/health-records`                    | Crear registro |
| GET     | `/api/health-records/:id`                | Detalle        |
| GET     | `/api/health-records/patient/:patientId` | Por paciente   |

### Predicciones

| Método | Ruta                                    | Descripción         |
| ------- | --------------------------------------- | -------------------- |
| POST    | `/api/predictions`                    | Ejecutar predicción |
| GET     | `/api/predictions`                    | Historial completo   |
| GET     | `/api/predictions/:id`                | Detalle              |
| GET     | `/api/predictions/patient/:patientId` | Por paciente         |

#### Contrato de respuesta de Prediction (NEW R — R4F)

Serialización central: `src/modules/predictions/prediction.serializer.ts` (allowlist).

| Campo                       | Significado                                                                 | Lista / historial | Detalle (POST, GET `/:id`) |
| --------------------------- | --------------------------------------------------------------------------- | ----------------- | -------------------------- |
| `riskScore`, `riskLevel`    | Riesgo FINAL (personalizado, o exactamente el global en cualquier `GLOBAL_*`) | sí                | sí                         |
| `globalRiskScore`           | Riesgo GLOBAL de Skorp antes de la personalización                          | sí                | sí                         |
| `modelVersion`              | Versión del modelo GLOBAL                                                   | sí                | sí                         |
| `anomalyScore`, `isAnomaly` | Anomalía GLOBAL (no existe anomalía personalizada)                          | sí                | sí                         |
| `personalizationStatus`     | `INDIVIDUALIZED` / `GLOBAL_INSUFFICIENT_HISTORY` / `GLOBAL_INCOMPATIBLE_HISTORY` / `GLOBAL_ERROR_FALLBACK`; `null` = predicción legacy | sí | sí |
| `personalizationVersion`    | p. ej. `R-BPBC-1`; `null` = legacy                                          | sí                | sí                         |
| `personalizationProvenance` | Metadatos de auditoría (conteos, corte causal, huella, γ, ganancias, razón de fallback). No es una medida de exactitud ni de confianza clínica. | NO | sí |
| `featureImportance`         | Importancia del modelo GLOBAL (solo en la respuesta de POST, no persistida) | —                 | solo POST                  |
| `sexUsed`                   | Interno (comparabilidad de π). Nunca se expone.                             | NO                | NO                         |

- `INDIVIDUALIZED` significa que el mecanismo congelado condicionado por la historia se aplicó; no implica mayor exactitud, validación clínica ni entrenamiento con el paciente. Con γ = 0 puede ser `INDIVIDUALIZED` con `riskScore == globalRiskScore`; el estado nunca se infiere de la diferencia de scores.
- Predicciones legacy: `globalRiskScore = riskScore`, `personalizationStatus/Version/Provenance = null` (solo serialización; la fila no se modifica).
- Las predicciones embebidas en `GET /api/patients/:id/history` usan el contrato de lista.
- Alertas de riesgo: usan el riesgo FINAL (HIGH → CRITICAL; si no, anomalía GLOBAL → WARNING; si no, MODERATE → WARNING; máximo una por predicción). Los eventos Socket.IO se emiten solo después del commit; `prediction_completed` lleva `riskScore`/`riskLevel` FINALES y no incluye `sexUsed` ni la provenance.

### Alertas

| Método | Ruta                     | Descripción                       |
| ------- | ------------------------ | ---------------------------------- |
| GET     | `/api/alerts`          | Listar (filtros: unread, severity) |
| PATCH   | `/api/alerts/:id/read` | Marcar como leída                 |
| PATCH   | `/api/alerts/read-all` | Marcar todas como leídas          |

### Usuarios (Admin)

| Método | Ruta               | Descripción      |
| ------- | ------------------ | ----------------- |
| GET     | `/api/users`     | Listar todos      |
| GET     | `/api/users/:id` | Detalle           |
| PATCH   | `/api/users/:id` | Actualizar perfil |
| DELETE  | `/api/users/:id` | Desactivar        |

## Socket.IO Events

### Servidor → Cliente

| Evento                   | Room                | Payload                                                                     |
| ------------------------ | ------------------- | --------------------------------------------------------------------------- |
| `new_alert`            | `user:{medicoId}` | `{ id, patientId, patientName, severity, message, riskScore, createdAt }` |
| `prediction_completed` | `patient:{id}`    | `{ predictionId, patientId, healthRecordId, riskScore, riskLevel, isAnomaly }` (riesgo FINAL) |

### Cliente → Servidor

| Evento                  | Payload               | Acción                  |
| ----------------------- | --------------------- | ------------------------ |
| `subscribe_patient`   | `patientId: string` | Unirse a`patient:{id}` |
| `unsubscribe_patient` | `patientId: string` | Salir de`patient:{id}` |
| `ping`                | —                    | Keepalive                |

## Credenciales de demo (seed)

| Rol     | Email                        | Contraseña    |
| ------- | ---------------------------- | -------------- |
| Admin   | `admin@cardiosense.mx`     | `Admin1234!` |
| Médico | `dr.garcia@cardiosense.mx` | `Demo1234!`  |

## Deploy (Railway)

1. Conectar repo en Railway
2. Agregar variables de entorno del `.env.example`
3. Build command: `npm run build`
4. Start command: `npm start`
5. Post-deploy: `npm run prisma:migrate && npm run prisma:seed`
