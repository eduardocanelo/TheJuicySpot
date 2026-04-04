const fs = require('fs');
let html = fs.readFileSync('admin/index.html', 'utf8');

// 1. Inject responsive CSS before </style>
const mobileCss = `
/* ═══════════════════════════════════════════════════
   MOBILE RESPONSIVE
═══════════════════════════════════════════════════ */
.mob-nav {
  display: none;
  position: fixed; bottom: 0; left: 0; right: 0; height: 58px;
  background: rgba(14,10,4,.97); border-top: 1px solid rgba(212,146,10,.2);
  z-index: 300; align-items: stretch;
}
.mob-nav-btn {
  flex: 1; background: transparent; border: none;
  color: rgba(245,240,230,.3); display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 3px; cursor: pointer;
  font-size: 9px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase;
  transition: color .2s; -webkit-tap-highlight-color: transparent;
}
.mob-nav-btn.active { color: var(--gold); }
.mob-nav-icon { font-size: 19px; line-height: 1; }

@media (max-width: 768px) {
  /* Header */
  header { padding: 0 10px; height: 50px; }
  .h-brand-name { display: none; }
  .h-nav { display: none !important; }
  .sse-label { display: none; }
  .user-chip { display: none !important; }
  .h-search { max-width: 130px !important; }
  .logout-btn { font-size: 11px; padding: 5px 8px; letter-spacing: 0; }
  .store-toggle { font-size: 11px; padding: 4px 7px; gap: 5px; }

  /* Show mobile nav */
  .mob-nav { display: flex; }

  /* Shift banner */
  .shift-banner { padding: 8px 12px; gap: 8px; }
  .shift-banner-sub { display: none; }
  .shift-close-btn { padding: 6px 14px; font-size: 12px; }

  /* Kanban */
  #kanbanView { padding: 10px 8px 70px; gap: 8px; }
  .column { flex: 0 0 255px; max-height: calc(100vh - 120px); }
  .col-header { padding: 10px 12px 8px; }
  .col-cards { padding: 0 8px 10px; }

  /* Cards */
  .card { padding: 11px 12px; }
  .card-num { font-size: 15px; }
  .card-client { font-size: 13px; }
  .card-total { font-size: 16px; margin-bottom: 8px; }
  .card-actions .btn { padding: 10px 8px; font-size: 12px; min-height: 40px; }
  .card-timer { font-size: 10px; }

  /* Other tabs */
  #tabMetricas, #tabPrecios, #tabUsuarios {
    overflow-y: auto; padding-bottom: 70px;
  }
  .kpi-grid { grid-template-columns: repeat(2, 1fr) !important; }
  .two-col { grid-template-columns: 1fr !important; }
}
`;

html = html.replace('</style>', mobileCss + '\n</style>');

// 2. Inject mobile nav HTML after </header>
const mobileNav = `
  <!-- Mobile bottom navigation -->
  <nav class="mob-nav" id="mobNav">
    <button class="mob-nav-btn active" id="mobBtnPedidos"  onclick="switchTab('pedidos')">
      <span class="mob-nav-icon">&#x1F5C2;</span>Pedidos
    </button>
    <button class="mob-nav-btn" id="mobBtnMetricas" onclick="switchTab('metricas')">
      <span class="mob-nav-icon">&#x1F4CA;</span>M\u00e9tricas
    </button>
    <button class="mob-nav-btn" id="mobBtnPrecios"  onclick="switchTab('precios')">
      <span class="mob-nav-icon">&#x1F3F7;</span>Precios
    </button>
    <button class="mob-nav-btn" id="mobBtnUsuarios" onclick="switchTab('usuarios')" style="display:none">
      <span class="mob-nav-icon">&#x1F465;</span>Usuarios
    </button>
  </nav>`;

html = html.replace('</header>', '</header>' + mobileNav);

// 3. Update switchTab to sync mobile nav active state
const oldSwitchTabEnd = `  if`;
const mobNavSync = `  // sync mobile nav
  const mobMap = { pedidos:'mobBtnPedidos', metricas:'mobBtnMetricas', precios:'mobBtnPrecios', usuarios:'mobBtnUsuarios' };
  document.querySelectorAll('.mob-nav-btn').forEach(el => el.classList.remove('active'));
  const mobBtn = document.getElementById(mobMap[tab] || 'mobBtnPedidos');
  if (mobBtn) mobBtn.classList.add('active');
  if`;

html = html.replace('function switchTab(tab) {\n  document.querySelectorAll(\'.tab-content\').forEach(el => el.classList.remove(\'active\'));\n  document.querySelectorAll(\'.tab-btn\').forEach(el => el.classList.remove(\'active\'));\n  const tabMap = { pedidos:\'tabPedidos\', metricas:\'tabMetricas\', precios:\'tabPrecios\', usuarios:\'tabUsuarios\' };\n  const btnMap = { pedidos:\'btnPedidos\', metricas:\'btnMetricas\', precios:\'btnPrecios\',  usuarios:\'btnUsuarios\' };\n  document.getElementById(tabMap[tab] || \'tabPedidos\').classList.add(\'active\');\n  document.getElementById(btnMap[tab] || \'btnPedidos\').classList.add(\'active\');\n  if',
  'function switchTab(tab) {\n  document.querySelectorAll(\'.tab-content\').forEach(el => el.classList.remove(\'active\'));\n  document.querySelectorAll(\'.tab-btn\').forEach(el => el.classList.remove(\'active\'));\n  const tabMap = { pedidos:\'tabPedidos\', metricas:\'tabMetricas\', precios:\'tabPrecios\', usuarios:\'tabUsuarios\' };\n  const btnMap = { pedidos:\'btnPedidos\', metricas:\'btnMetricas\', precios:\'btnPrecios\',  usuarios:\'btnUsuarios\' };\n  document.getElementById(tabMap[tab] || \'tabPedidos\').classList.add(\'active\');\n  document.getElementById(btnMap[tab] || \'btnPedidos\').classList.add(\'active\');\n  // sync mobile nav\n  const mobMap = { pedidos:\'mobBtnPedidos\', metricas:\'mobBtnMetricas\', precios:\'mobBtnPrecios\', usuarios:\'mobBtnUsuarios\' };\n  document.querySelectorAll(\'.mob-nav-btn\').forEach(el => el.classList.remove(\'active\'));\n  const mobBtn = document.getElementById(mobMap[tab] || \'mobBtnPedidos\');\n  if (mobBtn) mobBtn.classList.add(\'active\');\n  if');

fs.writeFileSync('admin/index.html', html);
console.log('Done');
