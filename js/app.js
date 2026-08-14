/*!
 * app.js — Interfaz de la Herramienta de Selección de Grado PG · SICT/DGST
 * Mapa con Leaflet (basemaps calle/satélite, escala, brújula, logo).
 * Requiere: datos.js (ESTACIONES, TASAS), anexoA.js (ANEXOA), edos.js (EDO, ESTADOS),
 *           cadenamientos.js (CAD), estados_geo.js (ESTADOS_GEO), pg-engine.js (PG),
 *           Leaflet, jsPDF y html2canvas (para el reporte).
 */
(function () {
  "use strict";

  const ESTACIONES = window.ESTACIONES || [];
  const ANEXOA = window.ANEXOA || [];
  const TASAS = window.TASAS || {};
  const EDO = window.EDO || {};
  const ESTADOS = window.ESTADOS || [];
  const CAD = window.CAD || {};
  const DV = window.DV2024 || [];   // aforos Datos Viales 2024 [la,lo,td,sc,car,a,b,c2,c3,t3s2,t3s3,t3s2r4,otros]
  const VELOP = window.VELOP || []; // velocidades de punto DGST 2025 [la,lo,vAuto,vBus,vCam] (km/h)
  const FDPROF = window.FDPROF || []; // factores de daño II-UNAM por profundidad (p=6.0) [[z_cm,{A,B,...}],...]
  // Factores de daño a la profundidad z (interpolación lineal), con claves del dashboard
  function fdProfundidad(zcm) {
    if (!FDPROF.length) return null;
    let f = null;
    if (zcm <= FDPROF[0][0]) f = FDPROF[0][1];
    else if (zcm >= FDPROF[FDPROF.length - 1][0]) f = FDPROF[FDPROF.length - 1][1];
    else for (let i = 0; i < FDPROF.length - 1; i++) { const [z0, f0] = FDPROF[i], [z1, f1] = FDPROF[i + 1]; if (zcm >= z0 && zcm <= z1) { const r = (zcm - z0) / (z1 - z0), o = {}; for (const k in f0) o[k] = f0[k] + (f1[k] - f0[k]) * r; f = o; break; } }
    if (!f) return null;
    return { a: f.A, b: f.B, c2: f.C2, c3: f.C3, t3s2: f.T3S2, t3s3: f.T3S3, t3s2r4: f.T3S2R4, otros: f.C3 };
  }
  const edoDe = (cp) => EDO[cp] || "";
  let filtroEdo = "";
  let tramoActual = null;   // tramo del Anexo A seleccionado (para cadenamiento)
  let aforoFuente = null;   // origen del aforo usado {tipo:"DV2024"|"manual", est, dist, misma, anio}

  const COLOR_PG = { 64: "#2c7fb8", 70: "#41ab5d", 76: "#f5a623", 82: "#c0392b" };
  // URL fija del validador del QR (configuración de código; cambiar cuando SICT publique validar.html)
  const VALIDADOR_URL = "https://www.sict.gob.mx/dgst/validar.html";
  // MODO CARPETA (puente mientras la DGST habilita el validador):
  // pega aquí el VÍNCULO COMPARTIDO de la carpeta (OneDrive / Dropbox / Google Drive) donde guardarás los PDF.
  // Si tiene contenido, el QR abrirá esa carpeta y el reporte se localiza por su nombre «Reporte_<número>.pdf».
  // Déjalo en "" para usar el validador (VALIDADOR_URL) con los datos embebidos en el QR.
  const CARPETA_REPORTES_URL = "";
  const $ = (id) => document.getElementById(id);
  const gradoDe = (pg) => { const m = /PG (\d+)/.exec(pg || ""); return m ? +m[1] : 0; };

  let estudio = null;   // punto de estudio
  let segSel = null;    // subsegmento por cadenamiento (dos extremos)
  let aforoRes = null;  // último cálculo de aforo (para el PDF)
  let diseno = null;    // diseño de mezcla y cantidades (para el PDF)

  /* =============== Cadenamiento (K+MMM) =============== */
  const rangoCad = (cp) => { const r = CAD[cp]; return r ? { ini: r[0], fin: r[1], src: r[2] } : null; };
  function parseCad(str) {
    if (str == null) return null;
    let s = String(str).trim().replace(/\s/g, "");
    if (!s) return null;
    if (s.includes("+")) { const [k, m] = s.split("+"); const km = parseFloat(k || "0"), me = parseFloat(m || "0"); if (isNaN(km) || isNaN(me)) return null; return km + me / 1000; }
    const v = parseFloat(s.replace(",", ".")); return isNaN(v) ? null : v;
  }
  const fmtCad = (km) => { const k = Math.floor(km + 1e-9); const m = Math.round((km - k) * 1000); return k + "+" + String(m).padStart(3, "0"); };
  // Punto sobre la polilínea g a la fracción f (0..1) de su longitud
  function puntoEnFraccion(g, f) {
    if (!g || g.length < 2) return g && g[0];
    if (f <= 0) return g[0]; if (f >= 1) return g[g.length - 1];
    const d = []; let tot = 0;
    for (let i = 0; i < g.length - 1; i++) { const dl = g[i + 1][0] - g[i][0], dn = (g[i + 1][1] - g[i][1]) * Math.cos(g[i][0] * Math.PI / 180); const seg = Math.hypot(dl, dn); d.push(seg); tot += seg; }
    let target = f * tot, acc = 0;
    for (let i = 0; i < d.length; i++) { if (acc + d[i] >= target) { const r = d[i] ? (target - acc) / d[i] : 0; return [g[i][0] + (g[i + 1][0] - g[i][0]) * r, g[i][1] + (g[i + 1][1] - g[i][1]) * r]; } acc += d[i]; }
    return g[g.length - 1];
  }
  function subTrazo(g, f1, f2) { const a = Math.min(f1, f2), b = Math.max(f1, f2), N = 24, out = []; for (let i = 0; i <= N; i++) out.push(puntoEnFraccion(g, a + (b - a) * i / N)); return out; }

  /* =============== MAPA (Leaflet) =============== */
  const rc = L.canvas({ padding: 0.5 });
  const mapa = L.map("mapa", { center: [23.6, -102], zoom: 5, zoomControl: false, preferCanvas: true, minZoom: 4, maxZoom: 18 });

  const bmClaro = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", { maxZoom: 19, crossOrigin: true, subdomains: "abcd", attribution: "© OpenStreetMap · © CARTO" });
  const bmCalle = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, crossOrigin: true, attribution: "© OpenStreetMap" });
  const bmSat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, crossOrigin: true, attribution: "Imágenes © Esri, Maxar, Earthstar Geographics" });
  bmClaro.addTo(mapa);
  L.control.layers({ "Claro": bmClaro, "Calle": bmCalle, "Satélite": bmSat }, null, { position: "topright", collapsed: false }).addTo(mapa);
  L.control.zoom({ position: "topright" }).addTo(mapa);
  L.control.scale({ metric: true, imperial: false, position: "bottomleft", maxWidth: 160 }).addTo(mapa);

  // Límites estatales (INEGI, ITRF2008 reproyectado a WGS84)
  if (window.ESTADOS_GEO) L.geoJSON(window.ESTADOS_GEO, { renderer: rc, interactive: false, style: { color: "#3f454b", weight: 1, fill: false, opacity: 0.6 } }).addTo(mapa);

  // Todas las rutas de la RCF, coloreadas por grado PG
  const rutasFC = { type: "FeatureCollection", features: ANEXOA.filter((t) => t.g && t.g.length > 1).map((t) => ({ type: "Feature", properties: { t }, geometry: { type: "LineString", coordinates: t.g.map((p) => [p[1], p[0]]) } })) };
  L.geoJSON(rutasFC, {
    renderer: rc,
    style: (f) => ({ color: COLOR_PG[gradoDe(f.properties.t.pg)] || "#888", weight: 2, opacity: 0.85 }),
    onEachFeature: (f, l) => { const t = f.properties.t; l.bindTooltip(`<b>${t.car || t.cp}</b><br>${t.tr || ""} · ${t.pg}`, { sticky: true }); l.on("click", () => seleccionarTramo(t)); }
  }).addTo(mapa);

  // Capas de resaltado (selección)
  let capaSel = null, capaSeg = null, capaPunto = null;
  const quitar = (c) => { if (c) mapa.removeLayer(c); return null; };
  function resaltarTrazo(g) { capaSel = quitar(capaSel); capaSel = L.polyline(g.map((p) => [p[0], p[1]]), { color: "#611232", weight: 5, opacity: 0.95, renderer: rc }).addTo(mapa); return capaSel.getBounds(); }
  function resaltarSegmento(pts) { capaSeg = quitar(capaSeg); capaSeg = L.polyline(pts.map((p) => [p[0], p[1]]), { color: "#a57f2c", weight: 6, opacity: 0.95, renderer: rc }).addTo(mapa); return capaSeg.getBounds(); }
  function marcarPunto(lat, lon) { capaPunto = quitar(capaPunto); capaPunto = L.circleMarker([lat, lon], { radius: 8, color: "#611232", weight: 3, fillColor: "#fff", fillOpacity: 1, renderer: rc }).addTo(mapa); }
  function volarA(bounds, maxZoom) { try { mapa.fitBounds(bounds, { padding: [55, 55], maxZoom: maxZoom || 14 }); } catch (e) {} }
  function volarAPunto(lat, lon) { mapa.flyTo([lat, lon], Math.max(mapa.getZoom(), 11), { duration: 0.6 }); }

  // Etiquetas de cadenamiento (inicio/fin) y nombre de la carretera sobre el trazo
  const capaEtiq = L.layerGroup().addTo(mapa);
  const medio = (g) => g[Math.floor(g.length / 2)];
  function limpiarEtiq() { capaEtiq.clearLayers(); }
  function ponerEtiq(p, txt, dir) {
    L.circleMarker(p, { radius: 4, color: "#611232", weight: 2, fillColor: "#fff", fillOpacity: 1, renderer: rc }).addTo(capaEtiq);
    L.tooltip({ permanent: true, direction: dir || "top", className: "etq-cad", offset: [0, -4] }).setLatLng(p).setContent(txt).addTo(capaEtiq);
  }
  function etiquetasTrazo(g, tIni, tFin, nombre) {
    limpiarEtiq();
    if (!g || g.length < 2) return;
    ponerEtiq(g[0], "▶ " + tIni, "left");
    ponerEtiq(g[g.length - 1], tFin + " ◼", "right");
    if (nombre) L.tooltip({ permanent: true, direction: "top", className: "etq-nom" }).setLatLng(medio(g)).setContent(nombre).addTo(capaEtiq);
  }

  // Clic en el mapa (módulo de análisis) → refija el punto y recalcula
  mapa.on("click", (e) => {
    $("plat").value = e.latlng.lat.toFixed(4); $("plon").value = e.latlng.lng.toFixed(4);
    const rp = document.querySelector('input[name="modoUb"][value="punto"]'); if (rp) rp.checked = true;
    document.querySelectorAll('input[name="modoUb"]').forEach((r) => r.dispatchEvent(new Event("change")));
    capaSel = quitar(capaSel); capaSeg = quitar(capaSeg); limpiarEtiq(); tramoActual = null; segSel = null;
    const cb = $("cad-bloque"); if (cb) cb.classList.add("oculto");
    calcularPunto();
    if (aforoRes) { try { calcularDiseno(); } catch (e2) {} }
  });

  // Logo SICT (arriba-izquierda)
  const CtlLogo = L.Control.extend({ options: { position: "topleft" }, onAdd: function () { const d = L.DomUtil.create("div", "logo-mapa"); if (window.LOGO) d.innerHTML = '<img src="' + window.LOGO + '" alt="SICT">'; return d; } });
  new CtlLogo().addTo(mapa);

  // Rosa de los vientos (brújula) — abajo-derecha
  const CtlBrujula = L.Control.extend({
    options: { position: "bottomright" },
    onAdd: function () {
      const d = L.DomUtil.create("div", "brujula");
      d.innerHTML = '<svg viewBox="0 0 54 54" width="48" height="48" aria-label="Norte">' +
        '<circle cx="27" cy="27" r="24" fill="#ffffff" stroke="#611232" stroke-width="1.5" opacity="0.92"/>' +
        '<polygon points="27,6 33,29 27,24 21,29" fill="#611232"/>' +
        '<polygon points="27,48 33,29 27,34 21,29" fill="#c4beb6"/>' +
        '<text x="27" y="17" text-anchor="middle" font-size="10" font-weight="700" fill="#611232">N</text></svg>';
      return d;
    }
  });
  new CtlBrujula().addTo(mapa);

  function leyenda() {
    $("leyenda").innerHTML =
      [64, 70, 76].map((g) => `<span><i style="background:${COLOR_PG[g]}"></i>PG ${g}</span>`).join("") +
      `<span><i style="background:#611232;height:3px;border-radius:0"></i>Selección</span>` +
      `<span><i style="background:#a57f2c;height:3px;border-radius:0"></i>Segmento</span>` +
      `<span><i style="background:#3f454b;height:2px;border-radius:0"></i>Límites estatales (INEGI)</span>`;
  }
  function chips() {
    const g = {}; ANEXOA.forEach((t) => { const k = gradoDe(t.pg); g[k] = (g[k] || 0) + 1; });
    $("chips").innerHTML =
      `<div class="c">Tramos (Anexo A)<b>${ANEXOA.length.toLocaleString("es-MX")}</b></div>` +
      `<div class="c">Estaciones SMN<b>${ESTACIONES.length.toLocaleString("es-MX")}</b></div>` +
      `<div class="c">PG 64 / 70 / 76<b>${g[64] || 0}/${g[70] || 0}/${g[76] || 0}</b></div>`;
  }

  /* =============== Módulos: Captura / Análisis =============== */
  function mostrarModulo(m) {
    document.querySelectorAll(".modtabs button").forEach((b) => b.classList.toggle("activa", b.dataset.mod === m));
    const cap = $("modulo-captura"), an = $("modulo-analisis");
    if (cap) cap.classList.toggle("oculto", m !== "captura");
    if (an) an.classList.toggle("oculto", m !== "analisis");
    if (m === "analisis") setTimeout(function () { try { mapa.invalidateSize(); reencuadrar(); } catch (e) {} }, 60);
    try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch (e) { window.scrollTo(0, 0); }
  }
  document.querySelectorAll(".modtabs button").forEach((b) => b.addEventListener("click", () => mostrarModulo(b.dataset.mod)));
  // Compatibilidad: las funciones de cálculo llaman mostrarPanel(); ahora es no-op (el layout es por módulos).
  function mostrarPanel() {}
  // Reencuadra el mapa a la última selección
  function reencuadrar() {
    try {
      if (capaSeg) volarA(capaSeg.getBounds(), 15);
      else if (capaSel) volarA(capaSel.getBounds(), 13);
      else if (estudio && estudio.lat != null) volarAPunto(estudio.lat, estudio.lon);
    } catch (e) {}
  }
  // Selector de modo de ubicación (carretera / punto / segmento)
  function modoUbicacion() { const r = document.querySelector('input[name="modoUb"]:checked'); return r ? r.value : "carretera"; }
  document.querySelectorAll('input[name="modoUb"]').forEach((r) => r.addEventListener("change", () => {
    const m = modoUbicacion();
    $("ub-carretera") && $("ub-carretera").classList.toggle("oculto", m !== "carretera");
    $("ub-punto") && $("ub-punto").classList.toggle("oculto", m !== "punto");
    $("ub-segmento") && $("ub-segmento").classList.toggle("oculto", m !== "segmento");
  }));

  // Orquestador: calcula ubicación + aforo + diseño y pasa al módulo de análisis
  function analizarTodo() {
    const modo = modoUbicacion();
    if (modo === "carretera") {
      if (!tramoActual) { alert("Selecciona una carretera del Anexo A en el buscador."); return; }
      const ci = parseCad($("cad-ini").value), cf = parseCad($("cad-fin").value);
      if (ci != null && cf != null && cf - ci > 1e-6) analizarSegmento(); // segmento por cadenamiento
    } else if (modo === "punto") {
      const la = parseFloat($("plat").value), lo = parseFloat($("plon").value);
      if (isNaN(la) || isNaN(lo)) { alert("Captura la latitud y la longitud del punto."); return; }
      calcularPunto();
    } else {
      const a = [parseFloat($("plat3").value), parseFloat($("plon3").value), parseFloat($("plat2").value), parseFloat($("plon2").value)];
      if (a.some(isNaN)) { alert("Captura las coordenadas de inicio y de fin del segmento."); return; }
      calcularSegmentoCoords();
    }
    if (!estudio) { alert("Define la ubicación del estudio."); return; }
    const rv = $("res-vacio"); if (rv) rv.style.display = "none";
    if (estudio.ga !== "ESP") { calcularAforo(false); if (!aforoRes) { mostrarModulo("captura"); return; } }
    if (aforoRes) { try { calcularDiseno(); } catch (e) {} }
    mostrarModulo("analisis");
  }

  /* =============== Estación climática más cercana =============== */
  function estacionCercana(lat, lon) {
    let best = null, bd = 1e9;
    for (const s of ESTACIONES) { const d = (s.la - lat) ** 2 + (s.lo - lon) ** 2; if (d < bd) { bd = d; best = s; } }
    return { estacion: best, distKm: Math.sqrt(bd) * 111 };
  }
  // Evaluador puro de temperatura/PG en un punto (sin tocar el estado)
  function evalTemp(lat, lon) {
    const { estacion: s, distKm } = estacionCercana(lat, lon);
    const tx = PG.tmaxPavimento(s.TM, lat, s.sM), tn = PG.tminPavimento(s.Tm, lat, s.sm);
    return { s, distKm, tx, tn, ga: PG.gradoAlto(tx), gb: PG.gradoBajo(tn) };
  }
  function evaluarPunto(lat, lon, carretera, sinMarcador) {
    const { s, distKm, tx, tn, ga, gb } = evalTemp(lat, lon);
    estudio = { carretera, lat, lon, ga, gb, rg: s.rg || "", tx, tn,
                estNom: s.nm, estDist: distKm, TM: s.TM, sM: s.sM, Tm: s.Tm, sm: s.sm };
    aforoRes = null; diseno = null;
    const tasa = TASAS[s.rg]; if (tasa != null) $("tasa").value = (tasa * 100).toFixed(1);
    if (!sinMarcador) marcarPunto(lat, lon);
    aforoFuente = null;   // ubicación nueva (acción explícita) → se permite precargar de nuevo
    precargarAforo(carretera && carretera.car);
    return { s, distKm, tx, tn, ga, gb };
  }

  /* =============== Buscar carretera (Anexo A) — con teclado =============== */
  const q = $("q"), qlista = $("q-lista");
  let sel = -1, items = [];
  function pinta(lista) {
    qlista.innerHTML = ""; items = lista; sel = -1;
    if (!lista.length) { qlista.innerHTML = '<div class="item vacio">Sin coincidencias en el Anexo A</div>'; return; }
    lista.forEach((t, i) => {
      const d = document.createElement("div"); d.className = "item"; d.setAttribute("role", "option"); d.dataset.i = i;
      d.innerHTML = `<b>${t.car || t.cp}</b><span>${t.tr || ""} · ${t.cp} · <em>${t.pg}</em></span>`;
      d.addEventListener("mousedown", (e) => { e.preventDefault(); seleccionarTramo(t); });
      qlista.appendChild(d);
    });
  }
  function mostrarLista() {
    const s = q.value.toLowerCase().trim();
    const bolsa = filtroEdo ? ANEXOA.filter((t) => edoDe(t.cp) === filtroEdo) : ANEXOA;
    const res = (s.length === 0 ? bolsa
      : bolsa.filter((t) => (t.car && t.car.toLowerCase().includes(s)) || (t.tr && t.tr.toLowerCase().includes(s)) ||
                             String(t.cp).toLowerCase().includes(s) || String(t.dg).toLowerCase().includes(s))).slice(0, 150);
    pinta(res);
  }
  q.addEventListener("focus", mostrarLista);
  q.addEventListener("input", mostrarLista);

  // Filtro por estado (entidad): llena el selector, filtra la lista y encuadra el mapa
  const edoSel = $("edo");
  function initEstados() {
    if (!edoSel) return;
    ESTADOS.forEach((e) => { const o = document.createElement("option"); o.value = e; o.textContent = e; edoSel.appendChild(o); });
    edoSel.addEventListener("change", () => {
      filtroEdo = edoSel.value;
      mostrarLista();
      if (filtroEdo) encuadrarEstado(filtroEdo); else mapa.flyTo([23.6, -102], 5, { duration: 0.6 });
    });
  }
  function encuadrarEstado(edo) {
    const ts = ANEXOA.filter((t) => edoDe(t.cp) === edo);
    if (!ts.length) return;
    volarA(L.latLngBounds(ts.map((t) => [t.la, t.lo])), 9);
  }
  q.addEventListener("keydown", (e) => {
    if (!items.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); marca(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); marca(); }
    else if (e.key === "Enter" && sel >= 0) { e.preventDefault(); seleccionarTramo(items[sel]); }
    else if (e.key === "Escape") { qlista.innerHTML = ""; }
  });
  function marca() {
    [...qlista.children].forEach((c, i) => c.classList.toggle("activo", i === sel));
    const el = qlista.children[sel]; if (el) el.scrollIntoView({ block: "nearest" });
  }
  document.addEventListener("click", (e) => { if (e.target !== q && !qlista.contains(e.target)) qlista.innerHTML = ""; });

  function seleccionarTramo(t) {
    tramoActual = t; segSel = null; capaSeg = quitar(capaSeg);
    const { s, distKm } = evaluarPunto(t.la, t.lo, t, true);
    capaPunto = quitar(capaPunto);
    q.value = t.car || t.cp; qlista.innerHTML = "";
    prepararCadenamiento(t);
    const b = resaltarTrazo(t.g); volarA(b, 13);
    const rc0 = rangoCad(t.cp);
    etiquetasTrazo(t.g, rc0 ? fmtCad(rc0.ini) : "inicio", rc0 ? fmtCad(rc0.fin) : "fin", t.car || t.cp);
    mostrarPanel("carretera");
    $("res-ubicacion").innerHTML = tarjeta(PG.pgTexto(estudio.ga, estudio.gb), null, `
      <tr><td>Carretera</td><td>${t.car || "—"}</td></tr>
      <tr><td>Tramo</td><td>${t.tr || "—"}</td></tr>
      <tr><td>Clave PARCF / DGCC</td><td>${t.cp} / ${t.dg || "—"}</td></tr>
      <tr><td>Red</td><td>${t.gr}</td></tr>
      <tr class="sep"><td>T. máx / mín pavimento</td><td>${estudio.tx.toFixed(1)} / ${estudio.tn.toFixed(1)} °C</td></tr>
      <tr><td>Estación clima</td><td>${s.nm} (${distKm.toFixed(0)} km)</td></tr>`,
      "Trazo resaltado y ampliado en el mapa. Abajo puedes acotar el cadenamiento del segmento; para el PG final agrega el aforo.");
  }

  // Muestra el bloque de cadenamiento con el rango del tramo y valores por defecto
  function prepararCadenamiento(t) {
    const blo = $("cad-bloque"); if (!blo) return;
    const _c = $("cad-res"); if (_c) _c.innerHTML = "";
    const r = rangoCad(t.cp);
    if (!r) { blo.classList.add("oculto"); return; }
    const fuente = r.src === "D" ? "clave DGCC" : "trazo (warehouse)";
    $("cad-rango").innerHTML = `Rango del tramo <strong>${t.cp}</strong>: <strong>${fmtCad(r.ini)}</strong> a <strong>${fmtCad(r.fin)}</strong> (${(r.fin - r.ini).toFixed(1)} km · ${fuente}).`;
    $("cad-ini").value = fmtCad(r.ini); $("cad-fin").value = fmtCad(r.fin);
    blo.classList.remove("oculto");
    actualizarLongitud();
  }

  // Analiza el subsegmento: PG por los DOS extremos (M·MMP·4·05·064/22)
  function analizarSegmento() {
    const t = tramoActual; if (!t) { alert("Primero selecciona una carretera del Anexo A."); return; }
    const r = rangoCad(t.cp); if (!r) { alert("Este tramo no tiene cadenamiento disponible."); return; }
    const ci = parseCad($("cad-ini").value), cf = parseCad($("cad-fin").value);
    if (ci == null || cf == null) { alert("Cadenamiento inválido. Usa formato 0+000 o kilómetros decimales (1.7)."); return; }
    if (ci < r.ini - 1e-6 || cf > r.fin + 1e-6) { alert("Fuera del rango del tramo (" + fmtCad(r.ini) + " a " + fmtCad(r.fin) + ")."); return; }
    if (cf - ci <= 1e-6) { alert("El cadenamiento final debe ser mayor al inicial."); return; }
    const L2 = r.fin - r.ini, f1 = (ci - r.ini) / L2, f2 = (cf - r.ini) / L2;
    const p1 = puntoEnFraccion(t.g, f1), p2 = puntoEnFraccion(t.g, f2);
    const e1 = evalTemp(p1[0], p1[1]), e2 = evalTemp(p2[0], p2[1]);
    const txMax = Math.max(e1.tx, e2.tx), tnMin = Math.min(e1.tn, e2.tn);
    const ga = PG.gradoAlto(txMax), gb = PG.gradoBajo(tnMin);
    const eg = e1.tx >= e2.tx ? e1 : e2, s = eg.s;         // extremo que rige el grado alto
    estudio = { carretera: t, lat: (p1[0] + p2[0]) / 2, lon: (p1[1] + p2[1]) / 2, ga, gb, rg: s.rg || "",
                tx: txMax, tn: tnMin, estNom: s.nm, estDist: eg.distKm, TM: s.TM, sM: s.sM, Tm: s.Tm, sm: s.sm,
                segmento: { ci, cf, ini: r.ini, fin: r.fin, e1, e2, p1, p2, src: r.src } };
    aforoRes = null; diseno = null;
    // No se re-precarga aquí: el aforo ya se cargó al elegir la carretera y se respeta lo capturado.
    segSel = subTrazo(t.g, f1, f2);
    capaPunto = quitar(capaPunto);
    const b = resaltarSegmento(segSel); volarA(b, 15);
    etiquetasTrazo(segSel, fmtCad(ci), fmtCad(cf), t.car || t.cp);
    const pgE = (e) => PG.pgTexto(e.ga, e.gb);
    $("res-ubicacion").innerHTML = tarjeta(PG.pgTexto(ga, gb), "Segmento " + fmtCad(ci) + " a " + fmtCad(cf) + " · " + (cf - ci).toFixed(1) + " km", `
      <tr><td><b>Extremo inicial (${fmtCad(ci)})</b></td><td><b>${pgE(e1)}</b></td></tr>
      <tr><td>T. máx / mín pavimento</td><td>${e1.tx.toFixed(1)} / ${e1.tn.toFixed(1)} °C</td></tr>
      <tr class="sep"><td><b>Extremo final (${fmtCad(cf)})</b></td><td><b>${pgE(e2)}</b></td></tr>
      <tr><td>T. máx / mín pavimento</td><td>${e2.tx.toFixed(1)} / ${e2.tn.toFixed(1)} °C</td></tr>
      <tr class="sep"><td>Rige (más desfavorable)</td><td>T. máx ${txMax.toFixed(1)} °C · T. mín ${tnMin.toFixed(1)} °C</td></tr>
      <tr><td>Estación clima (extremo que rige)</td><td>${s.nm} (${eg.distKm.toFixed(0)} km)</td></tr>`,
      "El PG del segmento se rige por el extremo más desfavorable (T. máx mayor y T. mín menor). Para el PG final por tránsito, ve a la pestaña ③ Aforo.");
  }

  /* =============== Calcular PG en un punto =============== */
  function calcularPunto() {
    const lat = parseFloat($("plat").value), lon = parseFloat($("plon").value);
    if (isNaN(lat) || isNaN(lon)) { alert("Ingresa latitud y longitud, o haz clic en el mapa."); return; }
    tramoActual = null; segSel = null; capaSel = quitar(capaSel); capaSeg = quitar(capaSeg); limpiarEtiq();
    const cb = $("cad-bloque"); if (cb) cb.classList.add("oculto");
    const { s, distKm, tx, tn, ga, gb } = evaluarPunto(lat, lon, null);
    volarAPunto(lat, lon);
    $("res-ubicacion").innerHTML = tarjeta(PG.pgTexto(ga, gb), null, `
      <tr><td>T. máx pavimento (20 mm)</td><td>${tx.toFixed(1)} °C</td></tr>
      <tr><td>T. mín pavimento</td><td>${tn.toFixed(1)} °C</td></tr>
      <tr class="sep"><td>Región / crecimiento</td><td>${estudio.rg || "—"} · ${TASAS[estudio.rg] != null ? (TASAS[estudio.rg] * 100).toFixed(1) + " %" : "—"}</td></tr>
      <tr><td>Estación clima (más cercana)</td><td>${s.nm} (${distKm.toFixed(0)} km)</td></tr>
      <tr><td>T. aire máx 7 d / σ</td><td>${s.TM} / ${s.sM} °C</td></tr>
      <tr><td>T. aire mín / σ</td><td>${s.Tm} / ${s.sm} °C</td></tr>`,
      "Grado por temperatura. Agrega el aforo para el nivel de ajuste.");
  }

  /* =============== Avanzado: segmento por coordenadas (inicio y fin) =============== */
  function calcularSegmentoCoords() {
    const la1 = parseFloat($("plat3").value), lo1 = parseFloat($("plon3").value);
    const la2 = parseFloat($("plat2").value), lo2 = parseFloat($("plon2").value);
    if ([la1, lo1, la2, lo2].some(isNaN)) { alert("Captura las coordenadas de INICIO (arriba) y de FIN del segmento."); return; }
    if (la1 === la2 && lo1 === lo2) { alert("Las coordenadas de inicio y de fin no pueden ser iguales."); return; }
    tramoActual = null; segSel = null; capaSel = quitar(capaSel);
    const cb = $("cad-bloque"); if (cb) cb.classList.add("oculto");
    const e1 = evalTemp(la1, lo1), e2 = evalTemp(la2, lo2);
    const txMax = Math.max(e1.tx, e2.tx), tnMin = Math.min(e1.tn, e2.tn);
    const ga = PG.gradoAlto(txMax), gb = PG.gradoBajo(tnMin);
    const eg = e1.tx >= e2.tx ? e1 : e2, s = eg.s;         // extremo que rige el grado alto
    estudio = { carretera: null, lat: (la1 + la2) / 2, lon: (lo1 + lo2) / 2, ga, gb, rg: s.rg || "",
                tx: txMax, tn: tnMin, estNom: s.nm, estDist: eg.distKm, TM: s.TM, sM: s.sM, Tm: s.Tm, sm: s.sm,
                segmento: { coords: true, p1: [la1, lo1], p2: [la2, lo2], e1, e2 } };
    aforoRes = null; diseno = null;
    const tasa = TASAS[s.rg]; if (tasa != null) $("tasa").value = (tasa * 100).toFixed(1);
    const g = [[la1, lo1], [la2, lo2]];
    segSel = g; capaPunto = quitar(capaPunto);
    const b = resaltarSegmento(g); volarA(b, 14);
    etiquetasTrazo(g, "inicio", "fin", "Segmento (coordenadas)");
    aforoFuente = null;   // ubicación nueva (acción explícita)
    precargarAforo(null);
    const pgE = (e) => PG.pgTexto(e.ga, e.gb);
    $("res-ubicacion").innerHTML = tarjeta(PG.pgTexto(ga, gb), "Segmento por coordenadas · rige el extremo más desfavorable", `
      <tr><td><b>Inicio (${la1.toFixed(4)}, ${lo1.toFixed(4)})</b></td><td><b>${pgE(e1)}</b></td></tr>
      <tr><td>T. máx / mín pavimento</td><td>${e1.tx.toFixed(1)} / ${e1.tn.toFixed(1)} °C</td></tr>
      <tr class="sep"><td><b>Fin (${la2.toFixed(4)}, ${lo2.toFixed(4)})</b></td><td><b>${pgE(e2)}</b></td></tr>
      <tr><td>T. máx / mín pavimento</td><td>${e2.tx.toFixed(1)} / ${e2.tn.toFixed(1)} °C</td></tr>
      <tr class="sep"><td>Rige (más desfavorable)</td><td>T. máx ${txMax.toFixed(1)} °C · T. mín ${tnMin.toFixed(1)} °C</td></tr>
      <tr><td>Estación clima (extremo que rige)</td><td>${s.nm} (${eg.distKm.toFixed(0)} km)</td></tr>`,
      "PG del segmento por los dos extremos (M·MMP·4·05·064/22). El aforo se precargó del punto medio; edítalo en el paso ③ si tienes uno propio.");
  }

  /* =============== Aforo precargado desde Datos Viales 2024 =============== */
  const normNom = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  // Estación de aforo más cercana; prefiere la misma carretera (por nombre) dentro de 80 km
  function aforoCercano(lat, lon, carNombre) {
    if (!DV.length) return null;
    const nc = normNom(carNombre);
    let best = null, bd = 1e18, bestM = null, bdM = 1e18;
    for (const r of DV) {
      const d = (r[0] - lat) ** 2 + (r[1] - lon) ** 2;
      if (d < bd) { bd = d; best = r; }
      if (nc && normNom(r[4]) === nc && d < bdM) { bdM = d; bestM = r; }
    }
    if (bestM && Math.sqrt(bdM) * 111 < 80) return { rec: bestM, distKm: Math.sqrt(bdM) * 111, misma: true };
    if (!best) return null;
    return { rec: best, distKm: Math.sqrt(bd) * 111, misma: normNom(best[4]) === nc };
  }
  // Velocidad de operación (estación de velocidades de punto DGST más cercana)
  function velocidadCercana(lat, lon) {
    if (!VELOP.length) return null;
    let best = null, bd = 1e18;
    for (const r of VELOP) { const d = (r[0] - lat) ** 2 + (r[1] - lon) ** 2; if (d < bd) { bd = d; best = r; } }
    return { vAuto: best[2], vBus: best[3], vCam: best[4], distKm: Math.sqrt(bd) * 111 };
  }
  function bannerFuente() {
    const b = $("aforo-fuente"); if (!b) return;
    if (!aforoFuente) { b.className = "fuente oculto"; b.innerHTML = ""; return; }
    if (aforoFuente.tipo === "DV2024") {
      const v = aforoFuente.vel;
      b.className = "fuente";
      b.innerHTML = `Aforo de <b>Datos Viales 2024</b> · estación <b>${aforoFuente.est}</b> (${aforoFuente.dist.toFixed(0)} km${aforoFuente.misma ? ", misma carretera" : ", carretera más cercana"}).`
        + (v ? `<br>Velocidad de operación (camiones) <b>${v.vCam} km/h</b> — Velocidades de Punto DGST 2025 (${v.distKm.toFixed(0)} km).` : "")
        + ` Edita cualquier valor si tienes datos más recientes.`;
    } else {
      b.className = "fuente manual";
      b.innerHTML = `Aforo <b>capturado manualmente</b>. Se usará este en el reporte.`;
    }
  }
  // Precarga el aforo del estudio actual y calcula el ajuste automáticamente
  function precargarAforo(carNombre) {
    if (!estudio || estudio.ga === "ESP" || !DV.length) { aforoFuente = null; bannerFuente(); return; }
    // Si el usuario ya editó el aforo, respetar lo capturado (no sobrescribir).
    if (aforoFuente && aforoFuente.tipo === "manual") { calcularAforo(true); return; }
    const c = aforoCercano(estudio.lat, estudio.lon, carNombre);
    if (!c) { aforoFuente = null; bannerFuente(); return; }
    const r = c.rec;
    $("tdpa").value = r[2];
    const scv = String(r[3]), scSel = $("sc"); if (scSel && [...scSel.options].some((o) => o.value === scv)) scSel.value = scv;
    const mixMap = { a: r[5], b: r[6], c2: r[7], c3: r[8], t3s2: r[9], t3s3: r[10], t3s2r4: r[11], otros: r[12] };
    campos.forEach((k) => { if ($("v-" + k)) $("v-" + k).value = mixMap[k]; });
    sumaPct();
    // Velocidad de operación (camiones) de la estación de velocidades de punto DGST más cercana
    const vp = velocidadCercana(estudio.lat, estudio.lon);
    if (vp && $("vel")) $("vel").value = vp.vCam;
    aforoFuente = { tipo: "DV2024", est: r[4], dist: c.distKm, misma: c.misma, anio: 2024, vel: vp };
    bannerFuente();
    calcularAforo(true);
  }
  function marcarManual() { if (!aforoFuente || aforoFuente.tipo !== "manual") { aforoFuente = { tipo: "manual" }; bannerFuente(); } }

  /* =============== Aforo → PG final =============== */
  const PRESETS = {
    corredor: { a: 45, b: 4, c2: 12, c3: 9, t3s2: 14, t3s3: 8, t3s2r4: 6, otros: 2 },
    basica:   { a: 62, b: 5, c2: 14, c3: 8, t3s2: 6,  t3s3: 3, t3s2r4: 1, otros: 1 },
    turistica:{ a: 78, b: 8, c2: 8,  c3: 3, t3s2: 2,  t3s3: 1, t3s2r4: 0, otros: 0 },
  };
  const campos = ["a", "b", "c2", "c3", "t3s2", "t3s3", "t3s2r4", "otros"];
  function aplicarPreset(nombre) { const p = PRESETS[nombre]; if (!p) return; campos.forEach((k) => ($("v-" + k).value = p[k])); marcarManual(); sumaPct(); }
  function mezcla() { const m = {}; campos.forEach((k) => (m[k] = +$("v-" + k).value || 0)); return m; }
  function sumaPct() { const s = Object.values(mezcla()).reduce((a, b) => a + b, 0); const el = $("suma-pct"); if (el) { el.textContent = "Σ = " + s.toFixed(0) + " %"; el.className = "suma" + (Math.abs(s - 100) > 1 ? " mal" : " ok"); } return s; }
  campos.forEach((k) => $("v-" + k) && $("v-" + k).addEventListener("input", () => { marcarManual(); sumaPct(); }));
  ["tdpa", "sc", "carriles", "vel", "anios", "tasa"].forEach((id) => $(id) && $(id).addEventListener("input", marcarManual));
  document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => aplicarPreset(b.dataset.preset)));

  function calcularAforo(auto) {
    if (!estudio || estudio.ga === undefined) { if (!auto) alert("Primero fija un punto o una carretera (pestañas anteriores o clic en el mapa)."); return; }
    if (estudio.ga === "ESP") { aforoRes = null; $("res-aforo").innerHTML = tarjeta("Diseño especial", "T. máx pavimento > 76 °C — aprobación de la Secretaría", "", ""); return; }
    const mx = mezcla(), suma = sumaPct();
    const tdpa = +$("tdpa").value;
    if (!(tdpa > 0)) { if (!auto) alert("El TDPA debe ser mayor que cero."); return; }
    const comun = { tdpaDir: PG.tdpaSentido(tdpa, $("sc").value), mezcla: mx, tasa: (+$("tasa").value) / 100, anios: +$("anios").value, carriles: +$("carriles").value };
    const Lu = PG.esal({ ...comun, factores: PG.FD_UNAM });
    const vel = +$("vel").value, nu = PG.nivelAjuste(Lu, vel);
    const pg = (l) => `PG ${estudio.ga}${l}-${Math.abs(estudio.gb)}`;
    aforoRes = { Lu, nu, gob: nu, vel, tdpa, sc: $("sc").value, anios: +$("anios").value, tasa: +$("tasa").value, carriles: +$("carriles").value, mezcla: mx, pgU: pg(nu), pgGob: pg(nu), fuente: aforoFuente ? { ...aforoFuente } : { tipo: "manual" } };
    $("res-aforo").innerHTML = tarjeta(pg(nu), "PG seleccionado · nivel " + PG.NIVELES[nu], `
      <tr><td>PG base (temperatura)</td><td>PG ${estudio.ga}-${Math.abs(estudio.gb)}</td></tr>
      <tr class="sep"><td><b>∑L (Inst. Ing. UNAM, ${aforoRes.anios} años)</b></td><td><b>${(Lu / 1e6).toFixed(2)} × 10⁶</b></td></tr>
      <tr><td>Nivel de ajuste</td><td>${PG.NIVELES[nu]}</td></tr>
      <tr class="sep"><td>Región (tasa) · velocidad</td><td>${estudio.rg || "—"} (${aforoRes.tasa.toFixed(1)} %) · ${vel} km/h</td></tr>
      <tr><td>Suma de porcentajes</td><td>${suma.toFixed(0)} %${Math.abs(suma - 100) > 1 ? " ⚠" : ""}</td></tr>`,
      "∑L por el método del Instituto de Ingeniería UNAM (daño superficial 6.0 kg/cm²); PG por M·MMP·4·05·064/22.");
    prepararDiseno();   // captura única: sincroniza longitud y método del paso ④
  }

  /* =============== ④ Mezcla y cantidades =============== */
  const NOM = [9.5, 12.5, 19, 25, 37.5];               // tamaños nominales estándar (mm)
  const nominalMax = (espCm) => { const lim = espCm * 10 / 3; let m = NOM[0]; for (const n of NOM) if (n <= lim) m = n; return m; }; // regla: espesor >= 3x nominal
  function tipoCapa(espCm) {
    if (espCm > 5) return { clase: "densa", nombre: "Carpeta de granulometría densa (estructural)", disc: false };
    if (espCm >= 3) return { clase: "discontinua", nombre: "Capa de rodadura discontinua (no estructural)", disc: true };
    return { clase: "delgada", nombre: "Espesor < 3 cm (tratamiento superficial: riego / microaglomerado)", disc: false };
  }
  function longitudEstudio() {
    if (estudio && estudio.segmento) {
      const g = estudio.segmento;
      if (g.coords) { const dl = g.p2[0] - g.p1[0], dn = (g.p2[1] - g.p1[1]) * Math.cos(g.p1[0] * Math.PI / 180); return Math.round(Math.hypot(dl, dn) * 111000); }
      return Math.round((g.cf - g.ci) * 1000);
    }
    const t = tramoActual; if (t) { const r = rangoCad(t.cp); if (r) return Math.round((r.fin - r.ini) * 1000); }
    return "";
  }
  // Longitud (m) a partir del cadenamiento inicial y final (modo carretera)
  function longitudDeCadenamiento() {
    if (modoUbicacion() !== "carretera") return null;
    const ci = parseCad($("cad-ini") ? $("cad-ini").value : ""), cf = parseCad($("cad-fin") ? $("cad-fin").value : "");
    if (ci != null && cf != null && cf - ci > 1e-6) return Math.round((cf - ci) * 1000);
    return null;
  }
  function actualizarLongitud() { const L = longitudDeCadenamiento(); if (L != null && $("d-long")) $("d-long").value = L; }
  // Tiers de RAP por relación de asfalto reemplazado (AASHTO M323 / AI MS-2)
  function tierRAP(brr) {
    if (brr < 15) return { n: 1, ajuste: "Sin cambio del grado del ligante virgen." };
    if (brr <= 25) return { n: 2, ajuste: "Ligante virgen UN grado más blando en ambos extremos." };
    return { n: 3, ajuste: "Carta de mezclado (blending chart) + rejuvenecedor; RAP a caracterizar en laboratorio." };
  }
  $("d-agg") && $("d-agg").addEventListener("change", () => { const c = $("d-rap-cont"); if (c) c.classList.toggle("oculto", $("d-agg").value !== "rap"); });
  function actualizarTipo() {
    const esp = +$("d-esp").value || 0, tc = tipoCapa(esp), cont = $("d-tipo-cont"), mc = $("d-metodo-cont");
    if (cont) cont.classList.toggle("oculto", !tc.disc);           // SMA/CASAA solo en discontinua
    if (mc) mc.classList.toggle("oculto", tc.disc);                // el método Marshall/Desempeño no aplica a discontinua
    const sumaL = aforoRes ? aforoRes.Lu : 0, sel = $("d-metodo");
    if (sel && !tc.disc) { if (sumaL > 1e7) { sel.value = "Desempeño"; [...sel.options].forEach((o) => { if (o.value === "Marshall") o.disabled = true; }); } else [...sel.options].forEach((o) => (o.disabled = false)); }
  }
  function prepararDiseno() {
    const L = longitudEstudio(); if ($("d-long") && !$("d-long").value && L) $("d-long").value = L;
    actualizarTipo();
  }
  function calcularDiseno() {
    if (!aforoRes) { alert("Primero calcula el aforo (∑L) en la pestaña ③."); mostrarPanel("aforo"); return; }
    const esp = +$("d-esp").value, ancho = +$("d-ancho").value, largo = +$("d-long").value, ca = +$("d-ca").value, dens = +$("d-dens").value, abund = +$("d-abund").value || 1.2, densPet = +$("d-denspet").value || 2.65;
    if (!(esp > 0 && ancho > 0 && largo > 0 && ca > 0 && dens > 0)) { alert("Captura espesor, ancho, longitud, % CA y densidad válidos."); return; }
    const sumaL = aforoRes.Lu, tc = tipoCapa(esp), nom = nominalMax(esp);
    let metodo = $("d-metodo").value, forzado = false;
    if (!tc.disc && sumaL > 1e7) { metodo = "Desempeño"; forzado = true; }
    const tipoMezcla = tc.disc ? $("d-tipo").value : "densa";
    const metodoTxt = tc.disc ? (tipoMezcla === "SMA" ? "SMA · M·MMP·4·05·043" : "CASAA · M·MMP·4·05·056") : (metodo + (forzado ? " (obligado)" : ""));
    const V = ancho * largo * (esp / 100), tonMezcla = V * dens, tonCA = tonMezcla * (ca / 100), espSuelto = esp * abund;
    const tonPetreo = tonMezcla - tonCA, volPetreo = tonPetreo / densPet;   // material pétreo: masa (t) y volumen de banco (m³)
    // RAP (Paso 2): reemplazo de ligante y toneladas de asfalto virgen
    let rap = null;
    if ($("d-agg") && $("d-agg").value === "rap") {
      const pRap = +$("d-rap").value || 0, rapCA = +$("d-rapca").value || 0;
      const tonRAPmat = tonMezcla * pRap / 100, tonRAPac = tonRAPmat * rapCA / 100;
      const tonVirgAC = Math.max(0, tonCA - tonRAPac), brr = tonCA > 0 ? tonRAPac / tonCA * 100 : 0;
      const tr = tierRAP(brr);
      const virgenPG = (tr.n === 2 && typeof estudio.ga === "number") ? "PG " + (estudio.ga - 6) + "-" + Math.abs(estudio.gb - 6) : null;
      rap = { pRap, rapCA, tonRAPmat, tonRAPac, tonVirgAC, brr, tier: tr, virgenPG, rga: +$("d-rap-ga").value || null, rgb: +$("d-rap-gb").value || null };
    }
    // ∑L estructural a la profundidad de la capa (II-UNAM, p=6.0) — NO es la letra del PG
    const fdz = fdProfundidad(esp);
    const Lestr = (fdz && aforoRes) ? PG.esal({ tdpaDir: PG.tdpaSentido(aforoRes.tdpa, aforoRes.sc), mezcla: aforoRes.mezcla, factores: fdz, tasa: aforoRes.tasa / 100, anios: aforoRes.anios, carriles: aforoRes.carriles }) : null;
    diseno = { esp, ancho, largo, ca, dens, abund, densPet, tonPetreo, volPetreo, V, tonMezcla, tonCA, espSuelto, tipo: tc, nom, metodo, forzado, tipoMezcla, sumaL, rap, Lestr };
    if (forzado) alert("∑L = " + (sumaL / 1e6).toFixed(1) + " ×10⁶ (> 10 millones): por la Norma N·CMT·4·05·003 (Tabla 1, nota 5) el diseño DEBE ser por MÉTODO DE DESEMPEÑO. Se desactivó la opción Marshall.");
    const etqTipo = tc.clase === "densa" ? "Densa estructural" : (tc.clase === "discontinua" ? tipoMezcla + " (rodadura, no estructural)" : "Delgada");
    const filasRap = rap ? `
      <tr class="sep"><td><b>RAP ${rap.pRap}% · reemplazo de ligante</b></td><td><b>${rap.brr.toFixed(0)} %</b></td></tr>
      <tr><td>Criterio (AASHTO M323)</td><td>Tier ${rap.tier.n} — ${rap.tier.ajuste}</td></tr>
      ${rap.virgenPG ? `<tr><td>Ligante virgen sugerido</td><td>${rap.virgenPG}</td></tr>` : ""}
      <tr><td><b>CA virgen (a comprar)</b> / CA del RAP</td><td><b>${rap.tonVirgAC.toFixed(1)}</b> / ${rap.tonRAPac.toFixed(1)} t</td></tr>` : "";
    $("res-diseno").innerHTML = tarjeta((rap ? rap.tonVirgAC.toFixed(1) + " t CA virgen" : tonCA.toFixed(1) + " t de CA"), etqTipo + " · " + metodoTxt, `
      <tr><td>Tipo de capa · tamaño nominal máx.</td><td>${etqTipo} · ${nom} mm</td></tr>
      <tr><td>Volumen compactado (${ancho}×${largo}×${esp}cm)</td><td>${V.toFixed(1)} m³</td></tr>
      <tr><td>Mezcla asfáltica</td><td>${tonMezcla.toFixed(1)} t</td></tr>
      <tr class="sep"><td><b>Cemento asfáltico total (${ca}%)</b></td><td><b>${tonCA.toFixed(1)} t</b></td></tr>
      <tr><td>Material pétreo (masa · volumen de banco)</td><td>${tonPetreo.toFixed(1)} t · ${volPetreo.toFixed(1)} m³</td></tr>
      <tr><td>Espesor suelto estimado (calibrar en tramo de prueba)</td><td>${espSuelto.toFixed(1)} cm</td></tr>
      <tr class="sep"><td>Método de diseño</td><td>${metodo}${forzado ? " — obligado (∑L>10⁷)" : ""}</td></tr>
      ${Lestr != null ? `<tr><td>Ejes equivalentes calculados a ${esp} cm (II-UNAM, ${aforoRes.anios} años)</td><td>${(Lestr / 1e6).toFixed(2)} × 10⁶</td></tr>` : ""}${filasRap}`,
      "Valores objetivo de control = los del DISEÑO aprobado, NO los umbrales de la NIT. El abundamiento solo define el espesor suelto (la masa se conserva)." + (rap ? " Con RAP, el asfalto a COMPRAR es el virgen; el RAP aporta el suyo. Estimación preliminar: caracterizar el RAP en laboratorio." : "") + " El PDF incluye requisitos y recomendaciones.");
  }
  $("d-esp") && $("d-esp").addEventListener("input", actualizarTipo);

  // Plantilla de tarjeta de resultado (con botón PDF)
  function tarjeta(pgTxt, subtitulo, filas, nota) {
    return `<div class="resultado">
      <div class="pg-grande">${pgTxt}</div>
      ${subtitulo ? `<div class="pg-ajuste">${subtitulo}</div>` : ""}
      ${filas ? `<table class="kv">${filas}</table>` : ""}
      ${nota ? `<p class="nota">${nota}</p>` : ""}
    </div>`;
  }

  /* =============== Captura del mapa para el PDF =============== */
  function capturarMapa(cb) {
    if (!window.html2canvas) { cb(null); return; }
    try { mapa.invalidateSize(); } catch (e) {}
    // Oculta controles interactivos (zoom y selector de capas) en la captura; deja logo, escala y norte
    const ocultar = (el) => el && el.classList && (el.classList.contains("leaflet-control-zoom") || el.classList.contains("leaflet-control-layers"));
    setTimeout(function () {
      try {
        window.html2canvas(document.getElementById("mapa"), { useCORS: true, allowTaint: false, backgroundColor: "#ffffff", logging: false, scale: 2, ignoreElements: ocultar })
          .then((cv) => cb(cv)).catch(() => cb(null));
      } catch (e) { cb(null); }
    }, 350);
  }

  /* =============== Número de reporte, integridad (hash) y QR =============== */
  function consecutivo() { let n = 1; try { n = (parseInt(localStorage.getItem("hga_consec") || "0", 10) || 0) + 1; localStorage.setItem("hga_consec", String(n)); } catch (e) {} return String(n).padStart(5, "0"); }
  async function sha256Hex(str) { try { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""); } catch (e) { return ""; } }
  function qrDataURL(texto) {
    if (typeof QRCode === "undefined") return null;
    try {
      const cont = document.createElement("div");
      new QRCode(cont, { text: texto, width: 240, height: 240, correctLevel: QRCode.CorrectLevel.M });
      const cv = cont.querySelector("canvas"); if (cv) return cv.toDataURL("image/png");
      const img = cont.querySelector("img"); return img ? img.src : null;
    } catch (e) { return null; }
  }
  const leerMeta = () => ({ proy: (($("m-proy") || {}).value || "").trim(), unidad: (($("m-unidad") || {}).value || "").trim(), dirigido: (($("m-dirigido") || {}).value || "").trim(), resp: (($("m-resp") || {}).value || "").trim() });
  const b64e = (s) => btoa(unescape(encodeURIComponent(s)));

  /* =============== Reporte PDF =============== */
  function generarPDF() {
    if (!estudio) { alert("Realiza primero un cálculo (punto o carretera)."); return; }
    if (!window.jspdf) { alert("No se pudo cargar la librería de PDF (revisa la conexión a internet)."); return; }
    // El reporte incluye el ajuste por intensidad vehicular (salvo diseño especial > 76 °C).
    // Se precarga de Datos Viales 2024; antes de imprimir se avisa y se ofrece cargar un aforo más reciente.
    if (estudio.ga !== "ESP") {
      if (!aforoRes) precargarAforo(estudio.carretera && estudio.carretera.car);
      if (!aforoRes) {
        alert("No se encontró aforo para el AJUSTE POR INTENSIDAD VEHICULAR.\n\nCaptura el aforo en la pestaña ③ y presiona «Calcular ESAL y PG final».");
        mostrarPanel("aforo"); return;
      }
      const f = aforoRes.fuente || {};
      let msg;
      if (f.tipo === "DV2024") {
        msg = "El AJUSTE POR INTENSIDAD VEHICULAR se calculó con la Base de Datos Viales 2024 (DV2024).\n"
            + "Estación de aforo: " + f.est + (f.dist != null ? " — " + f.dist.toFixed(0) + " km" : "")
            + (f.misma ? " (misma carretera)" : " (carretera más cercana)") + ".\n\n"
            + "¿Deseas cargar un aforo MÁS RECIENTE? Presiona «Cancelar» para capturarlo en la pestaña ③.\n\n"
            + "«Aceptar» = generar el PDF con los Datos Viales 2024.";
      } else {
        msg = "El ajuste por intensidad vehicular usa el aforo capturado manualmente.\n\n¿Generar el PDF?";
      }
      if (!confirm(msg)) { mostrarPanel("aforo"); return; }
    }
    const btnPDF = document.activeElement;
    if (btnPDF && btnPDF.tagName === "BUTTON") { btnPDF.disabled = true; btnPDF.textContent = "Generando PDF…"; }
    const meta = leerMeta(), now = new Date();
    const yy = String(now.getFullYear()).slice(2), mm = String(now.getMonth() + 1).padStart(2, "0"), dd = String(now.getDate()).padStart(2, "0");
    const grado = (typeof estudio.ga === "number") ? ("" + estudio.ga + Math.abs(estudio.gb)) : "ESP";
    const numRep = yy + mm + dd + "-" + grado + "-" + consecutivo(), fechaStr = now.toLocaleString("es-MX");
    const dbx = ((($("m-dropbox") || {}).value) || "").trim(), fname = "Reporte_" + numRep + ".pdf";
    const canon = [numRep, now.toISOString(), meta.proy, meta.unidad, estudio.carretera ? estudio.carretera.cp : "", estudio.lat.toFixed(5), estudio.lon.toFixed(5),
      PG.pgTexto(estudio.ga, estudio.gb), aforoRes ? aforoRes.pgGob + "|" + (aforoRes.Lu || 0).toFixed(0) : "",
      diseno ? diseno.tonMezcla.toFixed(2) + "|" + diseno.tonCA.toFixed(2) + "|" + diseno.tonPetreo.toFixed(2) : ""].join("~");
    capturarMapa(function (cv) {
      sha256Hex(canon).then(function (hash) {
        const sello = hash ? hash.slice(0, 16).toUpperCase() : "";
        const c = estudio.carretera;
        const pl = {
          r: numRep, f: fechaStr, h: hash, c: canon,
          proy: meta.proy, uni: meta.unidad, dir: meta.dirigido, resp: meta.resp,
          car: c ? c.car : "", tr: c ? c.tr : "", cp: c ? c.cp : "", dg: c ? c.dg : "",
          edo: c ? edoDe(c.cp) : "", red: c ? c.gr : "",
          lat: +estudio.lat.toFixed(4), lon: +estudio.lon.toFixed(4),
          pg: PG.pgTexto(estudio.ga, estudio.gb),
          pgg: aforoRes ? aforoRes.pgGob : "", niv: aforoRes ? PG.NIVELES[aforoRes.gob] : "",
          L: aforoRes ? +(aforoRes.Lu / 1e6).toFixed(2) : null, vel: aforoRes ? aforoRes.vel : null,
          tdpa: aforoRes ? aforoRes.tdpa : "", sc: aforoRes ? aforoRes.sc : "",
          d: diseno ? { esp: diseno.esp, anc: diseno.ancho, lar: diseno.largo, ca: diseno.ca, tipo: diseno.tipo.clase, met: diseno.metodo, tonM: +diseno.tonMezcla.toFixed(1), tonCA: +diseno.tonCA.toFixed(1), tonP: +diseno.tonPetreo.toFixed(1), Lestr: diseno.Lestr != null ? +(diseno.Lestr / 1e6).toFixed(2) : null } : null,
        };
        const b64 = b64e(JSON.stringify(pl));
        const validador = ((($("m-validador") || {}).value) || "").trim();
        let url, modo;
        if (CARPETA_REPORTES_URL) { url = CARPETA_REPORTES_URL; modo = "carpeta"; }
        else if (validador) { url = validador + "#" + b64; modo = "validador"; }
        else if (dbx) { url = dbx + (dbx.includes("?") ? "&" : "?") + "preview=" + encodeURIComponent(fname); modo = "dropbox"; }
        else { url = VALIDADOR_URL + "#" + b64; modo = "sict"; }
        const qr = qrDataURL(url);
        try { construirPDF(cv, { meta, numRep, fechaStr, hash, sello, qr, url, fname, dbx, modo }); }
        finally { if (btnPDF && btnPDF.tagName === "BUTTON") { btnPDF.disabled = false; btnPDF.textContent = "⭳ Descargar PDF del cálculo"; } }
      });
    });
  }

  function construirPDF(cv, ex) {
    const { jsPDF } = window.jspdf, doc = new jsPDF({ unit: "mm", format: "letter" });
    const G = [97, 18, 50], V = [30, 91, 79], GR = [120, 120, 122], TN = [45, 45, 45];
    const Wd = 216, mx = 14;
    const asc = (s) => String(s)
      .replace(/≥/g, ">=").replace(/≤/g, "<=").replace(/∑/g, "S").replace(/×/g, "x")
      .replace(/σ/g, "D.E.").replace(/Σ/g, "Suma")
      .replace(/→/g, "->").replace(/←/g, "<-").replace(/–/g, "-").replace(/—/g, "-")
      .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (d) => "^" + "⁰¹²³⁴⁵⁶⁷⁸⁹".indexOf(d));
    const setC = (col) => doc.setTextColor(col[0], col[1], col[2]);
    const head = (x, y2, w, t) => { doc.setFont(undefined, "bold"); doc.setFontSize(9.3); setC(V); doc.text(asc(t), x, y2); doc.setDrawColor(...V); doc.setLineWidth(0.35); doc.line(x, y2 + 1.5, x + w, y2 + 1.5); doc.setFont(undefined, "normal"); };
    const kv = (x, y2, w, k, v) => { doc.setFont(undefined, "normal"); doc.setFontSize(8); setC(GR); doc.text(asc(k), x, y2); doc.setFont(undefined, "bold"); setC(TN); doc.text(asc(v), x + w, y2, { align: "right" }); doc.setFont(undefined, "normal"); };
    const campo = (x, y2, w, k, v) => { doc.setFont(undefined, "normal"); doc.setFontSize(6.9); setC(GR); doc.text(asc(k), x, y2); doc.setFontSize(8.6); setC(TN); doc.setFont(undefined, "bold"); const ls = doc.splitTextToSize(asc(v), w); doc.text(ls, x, y2 + 3.3); doc.setFont(undefined, "normal"); return y2 + 3.3 + ls.length * 3.5 + 1.8; };

    // Encabezado
    doc.setFillColor(...G); doc.rect(0, 0, Wd * 0.6, 3.5, "F"); doc.setFillColor(...V); doc.rect(Wd * 0.6, 0, Wd * 0.4, 3.5, "F");
    if (window.LOGO) { try { doc.addImage(window.LOGO, "PNG", Wd - mx - 40, 7, 40, 6.8); } catch (e) {} }
    setC(GR); doc.setFontSize(8); doc.setFont(undefined, "normal");
    doc.text("SECRETARÍA DE INFRAESTRUCTURA, COMUNICACIONES Y TRANSPORTES", mx, 11);
    doc.text("Dirección General de Servicios Técnicos", mx, 15);
    setC(G); doc.setFontSize(13); doc.setFont(undefined, "bold");
    doc.text("HG Asfáltica DGST", mx, 22);
    setC(GR); doc.setFontSize(7.5); doc.setFont(undefined, "normal");
    doc.text(asc("Herramienta Guía Asfáltica — selección de cemento asfáltico, material pétreo y tipo de mezcla asfáltica"), mx, 26);
    doc.text("Reporte " + (ex && ex.numRep ? ex.numRep : "") + "     ·     " + (ex && ex.fechaStr ? ex.fechaStr : new Date().toLocaleString("es-MX")), mx, 29.7);
    doc.setDrawColor(...V); doc.setLineWidth(0.5); doc.line(mx, 31.5, Wd - mx, 31.5);

    const c = estudio.carretera;
    let yTop = 35;
    if (ex && ex.meta && (ex.meta.proy || ex.meta.unidad || ex.meta.dirigido)) {
      setC(GR); doc.setFontSize(7.5); doc.setFont(undefined, "normal");
      const ml = [ex.meta.proy ? "Proyecto: " + ex.meta.proy : "", ex.meta.unidad ? "Unidad: " + ex.meta.unidad : "", ex.meta.dirigido ? "Dirigido a: " + ex.meta.dirigido : ""].filter(Boolean).join("     ·     ");
      doc.text(asc(ml.length > 150 ? ml.slice(0, 150) + "…" : ml), mx, 34.5); yTop = 38;
    }
    const colGap = 7, mapW = 88, mapX = mx, rX = mx + mapW + colGap, rW = Wd - mx - rX;

    // Columna izquierda: mapa
    head(mapX, yTop, mapW, "Ubicación y selección");
    let mapH = 0;
    if (cv && cv.width) {
      mapH = Math.min(86, mapW * cv.height / cv.width);
      try { doc.addImage(cv.toDataURL("image/jpeg", 0.9), "JPEG", mapX, yTop + 3.5, mapW, mapH); doc.setDrawColor(...GR); doc.setLineWidth(0.2); doc.rect(mapX, yTop + 3.5, mapW, mapH); } catch (e) { mapH = 0; }
    }
    const mapBot = yTop + 3.5 + mapH;

    // Columna derecha: punto de estudio (apilado)
    head(rX, yTop, rW, "Punto de estudio");
    let ry = yTop + 7;
    if (c) {
      ry = campo(rX, ry, rW, "Carretera", c.car || "—");
      ry = campo(rX, ry, rW, "Tramo", c.tr || "—");
      ry = campo(rX, ry, rW, "Clave PARCF / DGCC", c.cp + " / " + (c.dg || "—"));
      ry = campo(rX, ry, rW, "Estado / Red", (edoDe(c.cp) || "—") + " · " + c.gr);
    }
    ry = campo(rX, ry, rW, "Coordenadas (lat, lon)", estudio.lat.toFixed(4) + ", " + estudio.lon.toFixed(4));
    ry = campo(rX, ry, rW, "Región / crecimiento", (estudio.rg || "—") + (TASAS[estudio.rg] != null ? " · " + (TASAS[estudio.rg] * 100).toFixed(1) + " %" : ""));
    ry = campo(rX, ry, rW, "Estación clima (más cercana)", estudio.estNom + " (" + estudio.estDist.toFixed(0) + " km)");
    doc.setFillColor(244, 238, 241); doc.roundedRect(rX, ry, rW, 8.5, 1.5, 1.5, "F");
    setC(G); doc.setFont(undefined, "bold"); doc.setFontSize(9.5); doc.text(asc("PG por temperatura:  " + PG.pgTexto(estudio.ga, estudio.gb)), rX + 3, ry + 5.6); doc.setFont(undefined, "normal");
    ry += 12;

    let y = Math.max(mapBot, ry) + 5;
    const cw = (Wd - 2 * mx - colGap) / 2, xL = mx, xR = mx + cw + colGap;

    // Temperaturas (dos columnas)
    head(xL, y, Wd - 2 * mx, "Temperaturas (M·MMP·4·05·064/22, H = 20 mm, 98 %)"); y += 6;
    kv(xL, y, cw, "T. aire máx 7 d / D.E.", estudio.TM + " / " + estudio.sM + " °C");
    kv(xR, y, cw, "T. máx pavimento", estudio.tx.toFixed(1) + " °C"); y += 5;
    kv(xL, y, cw, "T. aire mín / D.E.", estudio.Tm + " / " + estudio.sm + " °C");
    kv(xR, y, cw, "T. mín pavimento", estudio.tn.toFixed(1) + " °C"); y += 6.5;

    // Segmento (si aplica)
    if (estudio.segmento) {
      const g = estudio.segmento;
      if (g.coords) {
        head(xL, y, Wd - 2 * mx, "Segmento por coordenadas (dos extremos)"); y += 6;
        kv(xL, y, cw, "Inicio (lat, lon)", g.p1[0].toFixed(4) + ", " + g.p1[1].toFixed(4));
        kv(xR, y, cw, "PG que rige", PG.pgTexto(estudio.ga, estudio.gb)); y += 5;
        kv(xL, y, cw, "Inicio: PG · T", PG.pgTexto(g.e1.ga, g.e1.gb) + " · " + g.e1.tx.toFixed(1) + "/" + g.e1.tn.toFixed(1) + " C");
        kv(xR, y, cw, "Fin (lat, lon)", g.p2[0].toFixed(4) + ", " + g.p2[1].toFixed(4)); y += 5;
        kv(xL, y, cw, "Fin: PG · T", PG.pgTexto(g.e2.ga, g.e2.gb) + " · " + g.e2.tx.toFixed(1) + "/" + g.e2.tn.toFixed(1) + " C"); y += 6.5;
      } else {
        head(xL, y, Wd - 2 * mx, "Segmento en estudio (cadenamiento, dos extremos)"); y += 6;
        kv(xL, y, cw, "Cadenamiento", fmtCad(g.ci) + " a " + fmtCad(g.cf) + " (" + (g.cf - g.ci).toFixed(1) + " km)");
        kv(xR, y, cw, "PG que rige", PG.pgTexto(estudio.ga, estudio.gb)); y += 5;
        kv(xL, y, cw, "Ext. " + fmtCad(g.ci), PG.pgTexto(g.e1.ga, g.e1.gb) + " · " + g.e1.tx.toFixed(1) + "/" + g.e1.tn.toFixed(1) + " C");
        kv(xR, y, cw, "Ext. " + fmtCad(g.cf), PG.pgTexto(g.e2.ga, g.e2.gb) + " · " + g.e2.tx.toFixed(1) + "/" + g.e2.tn.toFixed(1) + " C"); y += 6.5;
      }
    }

    // Tránsito y ejes equivalentes
    if (aforoRes) {
      const a = aforoRes, fu = a.fuente || {};
      head(xL, y, Wd - 2 * mx, "Tránsito y ejes equivalentes (∑L, " + a.anios + " años)"); y += 6;
      doc.setFontSize(8); setC(GR); doc.setFont(undefined, "normal"); doc.text(asc("Fuente del aforo:"), xL, y);
      setC(TN); doc.setFont(undefined, "bold"); doc.text(asc(fu.tipo === "DV2024" ? ("Datos Viales 2024 · " + (fu.est || "") + (fu.dist != null ? " (" + fu.dist.toFixed(0) + " km)" : "")) : "Captura manual"), xL + 24, y); doc.setFont(undefined, "normal"); y += 5;
      kv(xL, y, cw, "TDPA (SC " + a.sc + ")", a.tdpa.toLocaleString("es-MX"));
      kv(xR, y, cw, "Carriles · vel* · crec", a.carriles + " · " + a.vel + " km/h · " + a.tasa.toFixed(1) + " %"); y += 5;
      kv(xL, y, cw, "Comp. C2/C3/T3S2/T3S3/T3S2R4", a.mezcla.c2 + "/" + a.mezcla.c3 + "/" + a.mezcla.t3s2 + "/" + a.mezcla.t3s3 + "/" + a.mezcla.t3s2r4 + " %");
      kv(xR, y, cw, "∑L UNAM (Inst. Ing.)", (a.Lu / 1e6).toFixed(2) + " x10^6 -> " + a.pgU); y += 5;
      kv(xL, y, cw, "Nivel de ajuste", PG.NIVELES[a.gob]); y += 7;
      doc.setFillColor(245, 240, 235); doc.roundedRect(mx, y - 3, Wd - 2 * mx, 15, 2, 2, "F");
      setC(G); doc.setFontSize(16); doc.setFont(undefined, "bold"); doc.text(asc("PG SELECCIONADO:  " + a.pgGob), mx + 5, y + 6.5);
      doc.setFontSize(9); doc.setFont(undefined, "normal"); setC(V); doc.text(asc("Nivel " + PG.NIVELES[a.gob]), Wd - mx - 5, y + 6.5, { align: "right" }); y += 16;
    } else {
      doc.setFillColor(245, 240, 235); doc.roundedRect(mx, y - 3, Wd - 2 * mx, 12, 2, 2, "F");
      setC(G); doc.setFontSize(13); doc.setFont(undefined, "bold"); doc.text(asc("DISEÑO ESPECIAL — PG (temperatura):  " + PG.pgTexto(estudio.ga, estudio.gb)), mx + 5, y + 5); doc.setFont(undefined, "normal"); y += 14;
    }
    // ===== Página 2: requisitos de calidad, cantidades y recomendaciones =====
    if (aforoRes) {
      doc.addPage();
      doc.setFillColor(...G); doc.rect(0, 0, Wd * 0.6, 3.5, "F"); doc.setFillColor(...V); doc.rect(Wd * 0.6, 0, Wd * 0.4, 3.5, "F");
      setC(G); doc.setFontSize(12); doc.setFont(undefined, "bold"); doc.text(asc("Requisitos de calidad, cantidades y recomendaciones"), mx, 14); doc.setFont(undefined, "normal");
      let p = 22, cwd = Wd - 2 * mx;
      const nlp = (h) => { if (p + h > 250) { doc.addPage(); p = 20; } };
      const linkN = (x, y, t, u) => { setC([40, 80, 160]); doc.setFontSize(7.4); doc.setFont(undefined, "normal"); try { doc.textWithLink(asc(t), x, y, { url: u }); } catch (e) { doc.text(asc(t), x, y); } setC(TN); };
      const NORMA = { ca: "https://normas.imt.mx/storage/normativa/N-CMT-4-05-004-25.pdf", mez: "https://normas.imt.mx/storage/normativa/N-CMT-4-05-003-25.pdf", pet: "https://normas.imt.mx/storage/normativa/N-CMT-4-04-17.pdf" };
      // Datos del reporte y validación (QR + sello de integridad)
      if (ex) {
        head(mx, p, cwd, "Datos del reporte y validación"); p += 6;
        const qs = 30, qy = p - 4;
        if (ex.qr) { try { doc.addImage(ex.qr, "PNG", Wd - mx - qs, qy, qs, qs); doc.setDrawColor(...GR); doc.setLineWidth(0.2); doc.rect(Wd - mx - qs, qy, qs, qs); } catch (e) {} }
        const wt = cwd - qs - 6;
        kv(mx, p, wt, "Número de reporte", ex.numRep); p += 4.6;
        kv(mx, p, wt, "Fecha y hora de generación", ex.fechaStr); p += 4.6;
        if (ex.meta.proy) { kv(mx, p, wt, "Proyecto", ex.meta.proy); p += 4.6; }
        if (ex.meta.unidad) { kv(mx, p, wt, "Unidad responsable", ex.meta.unidad); p += 4.6; }
        if (ex.meta.dirigido) { kv(mx, p, wt, "Dirigido a", ex.meta.dirigido); p += 4.6; }
        if (ex.meta.resp) { kv(mx, p, wt, "Elaboró / responsable técnico", ex.meta.resp); p += 4.6; }
        kv(mx, p, wt, "Sello de integridad (SHA-256)", ex.sello); p += 4.6;
        if (p < qy + qs + 2) p = qy + qs + 2;
        doc.setFontSize(7); setC(GR); doc.setFont(undefined, "normal");
        const nota = (ex.modo === "validador"
          ? "Escanee el QR para ABRIR Y VALIDAR el reporte: la página muestra los datos y confirma que el sello coincide. "
          : ex.modo === "carpeta"
          ? "Guarde este PDF en la carpeta de reportes (OneDrive/Dropbox/Drive) con el nombre «" + ex.fname + "». El QR abre esa carpeta para localizar y consultar el reporte por su número. "
          : ex.modo === "dropbox"
          ? "Guarde este PDF en la carpeta Dropbox de reportes con el nombre «" + ex.fname + "». El QR abre ese mismo reporte para corroborar. "
          : "Escanee el QR para ver y validar el reporte. ")
          + "El sello de integridad permite verificar que el cálculo del PDF no fue alterado: si el contenido cambia, el sello no coincidirá.";
        const ls = doc.splitTextToSize(asc(nota), cwd); doc.text(ls, mx, p); p += ls.length * 3.1 + 3;
      }
      // Resumen de parámetros del cálculo (datos capturados) — para el supervisor del proyecto
      nlp(48);
      head(mx, p, cwd, "Resumen de parámetros del cálculo (datos capturados)"); p += 5.5;
      const cw2 = (cwd - 6) / 2, xa = mx, xb = mx + cw2 + 6;
      const modoTxt = estudio.carretera ? "Carretera (Anexo A)" : (estudio.segmento && estudio.segmento.coords ? "Segmento por coordenadas" : "Punto por coordenadas");
      kv(xa, p, cw2, "Modo de ubicación", modoTxt);
      kv(xb, p, cw2, "Coordenadas (lat, lon)", estudio.lat.toFixed(4) + ", " + estudio.lon.toFixed(4)); p += 4.6;
      if (estudio.carretera) { const cc = estudio.carretera; kv(xa, p, cw2, "Carretera / clave", (cc.car || "-") + " / " + cc.cp); kv(xb, p, cw2, "Estado / Red", (edoDe(cc.cp) || "-") + " · " + (cc.gr || "-")); p += 4.6; }
      if (estudio.segmento) { const g = estudio.segmento; kv(xa, p, cw2, "Segmento", g.coords ? "coordenadas inicio/fin" : (fmtCad(g.ci) + " a " + fmtCad(g.cf))); kv(xb, p, cw2, "PG por temperatura", PG.pgTexto(estudio.ga, estudio.gb)); p += 4.6; }
      kv(xa, p, cw2, "Estación clima (SMN)", estudio.estNom + " (" + estudio.estDist.toFixed(0) + " km)");
      kv(xb, p, cw2, "T. máx / mín pavimento", estudio.tx.toFixed(1) + " / " + estudio.tn.toFixed(1) + " °C"); p += 4.6;
      if (aforoRes) {
        const a = aforoRes, fu = a.fuente || {}, m = a.mezcla || {};
        kv(xa, p, cw2, "Fuente del aforo", fu.tipo === "DV2024" ? ("Datos Viales 2024 · " + (fu.est || "")) : "Captura manual");
        kv(xb, p, cw2, "TDPA · SC", a.tdpa.toLocaleString("es-MX") + " · SC " + a.sc); p += 4.6;
        kv(xa, p, cw2, "Carriles · velocidad · periodo", a.carriles + " · " + a.vel + " km/h · " + a.anios + " años");
        kv(xb, p, cw2, "Tasa de crecimiento", a.tasa.toFixed(1) + " %"); p += 4.6;
        kv(mx, p, cwd, "Composición A/B/C2/C3/T3S2/T3S3/T3S2R4/Otros, %", [m.a, m.b, m.c2, m.c3, m.t3s2, m.t3s3, m.t3s2r4, m.otros].join(" / ")); p += 4.6;
        kv(xa, p, cw2, "∑L (Inst. Ing. UNAM)", (a.Lu / 1e6).toFixed(2) + " x10^6");
        kv(xb, p, cw2, "Nivel de ajuste (letra)", PG.NIVELES[a.gob] + " -> " + a.pgGob); p += 4.6;
      }
      if (diseno) {
        const d = diseno;
        const tipoTxt = d.tipo.clase === "densa" ? ("Densa · " + d.metodo) : (d.tipo.clase === "discontinua" ? (d.tipoMezcla + " (rodadura)") : "Delgada");
        kv(xa, p, cw2, "Tipo de mezcla / método", tipoTxt);
        kv(xb, p, cw2, "Agregado", d.rap ? ("Con RAP " + d.rap.pRap + "% (asf. RAP " + d.rap.rapCA + "%)") : "100% virgen"); p += 4.6;
        kv(xa, p, cw2, "Espesor · ancho · longitud", d.esp + " cm · " + d.ancho + " m · " + d.largo + " m");
        kv(xb, p, cw2, "% CA · dens. mezcla · dens. pétreo", d.ca + " % · " + d.dens + " · " + d.densPet + " t/m³"); p += 4.6;
      }
      p += 3;
      // Requisitos del cemento asfáltico SOLO del PG seleccionado — N·CMT·4·05·004/25
      const gaSel = (typeof estudio.ga === "number") ? estudio.ga : 76;
      const gbSel = (typeof estudio.gb === "number") ? estudio.gb : -16;
      const Lz = aforoRes ? aforoRes.gob : "S";
      const pgSel = aforoRes ? aforoRes.pgGob : PG.pgTexto(estudio.ga, estudio.gb);
      const reb = gaSel >= 70 ? "55" : "48";                    // punto de reblandecimiento min
      const sep = gaSel >= 70 ? "2" : null;                     // separacion (solo modificado)
      const ret = gaSel >= 76 ? "35" : (gaSel >= 70 ? "30" : null); // rec. elastica torsion 25 C
      const recDuc = gaSel >= 76 ? "75" : (gaSel >= 70 ? "60" : null); // rec. elastica ductilometro (RTFO)
      const tInt = { 64: 28, 70: 31, 76: 34 }[gaSel] || 34;    // temp intermedia DSR (PAV)
      const desiert = gaSel >= 70 ? "110" : "100";              // temp PAV clima desertico
      const tBBR = gbSel + 10;                                   // temp de prueba BBR (grado bajo + 10)
      const jnr = { S: "4.0", H: "2.0", V: "1.0", E: "0.5" }[Lz] || "4.0";
      const reMs = { S: "25", H: "25", V: "30", E: "40" }[Lz] || "25";
      nlp(90);
      head(mx, p, cwd, "Requisitos del cemento asfáltico " + pgSel + " (N·CMT·4·05·004/25) — solo el grado seleccionado"); p += 5.5;
      doc.setFontSize(7.2); setC(GR); doc.setFont(undefined, "normal"); doc.text(asc("En condiciones originales (Tabla 1)"), mx, p); p += 3.6;
      kv(mx, p, cwd, "Punto de inflamación Cleveland", "min 230 C"); p += 4.4;
      kv(mx, p, cwd, "Viscosidad rotacional 135 C", "max 3 Pa·s"); p += 4.4;
      kv(mx, p, cwd, "Punto de reblandecimiento", "min " + reb + " C"); p += 4.4;
      if (sep) { kv(mx, p, cwd, "Separación (dif. anillo y esfera)", "max " + sep + " C"); p += 4.4; }
      if (ret) { kv(mx, p, cwd, "Recuperación elástica por torsión 25 C", "min " + ret + " %"); p += 4.4; }
      kv(mx, p, cwd, "Módulo G*/sen(delta) @ 10 rad/s, " + gaSel + " C (DSR)", "min 1.0 kPa"); p += 5;
      doc.setFontSize(7.2); setC(GR); doc.setFont(undefined, "normal"); doc.text(asc("Después de RTFO (envejecimiento a corto plazo, Tabla 2)"), mx, p); p += 3.6;
      kv(mx, p, cwd, "Pérdida por calentamiento", "max 1 %"); p += 4.4;
      if (recDuc) { kv(mx, p, cwd, "Recuperación elástica en ductilómetro 25 C", "min " + recDuc + " %"); p += 4.4; }
      kv(mx, p, cwd, "Módulo G*/sen(delta) @ 10 rad/s, " + gaSel + " C", "min 2.2 kPa"); p += 4.4;
      kv(mx, p, cwd, "MSCR nivel " + Lz + " (" + PG.NIVELES[Lz] + ") · Jnr 3.2 kPa @ " + gaSel + " C", "max " + jnr + " kPa^-1"); p += 4.4;
      kv(mx, p, cwd, "MSCR nivel " + Lz + " · Respuesta elástica RE 3.2 kPa", "min " + reMs + " %"); p += 5;
      doc.setFontSize(7.2); setC(GR); doc.setFont(undefined, "normal"); doc.text(asc("Después de PAV (envejecimiento a largo plazo, Tabla 3)"), mx, p); p += 3.6;
      kv(mx, p, cwd, "Temp. de envejecimiento PAV (normal / desértico)", "100 / " + desiert + " C"); p += 4.4;
      kv(mx, p, cwd, "Rigidización G*·sen(delta) @ " + tInt + " C", "max 5 000 kPa"); p += 4.4;
      kv(mx, p, cwd, "Rigidez de flexión BBR S(t) @ " + tBBR + " C, 60 s", "max 300 MPa"); p += 4.4;
      kv(mx, p, cwd, "Rigidez de flexión BBR, valor m @ " + tBBR + " C", "min 0.300"); p += 5;
      linkN(mx, p, "Consultar N·CMT·4·05·004/25 (pruebas y valores del cemento asfáltico PG)", NORMA.ca); p += 5;
      // Requisitos de la mezcla — SOLO el método/tipo elegido y el tramo de ∑L que aplica (N·CMT·4·05·003/25)
      const Lm = aforoRes.Lu;
      const met = diseno ? diseno.metodo : (Lm > 1e7 ? "Desempeño" : "Marshall");
      const disc = diseno && diseno.tipo.disc, tm = diseno && diseno.tipoMezcla;
      let fm, tituloM;
      if (disc && tm === "SMA") {
        tituloM = "granulometría discontinua CON fibra (SMA) · M·MMP·4·05·043 (Tabla 5)";
        fm = [["Compactación giratoria (golpes Marshall)", "100 giros (50)"], ["Vacíos de aire (VMC), mín.", "4.0 %"], ["Vacíos en el pétreo (VMP), mín.", "17 %"], ["VFA (vacíos llenos de CA)", "75 - 82 %"], ["Fibra de celulosa, mín.", "0.3 %"], ["Escurrimiento, máx.", "0.3 %"], ["CA óptimo, mín.", "6.0 %"], ["TSR (daño por humedad), mín.", "80 %"]];
      } else if (disc && tm === "CASAA") {
        tituloM = "granulometría discontinua SIN fibra (CASAA) · M·MMP·4·05·056 (Tabla 6)";
        fm = [["Espesor de película efectiva, mín.", "9 um"], ["Escurrimiento, máx.", "0.3 %"], ["Vacíos de aire (VMC) @ 100 giros", "13 - 25 %"], ["Vacíos en el pétreo (VMP), mín.", "20 %"], ["TSR (daño por humedad), mín.", "80 %"]];
      } else if (met === "Desempeño") {
        const tierD = Lm <= 1e7 ? 1 : (Lm <= 3e7 ? 2 : 3);
        const rango = tierD === 1 ? "10^6 < L <= 10^7" : (tierD === 2 ? "10^7 < L <= 3x10^7" : "L > 3x10^7");
        const nini = tierD === 3 ? "89" : "90.5";
        const vfa = tierD === 1 ? "65 - 78 %" : "65 - 75 %";
        const pas = tierD === 3 ? "20 000" : "15 000";
        tituloM = "densa por DESEMPEÑO · M·MMP·4·05·046 (Tabla 3, " + rango + ")";
        fm = [["Compactación (% Gmm)", "Nini <= " + nini + " · Ndis <= 96 · Nmax <= 98"], ["Vacíos de aire (VMC) @ Ndis", "4 +/- 1 %"], ["VFA (vacíos llenos de CA)", vfa], ["Relación filler / CA", "0.6 - 1.2"], ["TSR (daño por humedad), mín.", "80 %"], ["Rodera Hamburgo, máx.", "10 mm a " + pas + " pasadas"]];
        if (tierD === 3) { fm.push(["Módulo dinámico E* (20 C, 10 Hz), mín.", "5 000 MPa"]); fm.push(["Módulo de rigidez a fatiga", "por proyecto (AASHTO T 321)"]); }
      } else {
        const mLow = Lm <= 1e6;
        const rango = mLow ? "L <= 10^6" : "10^6 < L <= 10^7";
        tituloM = "densa por MARSHALL · M·MMP·4·05·034 (Tabla 1, " + rango + ")";
        fm = [["Golpes por cara", mLow ? "50" : "75"], ["Estabilidad Marshall, mín.", mLow ? "5 340 N (1 200 lbf)" : "8 000 N (1 800 lbf)"], ["Flujo", "por diseño"], ["Vacíos de aire (VMC)", "4 +/- 1 %"], ["VFA (vacíos llenos de CA)", mLow ? "65 - 78 %" : "65 - 75 %"], ["TSR (daño por humedad), mín.", "80 %"], ["Rodera Hamburgo, máx.", mLow ? "10 mm a 10 000 pasadas" : "10 mm a 15 000 pasadas"]];
      }
      nlp(fm.length * 4.5 + 14);
      head(mx, p, cwd, "Requisitos de la mezcla — " + tituloM); p += 5.5;
      fm.forEach((r) => { kv(mx, p, cwd, r[0], r[1]); p += 4.5; });
      linkN(mx, p, "Consultar N·CMT·4·05·003/25 (mezcla); construcción: N·CTR·CAR·1·04·006", NORMA.mez); p += 5;
      // Requisitos del material pétreo (N·CMT·4·04) según tránsito / tipo de mezcla
      const Ln = aforoRes.Lu;
      let fp, tp;
      if (disc) { tp = "SMA / CASAA (Tabla 6)"; fp = [["Desgaste Los Ángeles", "<= 25 %"], ["Microdeval", "<= 15 %"], ["Alargadas y lajeadas", "<= 35 %"], ["Trituradas (1 / 2+ caras)", ">= 100 / 90 %"], ["Pulimento acelerado", ">= 30"], ["Desprendimiento por fricción", "<= 10 %"], ["Equivalente de arena", ">= 55 %"], ["Angularidad de arena", ">= 45 %"], ["Azul de metileno", "<= 12 mg/g"]]; }
      else if (Ln > 30e6) { tp = "densa, L > 30x10^6 (Tabla 4)"; fp = [["Desgaste Los Ángeles", "<= 30 %"], ["Microdeval", "<= 15 %"], ["Alargadas y lajeadas", "<= 35 %"], ["Trituradas (1 / 2+ caras)", ">= 100 / 90 %"], ["Equivalente de arena", ">= 55 %"], ["Angularidad de arena", ">= 45 %"], ["Azul de metileno", "<= 12 mg/g"], ["Desprendimiento por fricción", "<= 20 %"]]; }
      else if (Ln > 1e6) { tp = "densa, 10^6 < L <= 30x10^6 (Tabla 3)"; fp = [["Desgaste Los Ángeles", "<= 30 %"], ["Microdeval", "<= 18 %"], ["Alargadas y lajeadas", "<= 40 %"], ["Trituradas (1 / 2+ caras)", ">= 95 / 85 %"], ["Equivalente de arena", ">= 50 %"], ["Angularidad de arena", ">= 45 %"], ["Azul de metileno", "<= 15 mg/g"], ["Desprendimiento por fricción", "<= 20 %"]]; }
      else { tp = "densa, L <= 10^6 (Tabla 2)"; fp = [["Desgaste Los Ángeles", "<= 35 %"], ["Microdeval", "<= 18 %"], ["Alargadas y lajeadas", "<= 40 %"], ["Trituradas (1 / 2+ caras)", ">= 90 / 80 %"], ["Equivalente de arena", ">= 45 %"], ["Angularidad de arena", ">= 40 %"], ["Azul de metileno", "<= 18 mg/g"], ["Desprendimiento por fricción", "<= 20 %"]]; }
      nlp(fp.length * 4.5 + 18);
      head(mx, p, cwd, "Requisitos del material pétreo (N·CMT·4·04) — " + tp); p += 5.5;
      kv(mx, p, cwd, "Densidad relativa (grava y arena)", ">= 2.4"); p += 4.5;
      fp.forEach((r) => { kv(mx, p, cwd, r[0], r[1]); p += 4.5; });
      kv(mx, p, cwd, "Intemperismo acelerado (Na2SO4 / MgSO4)", "<= 15 / 20 %"); p += 4.5;
      linkN(mx, p, "Consultar N·CMT·4·04 (requisitos del material pétreo)", NORMA.pet); p += 5;
      p += 2;
      // Cantidades
      if (diseno) {
        const d = diseno;
        nlp(50);
        head(mx, p, cwd, "Cantidades (por volumen compactado)"); p += 5.5;
        kv(mx, p, cwd, "Geometría (ancho x largo x espesor)", d.ancho + " m x " + d.largo + " m x " + d.esp + " cm"); p += 4.5;
        kv(mx, p, cwd, "Tipo de capa · tamaño nominal máx.", (d.tipo.clase === "densa" ? "Densa estructural" : d.tipo.clase === "discontinua" ? tm + " (rodadura)" : "Delgada") + " · " + d.nom + " mm"); p += 4.5;
        kv(mx, p, cwd, "Volumen compactado", d.V.toFixed(1) + " m3"); p += 4.5;
        kv(mx, p, cwd, "Mezcla asfáltica (dens. " + d.dens + " t/m3)", d.tonMezcla.toFixed(1) + " t"); p += 4.5;
        kv(mx, p, cwd, "Cemento asfáltico (" + d.ca + " %)", d.tonCA.toFixed(1) + " t"); p += 4.5;
        kv(mx, p, cwd, "Material pétreo (masa · vol. banco, dens. " + d.densPet + ")", d.tonPetreo.toFixed(1) + " t · " + d.volPetreo.toFixed(1) + " m3"); p += 4.5;
        kv(mx, p, cwd, "Espesor suelto estimado (tramo de prueba)", d.espSuelto.toFixed(1) + " cm"); p += 4.5;
        if (d.Lestr != null) { kv(mx, p, cwd, "Ejes equivalentes calculados a " + d.esp + " cm (II-UNAM, " + aforoRes.anios + " años)", (d.Lestr / 1e6).toFixed(2) + " x10^6"); p += 4.5; }
        if (d.rap) {
          const r = d.rap;
          kv(mx, p, cwd, "RAP " + r.pRap + "% · reemplazo de ligante (AASHTO M323)", r.brr.toFixed(0) + " % -> Tier " + r.tier.n); p += 4.5;
          kv(mx, p, cwd, "Criterio", r.tier.ajuste); p += 4.5;
          if (r.virgenPG) { kv(mx, p, cwd, "Ligante virgen sugerido", r.virgenPG); p += 4.5; }
          kv(mx, p, cwd, "CA VIRGEN (a comprar) / CA del RAP", r.tonVirgAC.toFixed(1) + " / " + r.tonRAPac.toFixed(1) + " t"); p += 4.5;
        }
        p += 3;
      }
      // Recomendaciones
      nlp(24);
      head(mx, p, cwd, "Recomendaciones para construcción y conservación"); p += 5;
      const notas = [
        ["Los valores objetivo de control en obra son los del DISEÑO de la mezcla aprobado por la Secretaría; los valores de la NIT son umbrales de aceptación/rechazo, no metas de control.", false],
        ["Una vez aprobado el diseño NO se cambian los materiales: mantener el MISMO banco de material y el MISMO frente de ataque dentro de éste; cualquier variación en la calidad del material altera el desempeño y obliga a ajustar la Fórmula de Trabajo o a rediseñar la mezcla.", true],
        ["NO cambiar de distribuidor de cemento asfáltico distinto al del diseño: cada distribuidor tiene sus propias formulaciones (aditivos, polímeros) que modifican el desempeño de la mezcla.", true],
        ["Ejecutar el tramo de prueba (N·CTR·CAR·1·04·006) para calibrar el espesor suelto, las temperaturas de tendido/compactación y el grado de compactación (>=95 % dmm; 98 % en SMA).", false],
        ["Calidad = economía de largo plazo: garantizar la calidad hace que la conservación se requiera en el tiempo proyectado y no antes; una obra deficiente incrementa los costos de conservación y de operación vehicular (VOC) que paga el usuario.", false],
        ["Economía circular: se recomienda incorporar RAP y materiales fuera de uso, siempre con caracterización y control de calidad (NAPA, FHWA, NCAT).", false],
        ["Una capa de rodadura SMA/CASAA usada como tratamiento superficial sobre pavimento con baja capacidad estructural o alto deterioro verá reducida su vida útil proyectada.", false],
        ["Referencias: SICT (NIT), IMT, AMAAC (Protocolo PA·MA 01/2013), NCAT, FHWA, NAPA.", false],
      ];
      doc.setFontSize(7.8);
      notas.forEach((n) => {
        if (p > 250) { doc.addPage(); p = 20; }
        doc.setFont(undefined, n[1] ? "bold" : "normal"); setC(n[1] ? G : TN);
        const ls = doc.splitTextToSize(asc("• " + n[0]), cwd); doc.text(ls, mx, p); p += ls.length * 3.3 + 1.2;
      });
      doc.setFont(undefined, "normal");
      // Criterios para seleccionar el tipo de mezcla asfáltica
      if (p > 222) { doc.addPage(); p = 20; } else p += 3;
      head(mx, p, cwd, "Criterios para seleccionar el tipo de mezcla (NAPA IS-128, FHWA, AI, AMAAC, SICT)"); p += 5;
      const crit = [
        "Por nivel de tránsito: bajo -> solo mezcla densa; moderado -> densa (preferente); alto -> densa estructural y, en rodadura, SMA u OGFC/discontinua. SMA/OGFC no se justifican en bajo volumen por el costo de agregados y ligante premium (NAPA IS-128; N·CMT·4·05·003).",
        "Por función de la capa: base e intermedia (binder) -> densa (estructura); rodadura -> densa, SMA (rodera / tránsito pesado o canalizado) o discontinua/abierta (fricción, drenaje, ruido, antihidroplaneo).",
        "Espesor vs tamaño nominal: espesor compactado >= 3x (grueso) a 4x (fino) el tamaño nominal máximo (TNM); elegir el TNM acorde al espesor de la capa (N·CMT·4·05·003 E.6; NAPA IS-128).",
        "Método por intensidad de tránsito (∑L): <= 10^7 Marshall o Desempeño; > 10^7 obligatorio Desempeño (SUPERPAVE / AMAAC PA·MA 01-2013).",
        "SMA (con fibra): esqueleto pétreo con contacto piedra-piedra, 100% caras fracturadas, sin arenas naturales, agregado de alto pulimento, fibra y ligante modificado; alta resistencia a rodera.",
        "OGFC/abierta y discontinua sin fibra (CASAA): rodadura funcional (fricción, drenaje, ruido); NO en zonas de congelamiento ni precipitación < 600 mm/año; sin función estructural (N·CMT·4·05·003).",
        "Clima: alta temperatura / rodera -> ligante duro o modificado y SMA; baja temperatura / agrietamiento -> grado bajo más frío; ver Grado PG.",
        "Preservación (FHWA): sobrecarpetas delgadas, microaglomerados y riegos según la condición del pavimento; una rodadura delgada sobre un pavimento estructuralmente deficiente reduce su vida útil.",
      ];
      doc.setFontSize(7.8); setC(TN); doc.setFont(undefined, "normal");
      crit.forEach((c) => { if (p > 250) { doc.addPage(); p = 20; } const ls = doc.splitTextToSize(asc("• " + c), cwd); doc.text(ls, mx, p); p += ls.length * 3.3 + 1.2; });
    }
    // Pie de página + numeración en todas las hojas (anclado al fondo, sin encimarse)
    const pie = asc("Norma N·CMT·4·05·004/25 y Manual M·MMP·4·05·064/22. Grado alto {64,70,76} (>76 °C = diseño especial); grado bajo con piso en -10. El grado bajo indicado es el mínimo requerido: puede emplearse un grado más frío (-16 o -22) siempre que cumpla todos los requisitos de calidad a temperaturas alta y baja, en los ensayes de la Norma N·CMT·4·05·004. ESAL por el método del Inst. Ing. UNAM (II·UNAM, factores de daño superficial a 6.0 kg/cm²; camión, eje estándar 5.8). Clima: estaciones del SMN con >=20 años. Datos Viales / Anexo A PARCF 2026. *Velocidad de operación (camiones): DGST Velocidades de Punto 2025. Herramienta de referencia; el criterio del proyectista prevalece.");
    const lineasPie = doc.splitTextToSize(pie, Wd - 2 * mx);
    const yPie = 279.4 - 10 - lineasPie.length * 3.1;
    const total = doc.getNumberOfPages();
    for (let pi = 1; pi <= total; pi++) {
      doc.setPage(pi);
      doc.setDrawColor(...GR); doc.setLineWidth(0.2); doc.line(mx, yPie - 3, Wd - mx, yPie - 3);
      doc.setTextColor(...GR); doc.setFontSize(7.5); doc.setFont(undefined, "normal");
      doc.text(lineasPie, mx, yPie);
      doc.text("Página " + pi + " de " + total, Wd - mx, 274, { align: "right" });
    }
    doc.save(ex && ex.fname ? ex.fname : ("Reporte_PG_" + (c ? c.cp : estudio.lat.toFixed(3) + "_" + estudio.lon.toFixed(3)) + ".pdf"));
  }

  /* =============== Inicio =============== */
  if (window.LOGO && $("logo-sict")) $("logo-sict").src = window.LOGO;
  [["m-dropbox", "hga_dropbox"], ["m-validador", "hga_validador"]].forEach(([id, key]) => { const el = $(id); if (el) { try { el.value = localStorage.getItem(key) || ""; } catch (e) {} el.addEventListener("change", () => { try { localStorage.setItem(key, el.value.trim()); } catch (e) {} }); } });
  $("btn-punto") && $("btn-punto").addEventListener("click", calcularPunto);
  $("btn-punto-seg") && $("btn-punto-seg").addEventListener("click", calcularSegmentoCoords);
  $("btn-aforo") && $("btn-aforo").addEventListener("click", calcularAforo);
  $("btn-cad") && $("btn-cad").addEventListener("click", analizarSegmento);
  $("btn-diseno") && $("btn-diseno").addEventListener("click", calcularDiseno);
  ["cad-ini", "cad-fin"].forEach((id) => $(id) && $(id).addEventListener("input", actualizarLongitud));
  $("btn-analizar") && $("btn-analizar").addEventListener("click", analizarTodo);
  $("btn-volver") && $("btn-volver").addEventListener("click", () => mostrarModulo("captura"));
  $("btn-pdf2") && $("btn-pdf2").addEventListener("click", generarPDF);
  window.AppPG = { pdf: generarPDF, analizar: analizarTodo };
  // Tooltips propios para los iconos de ayuda (ⓘ): hover y clic (táctil)
  (function initTips() {
    const tip = document.createElement("div"); tip.className = "tip-pop"; tip.style.display = "none"; document.body.appendChild(tip);
    function show(el) {
      const t = el.getAttribute("data-help") || el.getAttribute("title") || ""; if (!t) return;
      tip.textContent = t; tip.style.display = "block";
      const r = el.getBoundingClientRect();
      let x = r.left + r.width / 2 - tip.offsetWidth / 2, y = r.top - tip.offsetHeight - 8;
      if (y < 6) y = r.bottom + 8;
      x = Math.max(6, Math.min(x, window.innerWidth - tip.offsetWidth - 6));
      tip.style.left = x + "px"; tip.style.top = y + "px";
    }
    function hide() { tip.style.display = "none"; }
    document.querySelectorAll(".ayuda").forEach((el) => {
      if (el.hasAttribute("title")) { el.setAttribute("data-help", el.getAttribute("title")); el.removeAttribute("title"); }
      el.setAttribute("tabindex", "0"); el.setAttribute("role", "button"); el.setAttribute("aria-label", "Ayuda");
      el.addEventListener("mouseenter", () => show(el));
      el.addEventListener("mouseleave", hide);
      el.addEventListener("focus", () => show(el));
      el.addEventListener("blur", hide);
      el.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); tip.style.display === "block" ? hide() : show(el); });
    });
    document.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    document.addEventListener("click", (e) => { if (!e.target.classList || !e.target.classList.contains("ayuda")) hide(); });
  })();
  initEstados(); leyenda(); chips(); sumaPct();
  setTimeout(function () { try { mapa.invalidateSize(); } catch (e) {} }, 300);
})();
