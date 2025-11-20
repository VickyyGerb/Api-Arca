import express from "express";
import { chromium } from "playwright";
import { execSync, spawnSync } from "child_process";
import fs from "fs";
import path from "path";

const PORT = 3000;
const HEADLESS_MODE = true;
const DEFAULT_TIMEOUT = 90000;

const app = express();
app.use(express.json());

const csrsFolder = path.join(process.cwd(), "csrs");
if (!fs.existsSync(csrsFolder)) fs.mkdirSync(csrsFolder, { recursive: true });

const erroresFolder = path.join(csrsFolder, "errores");
if (!fs.existsSync(erroresFolder))
  fs.mkdirSync(erroresFolder, { recursive: true });

/**
 * Guarda una captura de pantalla y el HTML de la página en caso de error.
 * @param {import('playwright').Page} page - La instancia de la página de Playwright.
 * @param {string} nombreBase - Un nombre para identificar el archivo de evidencia.
 */
async function guardarEvidenciaError(page, nombreBase = "error") {
  if (!page || page.isClosed()) {
    console.error(
      "Error al guardar evidencia: la página está cerrada o no es válida."
    );
    return;
  }
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const screenshotPath = path.join(
      erroresFolder,
      `${nombreBase}_${timestamp}.png`
    );
    const htmlPath = path.join(
      erroresFolder,
      `${nombreBase}_${timestamp}.html`
    );

    await page.screenshot({ path: screenshotPath, fullPage: true });
    const html = await page.content();
    fs.writeFileSync(htmlPath, html);

    console.log(`🧾 Evidencia de error guardada: ${screenshotPath}`);
  } catch (err) {
    console.error("Error crítico al intentar guardar evidencia:", err.message);
  }
}

/**
 * Genera la clave privada y el archivo CSR usando OpenSSL.
 * @param {string} razonSocial - Razón social para el CSR.
 * @param {string} CUIT - CUIT para el CSR.
 * @param {string} razonSocialNormalizada - Razón social sin espacios.
 * @param {number} año - Año actual.
 * @returns {{clavePrivadaPath: string, csrPath: string}}
 */
function generarArchivosOpenSSL(
  razonSocial,
  CUIT,
  razonSocialNormalizada,
  año
) {
  const clavePrivadaPath = path.join(
    csrsFolder,
    `MiClavePrivada_${razonSocialNormalizada}_${año}.key`
  );
  const csrPath = path.join(
    csrsFolder,
    `MiPedidoCSR_${razonSocialNormalizada}_${año}.csr`
  );

  console.log("🔑 Generando clave privada...");
  execSync(`openssl genrsa -out "${clavePrivadaPath}" 2048`);

  console.log("📝 Generando CSR...");
  const subj = `/C=AR/O=${razonSocial} SAS/CN=Sistema de Gestion/serialNumber=CUIT ${CUIT}`;
  execSync(
    `openssl req -new -key "${clavePrivadaPath}" -subj "${subj}" -out "${csrPath}"`
  );

  console.log("✅ Clave privada y CSR generados.");

  return { clavePrivadaPath, csrPath };
}

// === LÓGICA DE AUTOMATIZACIÓN ===

/**
 * Realiza el login en el portal de AFIP.
 * @param {import('playwright').BrowserContext} context - Contexto del navegador.
 * @param {object} credenciales - Credenciales de acceso.
 * @returns {Promise<import('playwright').Page>} - La página principal post-login.
 */
async function loginAFIP(context, { CUIL, clave }) {
  console.log("➡️  Iniciando login en AFIP...");
  const page = await context.newPage();
  await page.goto("https://www.afip.gob.ar/landing/default.asp");

  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Iniciar sesión" }).click();
  const loginPage = await popupPromise;
  await loginPage.waitForLoadState("domcontentloaded");

  console.log("    - Ingresando CUIL...");
  await loginPage.getByRole("spinbutton").fill(CUIL);
  await loginPage.getByRole("button", { name: "Siguiente" }).click();

  console.log("    - Ingresando clave...");
  await loginPage.locator('input[type="password"]:visible').fill(clave);
  await loginPage.getByRole("button", { name: "Ingresar" }).click();

  console.log(
    "    - Verificando resultado del login (Éxito, Error o Captcha)..."
  );

  const successURL = "**/portal/app/**";
  const errorLoginLocator = loginPage.locator("span#F1\\:msg");
  const captchaLocator = loginPage
    .locator(
      'img[alt*="captcha" i], input[id*="captcha" i], input[name*="captcha" i]'
    )
    .first();

  const successPromise = loginPage.waitForURL(successURL).then(() => "success");
  const errorPromise = errorLoginLocator
    .waitFor({ state: "visible" })
    .then(() => "passwordError");
  const captchaPromise = captchaLocator
    .waitFor({ state: "visible" })
    .then(() => "captcha");

  const outcome = await Promise.race([
    successPromise,
    errorPromise,
    captchaPromise,
  ]);

  switch (outcome) {
    case "success":
      console.log("✅ Login exitoso, navegación al portal confirmada.");
      break;
    case "passwordError":
      const textoError = await errorLoginLocator.textContent();
      await guardarEvidenciaError(loginPage, "error_login_credenciales");
      throw new Error(`Error de login en AFIP: ${textoError?.trim()}`);
    case "captcha":
      console.log("⚠️ Captcha detectado en el login.");
      await guardarEvidenciaError(loginPage, "captcha_detectado");
      throw new Error("Captcha detectado");
  }

  return loginPage;
}

/**
 * Busca y navega a la sección de "Administración de Certificados Digitales".
 * @param {import('playwright').Page} mainPage - La página principal de AFIP.
 * @returns {Promise<import('playwright').Page>} - La página de administración de certificados.
 */
async function navegarACertificados(mainPage) {
  console.log("➡️  Navegando a 'Administración de Certificados Digitales'...");
  const buscador = mainPage.getByRole("combobox", { name: "Buscador" });
  await buscador.click();
  await buscador.fill("certificados digitales");

  const linkCertificados = mainPage.getByRole("link", {
    name: "Administración de Certificados Digitales",
  });
  await linkCertificados.waitFor({ state: "visible" });

  // --- INICIO DE LA LÓGICA DEFINITIVA CON Promise.race ---
  // Este es el escenario perfecto para una carrera: un solo clic puede resultar en un modal O un popup.
  console.log(
    "    - Preparando para manejar un modal o un popup directo tras el clic..."
  );

  // 1. (Listen) Preparamos las dos promesas que competirán.
  // Promesa para el modal: se resuelve con el string 'modal' si el botón aparece.
  const modalButton = mainPage.getByRole("button", { name: "Continuar" });
  const modalPromise = modalButton
    .waitFor({ state: "visible" })
    .then(() => "modal");

  // Promesa para el popup: se resuelve con el objeto de la nueva página si se abre un popup.
  const popupPromise = mainPage.waitForEvent("popup");

  // 2. (Act) Realizamos el clic que disparará uno de los dos eventos.
  await linkCertificados.click();

  // 3. (Await) Esperamos al ganador de la carrera.
  const raceWinner = await Promise.race([modalPromise, popupPromise]);

  let adminCertPage; // Variable para almacenar la página final del popup.

  // 4. Actuamos según el resultado.
  if (typeof raceWinner === "string" && raceWinner === "modal") {
    // El modal apareció primero.
    console.log(
      "    - Modal 'Continuar' apareció. Haciendo clic para abrir el popup..."
    );
    // El popupPromise original ya no es válido, así que preparamos uno nuevo.
    const secondPopupPromise = mainPage.waitForEvent("popup");
    await modalButton.click();
    adminCertPage = await secondPopupPromise; // Ahora sí, esperamos el popup real.
  } else {
    // El popup se abrió directamente. raceWinner ES el objeto de la página.
    console.log("    - El popup se abrió directamente. Continuando...");
    adminCertPage = raceWinner;
  }
  // --- FIN DE LA LÓGICA ---

  await adminCertPage.waitForLoadState("domcontentloaded");

  console.log("✅ Acceso a la página de certificados correcto.");
  return adminCertPage;
}

/**
 * Sube el archivo CSR y genera el certificado.
 * @param {import('playwright').Page} adminCertPage - La página de administración de certificados.
 * @param {object} datos - Datos para el formulario.
 */
async function subirCSR(adminCertPage, { alias, csrPath }) {
  console.log("➡️  Completando formulario de nuevo certificado...");

  const botonIngresar = adminCertPage.locator('input[name="cmdIngresar"]');
  if (await botonIngresar.isVisible()) {
    console.log(
      "    - Se detectó paso intermedio. Haciendo click en 'Ingresar'."
    );
    await botonIngresar.click();
    await adminCertPage.waitForLoadState("domcontentloaded");
  }

  console.log(`    - Alias: ${alias}`);
  await adminCertPage.locator("#txtAliasCertificado").fill(alias);

  console.log("    - Subiendo archivo CSR...");
  await adminCertPage.locator('input[type="file"]').setInputFiles(csrPath);

  console.log("    - Enviando formulario...");
  await adminCertPage.locator('input[name="cmdIngresar"]').click();

  await adminCertPage
    .locator('a:has-text("Ver")')
    .first()
    .waitFor({ state: "visible" });
  console.log("✅ Formulario enviado y procesado con éxito.");
}

/**
 * Descarga el archivo de certificado (.crt).
 * @param {import('playwright').Page} adminCertPage - La página de administración de certificados.
 * @param {string} crtPath - Ruta donde se guardará el archivo.
 */
async function descargarCertificado(adminCertPage, crtPath) {
  console.log("➡️  Descargando certificado...");

  await adminCertPage.locator('a:has-text("Ver")').first().click();
  await adminCertPage
    .getByRole("button", { name: "Descargar" })
    .waitFor({ state: "visible" });

  const downloadPromise = adminCertPage.waitForEvent("download");
  await adminCertPage.getByRole("button", { name: "Descargar" }).click();
  const download = await downloadPromise;

  await download.saveAs(crtPath);
  console.log(`✅ Certificado descargado en: ${crtPath}`);
}

/**
 * Crea la relación con el WebService de Facturación Electrónica.
 * @param {import('playwright').Page} mainPage - La página principal de AFIP.
 * @param {string} alias - El alias del certificado que se debe seleccionar.
 */
async function crearRelacionWebService(mainPage, CUIT, alias) {
  console.log("➡️  Iniciando creación de relación con Web Service...");

  await mainPage.bringToFront();
  await mainPage.goto("https://portalcf.cloud.afip.gob.ar/portal/app/", {
    waitUntil: "domcontentloaded",
  });

  const buscador = mainPage.getByRole("combobox", { name: "Buscador" });
  await buscador.click();
  await buscador.fill("Administrador de Relaciones");

  const popupPromise = mainPage.waitForEvent("popup");
  await mainPage
    .getByRole("link", { name: "Administrador de Relaciones" })
    .click();
  const adminRelPage = await popupPromise;
  await adminRelPage.waitForLoadState("domcontentloaded");

  console.log(
    "    - Esperando dinámicamente por el selector de CUIT o el botón 'Nueva Relación'..."
  );
  const selectorContribuyente = adminRelPage.locator(
    "#tblAutoridadAplicacion_cmbCont"
  );
  const botonNuevaRelacion = adminRelPage.locator("#cmdNuevaRelacion");

  const selectPromise = selectorContribuyente
    .waitFor({ state: "visible" })
    .then(() => "select");
  const buttonPromise = botonNuevaRelacion
    .waitFor({ state: "visible" })
    .then(() => "button");

  const firstElement = await Promise.race([selectPromise, buttonPromise]);

  if (firstElement === "select") {
    console.log(
      "    - Selector de contribuyente apareció primero. Seleccionando CUIT..."
    );
    await selectorContribuyente.selectOption({ value: CUIT });
    console.log(
      "    - Esperando a que la página se actualice post-selección..."
    );
    await adminRelPage.waitForLoadState("domcontentloaded");
    console.log("    - Página actualizada. Clickeando 'Nueva Relación'...");
    await botonNuevaRelacion.click();
  } else {
    console.log(
      "    - Botón 'Nueva Relación' apareció primero. Clickeando directamente..."
    );
    await botonNuevaRelacion.click();
  }

  await adminRelPage.waitForLoadState("domcontentloaded");

  console.log(
    "    - Verificando selector de representado (#cboRepresentado)..."
  );
  const selectorRepresentado = adminRelPage.locator("#cboRepresentado");

  if (await selectorRepresentado.isEnabled({ timeout: 5000 })) {
    console.log(
      `    - Selector de representado habilitado. Seleccionando CUIT ${CUIT}...`
    );
    await selectorRepresentado.selectOption({ value: CUIT });
    console.log("    - CUIT seleccionado.");
  } else {
    console.log(
      "    - Selector de representado deshabilitado o no interactivo. Continuando."
    );
  }

  const botonModificarServicio = adminRelPage
    .locator("#cmdBuscarServicio")
    .or(adminRelPage.getByRole("button", { name: "Modificar el Servicio" }));

  await botonModificarServicio.click();

  await adminRelPage.waitForLoadState("networkidle");

  console.log("    - Haciendo clic en el logo de AFIP para ver servicios...");
  const logoAfip = adminRelPage.getByRole("img", {
    name: "Agencia de Recaudación y Control Aduanero",
  });
  await logoAfip.waitFor({ state: "visible" });
  await logoAfip.click();

  await adminRelPage.waitForLoadState("networkidle");

  console.log("    - Haciendo clic en 'WebServices'...");
  const webServicesCell = adminRelPage.locator(
    'td[onclick*="ctrl.org.afip.grp.webservices"]'
  );
  await webServicesCell.waitFor({ state: "visible" });
  await webServicesCell.click();

  await adminRelPage.waitForLoadState("networkidle");

  console.log("    - Seleccionando servicio 'Facturación Electrónica'...");
  await adminRelPage
    .getByRole("link", { name: "Facturación Electrónica" })
    .click();
  await adminRelPage.waitForLoadState("domcontentloaded");

  console.log("    - Haciendo clic en 'Buscar representante'...");
  await adminRelPage.locator("#cmdBuscarUsuario").click();

  await adminRelPage.waitForLoadState("networkidle");

  console.log(`    - Seleccionando computador por alias: ${alias}...`);
  const computadorDropdown = adminRelPage.locator(
    "#cboComputadoresAdministrados"
  );
  await computadorDropdown.waitFor({ state: "visible" });
  await computadorDropdown.selectOption({ label: alias });

  await adminRelPage.waitForLoadState("networkidle");

  await adminRelPage.locator("#cmdSeleccionarServicio").click();
  await adminRelPage.waitForLoadState("networkidle");

  console.log("    - Confirmando la relación final...");
  await adminRelPage.locator("#cmdGenerarRelacion").click();
  await adminRelPage.waitForLoadState("networkidle");

  console.log("✅ Relación con Web Service creada exitosamente.");
  await adminRelPage.close();
}

// === FUNCIÓN PRINCIPAL ORQUESTADORA ===
async function generarCertificado({ cliente, CUIT, CUIL, clave }) {
  const browser = await chromium.launch({ headless: HEADLESS_MODE });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1280, height: 1024 },
  });
  context.setDefaultTimeout(DEFAULT_TIMEOUT);
  context.setDefaultNavigationTimeout(DEFAULT_TIMEOUT);

  let mainPage;
  const tempFiles = [];

  try {
    mainPage = await loginAFIP(context, { CUIL, clave });

    const razonSocial = (
      await mainPage
        .locator("nav#cabeceraAFIPlogoNegro strong.text-primary")
        .textContent()
    )?.trim();
    if (!razonSocial)
      throw new Error("No se pudo obtener la razón social del contribuyente.");
    console.log(`👤 Razón Social: ${razonSocial}`);

    const razonSocialNormalizada = razonSocial.replace(/\s+/g, "_");
    const año = new Date().getFullYear();

    const { clavePrivadaPath, csrPath } = generarArchivosOpenSSL(
      razonSocial,
      CUIT,
      razonSocialNormalizada,
      año
    );
    tempFiles.push(clavePrivadaPath, csrPath);

    const adminCertPage = await navegarACertificados(mainPage);

    const alias = `TRIZAP_${cliente}_${año}_${Date.now()}`;
    await subirCSR(adminCertPage, { alias, csrPath });

    const crtPath = path.join(
      csrsFolder,
      `CertificadoDN_${razonSocialNormalizada}_${año}.crt`
    );
    tempFiles.push(crtPath);
    await descargarCertificado(adminCertPage, crtPath);
    await adminCertPage.close();

    await crearRelacionWebService(mainPage, CUIT, alias);

    console.log("📦 Generando y guardando archivo PFX final...");

    const fileName = `${cliente}_${razonSocialNormalizada}_${año}.pfx`;
    const pfxPath = path.join(csrsFolder, fileName);

    const opensslResult = spawnSync("openssl", [
      "pkcs12",
      "-export",
      "-inkey",
      clavePrivadaPath,
      "-in",
      crtPath,
      "-out",
      pfxPath,
      "-passout",
      "pass:",
    ]);

    if (opensslResult.error) throw opensslResult.error;
    if (opensslResult.status !== 0)
      throw new Error(opensslResult.stderr.toString());

    console.log(`✅ Archivo PFX guardado exitosamente en: ${pfxPath}`);

    const pfxBuffer = fs.readFileSync(pfxPath);

    return {
      razonSocial,
      alias,
      pfxBuffer: pfxBuffer,
      fileName: fileName,
    };
  } catch (error) {
    console.error(
      "💥 Ha ocurrido un error en el proceso de generación:",
      error.message
    );
    const activePage = context.pages().pop();
    if (activePage)
      await guardarEvidenciaError(activePage, "error_flujo_principal");

    throw error;
  } finally {
    console.log("🧹 Limpiando y cerrando navegador...");
    tempFiles.forEach((file) => {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch (err) {
        console.warn(
          `No se pudo eliminar el archivo temporal ${file}: ${err.message}`
        );
      }
    });
    if (browser) await browser.close();
  }
}

// === ENDPOINTS DE LA API ===

app.post("/api/certificado", async (req, res) => {
  console.log("📥 Solicitud recibida en /api/certificado");
  const { cliente, CUIT, CUIL, clave } = req.body;

  if (!cliente || !CUIT || !CUIL || !clave) {
    return res.status(400).json({
      error: "Faltan parámetros obligatorios: cliente, CUIT, CUIL, clave.",
    });
  }

  try {
    console.log(`🔄 Iniciando generación para cliente: ${cliente}`);
    const resultado = await generarCertificado({ cliente, CUIT, CUIL, clave });

    console.log("✅ Proceso completado. Enviando archivo PFX.");
    res.setHeader("Content-Type", "application/x-pkcs12");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${resultado.fileName}"`
    );
    res.send(resultado.pfxBuffer);
  } catch (err) {
    console.error(
      "💥 Error final en el endpoint /api/certificado:",
      err.message
    );
    res.status(500).json({
      error: "No se pudo completar la generación del certificado.",
      detalle: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
});

app.get("/api/ping", (req, res) => {
  res.json({ mensaje: "pong", status: "servidor activo" });
});

app.use((req, res) => {
  res.status(404).json({ error: "Endpoint no encontrado." });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor Express corriendo en http://localhost:${PORT}`);
});
