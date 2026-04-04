# The JuicySpot — Documentación técnica completa

Sitio web + panel de administración para hamburguesería artesanal en Buenos Aires, Argentina.
Pedidos vía WhatsApp con integración de Mercado Pago y administración en tiempo real.

---

## Arquitectura general

```
┌─────────────────────────────────────────────────────┐
│  Cloudflare (CDN + proxy + caché)                   │
│  Dominio: juicy-spot.com                            │
└────────────────┬────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────┐
│  Railway (hosting backend + frontend estático)      │
│  Node.js 18+ · Express                              │
│                                                     │
│  /              → index.html  (sitio cliente)       │
│  /admin         → admin/index.html (panel admin)    │
│  /api/*         → backend/server.js (REST API)      │
└─────────────────────────────────────────────────────┘
```

**No hay build step.** Todo el frontend es HTML/CSS/JS vanilla servido como estático por Express.

---

## Estructura de archivos

```
The JuicySpot/
├── index.html              # Sitio cliente (página pública)
├── logo*.png               # Assets del logo (variantes)
├── admin/
│   └── index.html          # Panel de administración
├── backend/
│   ├── server.js           # Servidor Express principal
│   ├── db.js               # Capa de datos (JSON file)
│   ├── orders.json         # Base de datos (generado automáticamente)
│   ├── firebase-service-account.json  # Credenciales Firebase (no commitear)
│   └── .env                # Variables de entorno (no commitear)
├── tests/
│   ├── site.spec.js        # Tests E2E del sitio cliente
│   ├── admin.spec.js       # Tests E2E del panel admin
│   └── api.spec.js         # Tests de API REST
├── playwright.config.js    # Configuración de Playwright
└── package.json
```

---

## Frontend: Sitio cliente (`index.html`)

**Tecnología:** HTML5 + CSS3 + JavaScript vanilla (sin frameworks, sin build)

### Funcionalidades
- Catálogo de productos cargado desde la API (`GET /api/catalog`)
- Carrito lateral (drawer) con tabs: "Agregar" y "Pedido"
- Formulario de pedido: nombre, teléfono, dirección con Google Maps Autocomplete
- Pago con Mercado Pago (botón que genera preferencia) o Transferencia bancaria
- Envío del pedido por WhatsApp como mensaje preformateado
- Banner de tienda cerrada cuando el local no opera
- Estado de la tienda en tiempo real (`GET /api/store/status`)

### Variables/IDs clave del DOM
| ID | Descripción |
|----|-------------|
| `#cartFloat` | Botón flotante del carrito |
| `#cartDrawer` | Panel lateral del carrito |
| `#cartOverlay` | Overlay oscuro que cierra el carrito |
| `#cartCount` | Badge con cantidad de ítems |
| `#cartTotal` | Total del carrito en pesos |
| `#tabAgregar` | Tab para agregar productos |
| `#tabPedido` | Tab para ver/confirmar pedido |
| `#quickBurgers` | Grid de botones para agregar rápido |
| `#clientName` | Input nombre del cliente |
| `#clientPhone` | Input teléfono del cliente |
| `#clientAddress` | Input dirección (con Google Maps Autocomplete) |
| `#payOptMP` | Botón de pago Mercado Pago |
| `#payOptTransfer` | Botón de pago Transferencia |
| `#sendOrderBtn` | Botón enviar pedido (abre WhatsApp) |
| `#closedBanner` | Banner visible cuando la tienda está cerrada |
| `[data-price-key]` | Elementos donde se inyectan precios desde la API |

### Funciones JS principales
| Función | Descripción |
|---------|-------------|
| `loadPricesFromAPI()` | Carga catálogo desde `/api/catalog`, inyecta precios en el DOM y actualiza `PRODUCTS` |
| `sendOrder()` | Valida el formulario y genera el mensaje de WhatsApp. Usa feedback visual (borde rojo) para errores de validación. Solo usa `alert()` para carrito vacío |
| `selectPayment(method)` | Selecciona método de pago ('mp' o 'transfer') |
| `openCart()` / `closeCart()` | Control del drawer del carrito |
| `addToCart(product)` | Agrega producto al carrito |

### Validaciones del formulario
- **Nombre vacío:** `#clientName` recibe `style.borderColor = 'var(--red)'` y `placeholder = '⚠ Ingresá tu nombre'`
- **Sin forma de pago:** `#payOptMP` padre recibe `style.outline = '1px solid var(--red)'`
- **Carrito vacío:** `alert()` nativo del browser

---

## Frontend: Panel admin (`admin/index.html`)

**Tecnología:** HTML5 + CSS3 + JavaScript vanilla + Firebase JS SDK (CDN)

### Autenticación
- Firebase Authentication (email/password + Google popup)
- Al hacer login se llama `POST /api/firebase-login` con el ID token
- El backend valida el token y devuelve `{ ok, isSuperAdmin, displayName, email }`
- El token se guarda en `sessionStorage` con clave `js_fb_token`
- Se refresca automáticamente cada 55 minutos

### Roles
| Rol | Condición | Acceso |
|-----|-----------|--------|
| **Super Admin** | `email === SUPER_ADMIN` (env var) | Todo el panel, incluyendo Usuarios |
| **Admin** | Aprobado por Super Admin | Pedidos, Métricas, Precios (sin gestión de usuarios) |
| **Pendiente** | Registrado pero no aprobado | Pantalla de espera, sin acceso |

El chip de usuario (nombre + rol) se muestra en el header superior derecho al iniciar sesión.

### Tabs del panel
| Tab | ID botón | ID contenido | Descripción |
|-----|----------|--------------|-------------|
| Pedidos | `#btnPedidos` | `#tabPedidos` | Kanban de órdenes en tiempo real |
| Métricas | `#btnMetricas` | `#tabMetricas` | KPIs y gráficos por rango de fechas |
| Precios | `#btnPrecios` | `#tabPrecios` | Gestión dinámica del catálogo |
| Usuarios | `#btnUsuarios` | `#tabUsuarios` | Solo visible para Super Admin |

### Kanban de pedidos
Estados del flujo (en orden):
1. `recibido` — gris
2. `pago_confirmado` — azul
3. `en_preparacion` — naranja
4. `en_camino` — verde
5. `entregado` — gris oscuro (terminal)
6. `cancelado` — rojo (terminal, requiere motivo)

Cada tarjeta muestra: número de orden, nombre, teléfono, dirección, ítems, total, método de pago, timer desde pago confirmado.

**Cancelación de pedido:** abre un modal (`#cancelModal`) que requiere seleccionar un motivo obligatorio antes de confirmar. Los motivos son:
- `cliente_no_atendio`, `pedido_duplicado`, `pedido_erroneo`, `fuera_de_zona`, `sin_stock`, `otro`

El motivo y las notas opcionales se guardan en el pedido y se muestran en la tarjeta.

### Catálogo dinámico
- Lista de productos en `#catalogList` con filas `id="crow_{id}"`
- Cada fila permite: editar precio (guarda al cambiar), toggle activo/inactivo, editar nombre/sub/precio, eliminar
- Formulario `#newProductForm` para agregar productos nuevos
- Los cambios se persisten en la API y se reflejan en el sitio cliente sin reiniciar

### Variables globales JS
| Variable | Tipo | Descripción |
|----------|------|-------------|
| `TOKEN` | string | Firebase ID token activo |
| `IS_SUPER` | boolean | Si el usuario es Super Admin |
| `CURRENT_USER` | object | `{ displayName, email, role }` |
| `orders` | array | Lista de pedidos en memoria |
| `_catalog` | array | Catálogo de productos en memoria |
| `_storeConfig` | object | Configuración de tienda en memoria |

### Tiempo real (SSE)
El kanban se actualiza por Server-Sent Events conectados a `GET /api/orders/stream`.
- Punto verde (`#sseDot`) en el header indica conexión activa
- Eventos: `new_order`, `status_update`, `catalog_update`

---

## Backend (`backend/server.js`)

**Runtime:** Node.js 18+  
**Framework:** Express 4  
**Puerto:** `process.env.PORT` (Railway asigna automáticamente, default 3000)

### Dependencias
| Paquete | Versión | Uso |
|---------|---------|-----|
| `express` | ^4.18 | Servidor HTTP |
| `helmet` | ^8.1 | Headers de seguridad |
| `cors` | ^2.8 | CORS para el frontend |
| `dotenv` | ^16.4 | Variables de entorno |
| `express-rate-limit` | ^8.3 | Rate limiting por IP |
| `firebase-admin` | ^13.7 | Verificación de tokens Firebase |
| `mercadopago` | ^2.12 | SDK de pagos |

### Configuración Helmet importante
```js
helmet({
  contentSecurityPolicy: false,           // admin usa CDN inline
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }  // requerido para Firebase signInWithPopup
})
```
> **Crítico:** NO usar la política COOP por defecto (`same-origin`) ya que rompe `signInWithPopup` de Firebase silenciosamente.

### Middlewares de rate limiting
| Limiter | Ruta | Límite |
|---------|------|--------|
| `apiLimiter` | `/api/*` | General |
| `orderLimiter` | `/api/orders` | Más restrictivo |
| `authLimiter` | `/api/firebase-login` | Anti-brute force |

### Orden de rutas (importante)
Las rutas `GET /` y `GET /admin` con `Cache-Control: no-store` van **ANTES** de `express.static()`. Si `express.static()` va primero, intercepta los HTML y no agrega los headers de caché.

---

## API REST

Base URL: `https://juicy-spot.com`

### Públicas (sin autenticación)

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/catalog` | Lista de productos activos con precios |
| `GET` | `/api/prices` | Mapa `{ id: precio }` (compat. legacy) |
| `GET` | `/api/store/status` | Estado `{ open: bool, config: {...} }` |
| `POST` | `/api/orders` | Crear pedido nuevo |
| `POST` | `/api/mercadopago/create-preference` | Crear preferencia de pago MP |
| `POST` | `/api/mercadopago/webhook` | Webhook de notificaciones MP |

### Protegidas (requieren `Authorization: Bearer {token}`)

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/api/firebase-login` | Validar token y obtener sesión |
| `GET` | `/api/orders` | Lista todos los pedidos |
| `PATCH` | `/api/orders/:id/status` | Cambiar estado del pedido |
| `DELETE` | `/api/orders/all` | Borrar todos los pedidos y reiniciar contador |
| `GET` | `/api/orders/stream` | SSE stream de eventos en tiempo real |
| `GET` | `/api/metrics` | KPIs con parámetros `?from=YYYY-MM-DD&to=YYYY-MM-DD` |
| `GET` | `/api/catalog/all` | Catálogo completo incluyendo inactivos |
| `POST` | `/api/catalog` | Agregar producto |
| `PUT` | `/api/catalog/:id` | Editar producto |
| `DELETE` | `/api/catalog/:id` | Eliminar producto |
| `GET` | `/api/store/config` | Obtener config de tienda |
| `PATCH` | `/api/store/config` | Actualizar config de tienda |

### Solo Super Admin

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/users` | Lista todos los usuarios |
| `POST` | `/api/users/:uid/approve` | Aprobar acceso al admin |
| `POST` | `/api/users/:uid/reject` | Revocar acceso |

### Schema de pedido

```json
{
  "id": 42,
  "order_num": "#0042",
  "status": "recibido",
  "client_name": "Juan García",
  "client_phone": "1134567890",
  "client_address": "Av. Corrientes 1234, CABA",
  "items": [
    { "id": "lucy_solo", "name": "Juicy Lucy", "sub": "Solo la burger", "emoji": "🧀", "qty": 2, "unitPrice": 7999, "key": "lucy_solo", "group": "burger" }
  ],
  "items_json": "[...]",
  "total": 15998,
  "payment_method": "transfer",
  "whatsapp_msg": "...",
  "created_at": "15/03/2025, 20:30",
  "updated_at": "15/03/2025, 20:35",
  "paid_at": null,
  "mp_payment_id": null,
  "cancel_reason": null,
  "cancel_notes": null,
  "cancelled_at": null
}
```

### PATCH /api/orders/:id/status — body

```json
{
  "status": "cancelado",
  "cancel_reason": "cliente_no_atendio",
  "cancel_notes": "Llamamos 3 veces sin respuesta"
}
```
`cancel_reason` es **obligatorio** cuando `status === "cancelado"`.

---

## Base de datos (`backend/db.js`)

**Tipo:** JSON file (`backend/orders.json`)  
**Persistencia:** Sistema de archivos de Railway (efímero entre deploys — los datos se pierden si el contenedor se reinicia sin volumen montado)

### Estructura del archivo JSON
```json
{
  "orders": [...],
  "nextId": 43,
  "users": [...],
  "store": {
    "manualOverride": "auto",
    "schedule": [...],
    "deliveryZone": "CABA"
  },
  "catalog": [...],
  "prices": {}
}
```

### Catálogo
Cada producto:
```json
{
  "id": "lucy_solo",
  "name": "Juicy Lucy",
  "sub": "Solo la burger",
  "emoji": "🧀",
  "group": "burger",
  "price": 7999,
  "active": true
}
```
Grupos válidos: `burger`, `promo`, `extra`.

### Horarios de la tienda
```json
{ "day": 5, "from": "18:00", "to": "23:00" }
```
`day` usa la convención de `Date.getDay()`: 0=Domingo, 1=Lunes, ..., 6=Sábado.  
Horario por defecto: Jueves a Domingo 18:00–23:00.

### Usuarios
```json
{
  "uid": "firebase-uid",
  "email": "usuario@ejemplo.com",
  "displayName": "Juan",
  "approved": true,
  "createdAt": "2025-03-15T..."
}
```

---

## Variables de entorno (Railway)

| Variable | Requerida | Descripción |
|----------|-----------|-------------|
| `PORT` | Auto | Asignado por Railway |
| `SUPER_ADMIN` | Sí | Email del administrador principal |
| `FRONTEND_ORIGIN` | Sí | Origen CORS permitido (`https://juicy-spot.com`) |
| `FIREBASE_PROJECT_ID` | Sí | ID del proyecto Firebase |
| `FIREBASE_CLIENT_EMAIL` | Sí | Email de la service account |
| `FIREBASE_PRIVATE_KEY` | Sí | Clave privada (con `\n` escapados como `\\n`) |
| `MP_ACCESS_TOKEN` | Sí | Token de producción de Mercado Pago |
| `MP_WEBHOOK_SECRET` | Sí | Clave para validar webhooks de MP |
| `DB_PATH` | No | Ruta del archivo JSON (default: `./orders.json`) |

---

## Servicios externos

| Servicio | Plan | Uso |
|----------|------|-----|
| **Railway** | Hobby | Hosting del backend + archivos estáticos |
| **Cloudflare** | Free | CDN, proxy, caché, DNS |
| **Firebase** (Google) | Spark (free) | Autenticación del panel admin |
| **Mercado Pago** | Producción | Pagos online (Argentina) |
| **Google Maps** | Pay-as-you-go | Autocomplete de dirección en el formulario |
| **WhatsApp Business** | — | Canal de entrega de pedidos |

### Cloudflare Cache Rules
Configuradas para **bypass** (no cachear) en:
- `juicy-spot.com/` (raíz exacta)
- `juicy-spot.com/admin` (panel admin)

El resto (assets estáticos) se puede cachear normalmente.

---

## Tests E2E (`tests/`)

**Framework:** Playwright 1.59+  
**Config:** `playwright.config.js`  
**Base URL:** `https://juicy-spot.com` (o `BASE_URL` env var)  
**Browser:** Chromium Desktop

### Suites

#### `tests/api.spec.js` — 7 tests
Prueba directamente los endpoints REST sin browser:
- `GET /api/catalog` devuelve lista con `id`, `name`, `price`, `group`
- `GET /api/catalog` solo devuelve productos con `active !== false`
- `GET /api/prices` devuelve mapa con `lucy_solo`
- `GET /api/store/status` devuelve `{ open: bool, config: {...} }`
- `GET /api/orders` requiere auth (401/403)
- `POST /api/orders` sin datos → 400
- `POST /api/orders` con datos válidos → 200 con `{ ok: true, id }`

#### `tests/site.spec.js` — 12 tests
Prueba el sitio cliente como usuario:
- Página carga y muestra título
- Estado de tienda visible (banner cerrado o botón activo)
- Catálogo de burgers visible
- Carrito abre y cierra
- Agregar producto actualiza el contador (`#cartCount`)
- Total del carrito se calcula (`#cartTotal`)
- Validación: nombre vacío → placeholder cambia a `⚠ Ingresá tu nombre`
- Validación: sin forma de pago → outline rojo en el selector
- Validación: carrito vacío → `alert()` con mensaje
- Botones MP y Transferencia son seleccionables
- Precios cargados desde API aparecen en DOM
- Botón WhatsApp del footer abre el carrito

#### `tests/admin.spec.js` — 12 tests
Prueba el panel admin (los tests autenticados requieren `ADMIN_EMAIL` y `ADMIN_PASSWORD` en env):
- Muestra pantalla de login
- Credenciales incorrectas muestran `#loginErr`
- Con sesión: tabs principales visibles
- Kanban carga y tiene columnas
- Catálogo carga y muestra productos (`#catalogList`)
- Puede agregar producto nuevo
- Puede cambiar precio (muestra toast)
- Puede toggle activo/inactivo
- Puede eliminar producto de prueba
- Métricas muestran KPIs
- Badge de estado de tienda visible
- Botón "Borrar todos los pedidos" existe

### Comandos
```bash
npm test                    # Todos los tests
npm run test:api            # Solo API
npm run test:site           # Solo sitio cliente
npm run test:admin          # Solo panel admin
npm run test:report         # Abrir reporte HTML

# Con credenciales admin:
ADMIN_EMAIL=x@x.com ADMIN_PASSWORD=xxx npm run test:admin

# Contra entorno local:
BASE_URL=http://localhost:8080 npm test
```

---

## Desarrollo local

```bash
# 1. Instalar dependencias
cd backend && npm install
cd .. && npm install

# 2. Configurar variables de entorno
cp backend/.env.example backend/.env
# Editar backend/.env con las credenciales reales

# 3. Iniciar servidor
npm run dev     # Con watch (reinicia al guardar)
# o
npm start       # Sin watch

# 4. Acceder
# Sitio:  http://localhost:8080
# Admin:  http://localhost:8080/admin
```

---

## Deploy

```bash
# Desde PowerShell (no WSL)
railway up
```

> `railway run bash` corre localmente en WSL, no en el servidor Railway. Para ejecutar comandos en el servidor usar la consola de Railway o el CLI con un servicio conectado.

---

## Notas de arquitectura para IAs

- **No hay base de datos relacional.** Todo es un único archivo JSON. Las queries son `Array.find()` y `Array.filter()` en memoria.
- **No hay separación frontend/backend en repos distintos.** Todo vive en el mismo repositorio y se sirve desde el mismo proceso Express.
- **Los precios viven en el catálogo**, no en un sistema separado. `GET /api/prices` es un endpoint de compatibilidad que deriva del catálogo.
- **`items_json`** es un string JSON serializado del array de ítems (legacy). El campo `items` en la API de creación es un array de objetos.
- **El contador de pedidos** (`nextId`) es incremental y persiste en `orders.json`. `resetAllOrders()` lo reinicia a 1.
- **Los SSE** no tienen reconexión automática en el cliente — si la conexión cae, el punto SSE pasa a gris y hay que recargar la página.
- **`manualOverride`** puede ser `'auto'` (respeta el horario), `'open'` (fuerza abierto) o `'closed'` (fuerza cerrado).
