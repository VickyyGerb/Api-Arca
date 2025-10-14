import express from "express";
import { chromium } from "playwright";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());

// === Función que ejecuta el flujo completo ===
async function generarCertificado({ cliente, CUIT, CUIL, clave }) {
  const año = new Date().getFullYear();
  const csrsFolder = path.join(process.cwd(), "csrs");
  if (!fs.existsSync(csrsFolder)) fs.mkdirSync(csrsFolder, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  // === LOGIN AFIP ===
  await page.goto("https://www.afip.gob.ar/landing/default.asp");
  const loginPopupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Iniciar sesión" }).click();
  const loginPage = await loginPopupPromise;

  await loginPage.getByRole("spinbutton").fill(CUIL);
  await loginPage.getByRole("button", { name: "Siguiente" }).click();

  // === DETECCIÓN DE CAPTCHA ===
  await loginPage.waitForTimeout(1500); // pequeño delay para permitir carga del captcha

  const hayCaptcha = await loginPage.evaluate(() => {
    const imgs = [...document.querySelectorAll("img")];
    const captchaImg = imgs.find(
      (img) =>
        img.alt?.toLowerCase().includes("captcha") ||
        img.src?.toLowerCase().includes("captcha")
    );
    const captchaInput = document.querySelector(
      'input[id*="captcha"], input[name*="captcha"]'
    );
    return Boolean(captchaImg || captchaInput);
  });

  if (hayCaptcha) {
    console.log("⚠️ Captcha detectado en el login");
    await browser.close();
    throw new Error("Captcha detectado");
  } else {
    console.log("✅ No se detectó captcha, continuando con login...");
  }

  await loginPage.locator('input[type="password"]:visible').fill(clave);
  await loginPage.getByRole("button", { name: "Ingresar" }).click();

  try {
    const errorVisible = await loginPage.locator("span#F1\\:msg").isVisible();
    if (errorVisible) {
      await browser.close();
      throw new Error("Error de login: Credenciales inválidas");
    }
  } catch (error) {
    await browser.close();
    throw new Error("Error verificando el login: " + error.message);
  }

  const razonSocial = (
    await loginPage
      .locator("nav#cabeceraAFIPlogoNegro strong.text-primary")
      .textContent()
  )?.trim();

  if (!razonSocial) throw new Error("No se pudo obtener la razón social.");
  const razonSocial2 = razonSocial.replace(/\s+/g, "_");

  const clavePrivada = path.join(
    csrsFolder,
    `MiClavePrivada_${razonSocial2}_${año}.key`
  );
  const csrPath = path.join(
    csrsFolder,
    `MiPedidoCSR_${razonSocial2}_${año}.csr`
  );

  // === Generar clave privada y CSR ===
  execSync(`openssl genrsa -out "${clavePrivada}" 2048`);
  execSync(
    `openssl req -new -key "${clavePrivada}" ` +
      `-subj "/C=AR/O=Agencia ${razonSocial2} SAS/CN=Sistema de Gestion/serialNumber=CUIT ${CUIT}" ` +
      `-out "${csrPath}"`
  );

  // === Navegación a Administración de Certificados ===
  console.log("Buscando servicio de certificados digitales...");

  await loginPage
    .getByRole("combobox", { name: "Buscador" })
    .fill("certificados digitales");

  await loginPage.waitForTimeout(3000);

  let adminPage;

  // Estrategia principal: Click en el enlace de certificados
  try {
    const certificadosLink = loginPage
      .locator('a:has-text("Administración de Certificados")')
      .first();
    await certificadosLink.waitFor({ state: "visible", timeout: 10000 });
    console.log("Enlace de certificados encontrado, haciendo click...");

    // Hacer click y manejar tanto modal como popup
    await certificadosLink.click();
    await loginPage.waitForTimeout(2000);
  } catch (error) {
    console.log("No se encontró el enlace directo, intentando alternativas...");

    // Alternativa 1: Buscar por texto parcial
    try {
      const linkAlternativo = loginPage
        .locator('a:has-text("Administración de")')
        .first();
      await linkAlternativo.click();
      await loginPage.waitForTimeout(2000);
    } catch (error2) {
      // Alternativa 2: Agregar servicio
      try {
        await loginPage
          .locator('a:has-text("Agregar servicio")')
          .first()
          .click();
        await loginPage.waitForTimeout(2000);
      } catch (error3) {
        throw new Error("No se pudo acceder a los certificados digitales");
      }
    }
  }

  // === MANEJO DEL MODAL - ESTRATEGIA MEJORADA ===
  let modalAparecio = false;

  try {
    // Esperar y manejar el modal de "Agregar Servicio"
    const modalButton = loginPage.getByRole("button", { name: "Continuar" });
    await modalButton.waitFor({ state: "visible", timeout: 5000 });
    console.log("Modal detectado, haciendo click en Continuar...");
    await modalButton.click();
    modalAparecio = true;
    await loginPage.waitForTimeout(2000);
  } catch (error) {
    console.log("No apareció el modal, continuando...");
  }

  // === MANEJO DEL POPUP - ESTRATEGIA MEJORADA ===
  try {
    // Esperar el popup de administración (con timeout más largo)
    adminPage = await loginPage.waitForEvent("popup", { timeout: 15000 });
    console.log("Popup de administración abierto correctamente");
  } catch (error) {
    console.log(
      "No se abrió popup, verificando si estamos en la página correcta..."
    );

    // Si no hay popup, verificar en qué página estamos
    const currentUrl = loginPage.url();
    console.log("URL actual después del click:", currentUrl);

    // Verificar si estamos en una página de administración
    if (currentUrl.includes("certificados") || currentUrl.includes("cot")) {
      console.log(
        "Ya estamos en la página de certificados, usando página actual"
      );
      adminPage = loginPage;
    } else {
      // Intentar navegar manualmente a la página de certificados
      console.log("Navegando manualmente a la página de certificados...");
      await loginPage.goto(
        "https://serviciosweb.afip.gob.ar/clavefiscal/adminrel/verCertificado.aspx"
      );
      adminPage = loginPage;
      const pages = context.pages();
      await pages[2].close();
    }
  }

  // === VERIFICACIÓN DE LA PÁGINA DE ADMINISTRACIÓN ===
  await adminPage.waitForLoadState("domcontentloaded");
  await adminPage.waitForTimeout(5000);

  console.log("URL de administración:", adminPage.url());
  console.log("Título:", await adminPage.title());

  // Verificar si estamos en una página de error
  if ((await adminPage.locator('text="No se puede encontrar"').count()) > 0) {
    throw new Error("La página de administración no cargó correctamente");
  }

  // === INTERACCIÓN CON LA PÁGINA DE ADMINISTRACIÓN ===
  try {
    // Esperar a que los elementos estén disponibles
    await adminPage.waitForTimeout(3000);

    // Buscar el botón de ingresar con múltiples estrategias
    const botonesIngresar = [
      "#cmdIngresar",
      'input[type="submit"][value*="Ingresar"]',
      'button:has-text("Ingresar")',
      'a:has-text("Ingresar")',
      'input[value="Ingresar"]',
    ];

    let botonEncontrado = false;

    for (const selector of botonesIngresar) {
      const boton = adminPage.locator(selector);
      if ((await boton.count()) > 0) {
        console.log(`Botón encontrado con selector: ${selector}`);
        await boton.click();
        botonEncontrado = true;
        await adminPage.waitForTimeout(3000);
        break;
      }
    }

    if (!botonEncontrado) {
      // Verificar si ya estamos en el formulario
      const aliasInput = adminPage.locator("#txtAliasCertificado");
      if ((await aliasInput.count()) > 0) {
        console.log("Ya estamos en el formulario de gestión");
        botonEncontrado = true;
      } else {
        throw new Error(
          "No se pudo encontrar el botón para ingresar al formulario"
        );
      }
    }

    // === FORMULARIO DE GESTIÓN DE CERTIFICADOS ===
    await adminPage.waitForTimeout(2000);

    // Llenar alias
    const alias = `TRIZAP_${cliente}_${año}_${Date.now()}`;
    await adminPage.locator("#txtAliasCertificado").fill(alias);
    console.log("Alias completado:", alias);

    // Subir archivo CSR
    await adminPage.locator('input[type="file"]').setInputFiles(csrPath);
    console.log("Archivo CSR subido");

    // Enviar formulario
    await adminPage.locator("#cmdIngresar").click();
    console.log("Formulario enviado");

    // Esperar procesamiento
    await adminPage.waitForTimeout(5000);

    // === DESCARGAR CERTIFICADO ===
    // Hacer click en "Ver"
    await adminPage.locator('a:has-text("Ver")').first().click();
    await adminPage.waitForTimeout(3000);

    // Descargar certificado
    const downloadPromise = adminPage.waitForEvent("download");
    await adminPage.getByRole("button", { name: "Descargar" }).click();
    const download = await downloadPromise;

    const crtPath = path.join(
      csrsFolder,
      `CertificadoDN_${razonSocial2}_${año}.crt`
    );
    await download.saveAs(crtPath);
    console.log("Certificado descargado:", crtPath);

    // === GENERAR PFX ===
    const pfxPath = path.join(
      csrsFolder,
      `${cliente}_${razonSocial2}_${año}.pfx`
    );
    execSync(
      `openssl pkcs12 -export -out "${pfxPath}" -inkey "${clavePrivada}" -in "${crtPath}" -passout pass:`
    );
    console.log("Archivo PFX generado:", pfxPath);

    try {
      if (fs.existsSync(clavePrivada)) {
        fs.unlinkSync(clavePrivada);
        console.log("Archivo eliminado:", clavePrivada);
      }
      if (fs.existsSync(csrPath)) {
        fs.unlinkSync(csrPath);
        console.log("Archivo eliminado:", csrPath);
      }
      if (fs.existsSync(crtPath)) {
        fs.unlinkSync(crtPath);
        console.log("Archivo eliminado:", crtPath);
      }
    } catch (err) {
      console.error("Error eliminando archivos temporales:", err);
    }

    await browser.close();

    return {
      razonSocial,
      alias,
      pfxPath,
      mensaje:
        "Certificado generado correctamente y archivos temporales eliminados",
    };
  } catch (error) {
    console.error("Error en la página de administración:", error);

    const errorFileName = `error-${razonSocial2}_${año}.png`;
    const errorPath = path.join(csrsFolder, errorFileName);

    await adminPage.screenshot({ path: errorPath });
    console.log(`Screenshot guardado como ${errorFileName}`);

    await browser.close();
    throw new Error(`Error en la gestión de certificados: ${error.message}`);
  }
}

// === Endpoint API ===
app.get("/api/ping", async (req, res) => {
  try {
    res.json({ mensaje: "pong" });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/certificado", async (req, res) => {
  try {
    const { cliente, CUIT, CUIL, clave } = req.body;

    if (!cliente || !CUIT || !CUIL || !clave) {
      return res
        .status(400)
        .json({ error: "Faltan parámetros: cliente, CUIT, CUIL, clave" });
    }

    const resultado = await generarCertificado({ cliente, CUIT, CUIL, clave });
    res.json(resultado);
  } catch (err) {
    console.error("Error en generarCertificado:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// === Iniciar servidor ===
app.listen(3000, () => {
  console.log("API corriendo en http://localhost:3000");
});
