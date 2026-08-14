/*!
 * pg-engine.js — Motor de cálculo del Grado de Desempeño (PG) del cemento asfáltico
 * SICT · Dirección General de Servicios Técnicos
 * Método: Manual M·MMP·4·05·064/22 y Norma N·CMT·4·05·004/25 (NIT)
 *
 * - Temperaturas de pavimento a H = 20 mm y 98 % de confiabilidad (Z = 2.055).
 * - Grado alto estándar {64, 70, 76}; si Tmáx pav > 76 °C = DISEÑO ESPECIAL.
 * - Grado bajo: escalera {-10, -16, -22, …}; el más cálido es -10 (piso).
 * - Ejes equivalentes (∑L) por dos criterios comparables: Inst. Ing. UNAM y AASHTO 93.
 * - Nivel de ajuste (Normal/Alto/Muy alto/Extremadamente alto) por ∑L y velocidad.
 */
const PG = (function () {
  "use strict";

  const H = 20;      // profundidad de referencia (mm) — FIJA (SHRP/LTPP)
  const Z = 2.055;   // confiabilidad 98 %

  const GRADOS_ALTOS = [64, 70, 76];                       // > 76 °C ⇒ diseño especial
  const GRADOS_BAJOS = [-10, -16, -22, -28, -34, -40, -46]; // -10 = más cálido (piso)

  // Factores de daño por tipo de vehículo (ejes equivalentes de 8.2 t)
  // UNAM (Inst. de Ingeniería): coeficientes oficiales de la BD de Datos Viales 2024 (DGST) =
  // método II-UNAM de DAÑO SUPERFICIAL (z=0) a 6.0 kg/cm² (camión; eje estándar 5.8). Verificado
  // que reproducen exacto los DGST DV2024 (proyecto II-UNAM). El ∑L a profundidad va en factores_iiunam.js.
  // "otros" no tiene factor asignado en la fuente ⇒ se toma como C3 (respaldo conservador).
  const FD_UNAM   = { a: 0.0047329, b: 2.4246079, c2: 2.4246079, c3: 3.6369118, t3s2: 6.0615197, t3s3: 7.2738236, t3s2r4: 10.9107354, otros: 3.6369118 };
  const FD_AASHTO = { a: 0.0,    b: 1.686, c2: 2.462, c3: 2.073, t3s2: 3.939, t3s3: 3.668, t3s2r4: 5.806, otros: 2.073 };

  // Factor de distribución del tránsito en el carril de diseño (Tabla 1)
  const FDC = { 1: 1.0, 2: 0.8, 3: 0.5, 4: 0.4 };

  const NIVELES = { S: "Normal", H: "Alto", V: "Muy alto", E: "Extremadamente alto" };

  const log10 = (x) => Math.log(x) / Math.LN10;

  /** Temperatura máxima del pavimento a 20 mm (°C). */
  function tmaxPavimento(TairM, lat, sigma) {
    return 54.32 + 0.78 * TairM - 0.0025 * lat * lat
         - 15.14 * log10(H + 25) + Z * Math.sqrt(9 + 0.61 * sigma * sigma);
  }

  /** Temperatura mínima del pavimento (°C). */
  function tminPavimento(Tairm, lat, sigma) {
    return -1.56 + 0.72 * Tairm - 0.004 * lat * lat
         + 6.26 * log10(H + 25) - Z * Math.sqrt(4.4 + 0.52 * sigma * sigma);
  }

  /** Grado alto estándar; devuelve "ESP" si la temperatura exige diseño especial (> 76 °C). */
  function gradoAlto(t) {
    for (const g of GRADOS_ALTOS) if (g >= t) return g;
    return "ESP";
  }

  /** Grado bajo: el más cálido cuyo valor sea ≤ Tmín de pavimento (piso en -10). */
  function gradoBajo(t) {
    const aptos = GRADOS_BAJOS.filter((g) => g <= t);
    return aptos.length ? Math.max(...aptos) : "ESP";
  }

  /** Texto del grado PG (maneja el caso de diseño especial). */
  function pgTexto(ga, gb) {
    if (ga === "ESP" || gb === "ESP") return "Diseño especial";
    return "PG " + ga + "-" + Math.abs(gb);
  }

  /** TDPA del carril de diseño según el Sentido de Circulación (SC = 0 ⇒ ambos ⇒ /2). */
  function tdpaSentido(tdpa, sc) {
    return Number(sc) === 0 ? tdpa / 2 : tdpa;
  }

  /**
   * Ejes equivalentes acumulados ∑L (ejes de 8.2 t) en el periodo de servicio.
   * @param {number}  tdpaDir  TDPA del carril de diseño (por sentido).
   * @param {object}  mezcla   Porcentajes por tipo: {a,b,c2,c3,t3s2,t3s3,t3s2r4,otros}.
   * @param {object}  factores FD_UNAM o FD_AASHTO.
   * @param {number}  tasa     Tasa de crecimiento anual (fracción, p.ej. 0.026).
   * @param {number}  anios    Periodo (10, 15 o 20).
   * @param {number}  carriles Carriles por sentido (1–4).
   */
  function esal({ tdpaDir, mezcla, factores, tasa, anios = 20, carriles = 2 }) {
    const fdc = FDC[carriles] != null ? FDC[carriles] : 0.8;
    let diario = 0;
    for (const k in factores) diario += tdpaDir * ((mezcla[k] || 0) / 100) * factores[k];
    const crecimiento = tasa > 0 ? (Math.pow(1 + tasa, anios) - 1) / tasa : anios;
    return diario * 365 * crecimiento * fdc;
  }

  /** Nivel de ajuste (letra S/H/V/E) por intensidad de tránsito y velocidad (Tabla 1). */
  function nivelAjuste(sumaL, velocidad) {
    const col = velocidad > 70 ? 0 : (velocidad >= 20 ? 1 : 2);
    const fila = sumaL < 1e6 ? ["S", "H", "V"]
              : (sumaL <= 30e6 ? ["H", "H", "V"] : ["V", "V", "E"]);
    return fila[col];
  }

  return {
    H, Z, GRADOS_ALTOS, GRADOS_BAJOS, FD_UNAM, FD_AASHTO, FDC, NIVELES,
    tmaxPavimento, tminPavimento, gradoAlto, gradoBajo, pgTexto,
    tdpaSentido, esal, nivelAjuste,
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = PG;
