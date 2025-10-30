import express from "express";
import { chromium } from "playwright";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());

const csrsFolder = path.join(process.cwd(), "csrs");
if (!fs.existsSync(csrsFolder)) fs.mkdirSync(csrsFolder, { recursive: true });

const erroresFolder = path.join(csrsFolder, "errores");
if (!fs.existsSync(erroresFolder))
  fs.mkdirSync(erroresFolder, { recursive: true });

async function guardarEvidenciaError(page, nombreBase = "error") {
  try {
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .split("Z")[0];

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

    console.log(`🧾 Evidencia guardada: ${screenshotPath} y ${htmlPath}`);
  } catch (err) {
    console.error("Error al guardar evidencia:", err.message);
  }
}

// === Función para manejar modal y popup ===
async function manejarModalYPopup(page) {
  try {
    const modalButton = page.getByRole("button", { name: "Continuar" });
    await modalButton.waitFor({ state: "visible", timeout: 5000 });
    console.log("Modal detectado, haciendo click en Continuar...");
    await modalButton.click();
    await page.waitForTimeout(2000);
  } catch {
    console.log("No apareció el modal, continuando...");
  }
}

// === Función que ejecuta el flujo completo ===
async function generarCertificado({ cliente, CUIT, CUIL, clave }) {
  const año = new Date().getFullYear();

  const browser = await chromium.launch({ 
    headless: false,
    timeout: 60000
  });
  const context = await browser.newContext();
  const mainPage = await context.newPage();

  try {
    // === LOGIN AFIP ===
    await mainPage.goto("https://www.afip.gob.ar/landing/default.asp");
    const loginPopupPromise = mainPage.waitForEvent("popup");
    await mainPage.getByRole("link", { name: "Iniciar sesión" }).click();
    const loginPage = await loginPopupPromise;

    await loginPage.getByRole("spinbutton").fill(CUIL);
    await loginPage.getByRole("button", { name: "Siguiente" }).click();

    await loginPage.locator('input[type="password"]:visible').fill(clave);
    await loginPage.getByRole("button", { name: "Ingresar" }).click();

    await loginPage.waitForTimeout(1500);

    try {
      const errorVisible = await loginPage.locator("span#F1\\:msg").isVisible();
      if (errorVisible) {
        const texto = await loginPage.locator("span#F1\\:msg").textContent();
        await guardarEvidenciaError(loginPage, "error_login");
        throw new Error("Error de login: " + texto?.trim());
      }
    } catch (error) {
      await guardarEvidenciaError(loginPage, "error_verificando_login");
      throw new Error("Error verificando el login: " + error.message);
    }

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
      await guardarEvidenciaError(loginPage, "captcha_detectado");
      await browser.close();
      throw new Error("Captcha detectado");
    } else {
      console.log("✅ No se detectó captcha, continuando con login...");
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

    execSync(`openssl genrsa -out "${clavePrivada}" 2048`);
    execSync(
      `openssl req -new -key "${clavePrivada}" ` +
        `-subj "/C=AR/O= ${razonSocial2} SAS/CN=Sistema de Gestion/serialNumber=CUIT ${CUIT}" ` +
        `-out "${csrPath}"`
    );

    // === BLOQUE CERTIFICADOS DIGITALES ===
    console.log("=== INICIANDO BLOQUE CERTIFICADOS DIGITALES ===");

    let currentPage = loginPage;

    const selectoresBuscador = [
      'input[placeholder*="buscar"]',
      'input[name*="search"]',
      'input[aria-label*="buscador"]',
      'input[type="search"]',
      "input#buscador",
      "input.buscador",
    ];


    let campoBuscador = null;
    for (const selector of selectoresBuscador) {
      campoBuscador = currentPage.locator(selector);
      if ((await campoBuscador.count()) > 0) {
        console.log(`✅ Campo buscador encontrado con selector: ${selector}`);
        break;
      }
    }

    // Si no encontramos con selectores específicos, intentamos con getByRole
    if (!campoBuscador || (await campoBuscador.count()) === 0) {
      console.log("🔍 Intentando con getByRole...");
      try {
        campoBuscador = currentPage.getByRole("combobox", { name: "Buscador" });
        await campoBuscador.waitFor({ state: "visible", timeout: 10000 });
      } catch (error) {
        console.log("❌ No se pudo encontrar el campo buscador con getByRole");
        await guardarEvidenciaError(
          currentPage,
          "campo_buscador_no_encontrado"
        );
        throw new Error(
          "No se pudo encontrar el campo de búsqueda en la página principal de AFIP"
        );
      }
    }


    // Buscar el campo de búsqueda nuevamente
    campoBuscador = null;
    for (const selector of selectoresBuscador) {
      campoBuscador = currentPage.locator(selector);
      if ((await campoBuscador.count()) > 0) {
        console.log(`✅ Campo buscador encontrado con selector: ${selector}`);
        break;
      }
    }

    if (!campoBuscador || (await campoBuscador.count()) === 0) {
      try {
        campoBuscador = currentPage.getByRole("combobox", { name: "Buscador" });
        await campoBuscador.waitFor({ state: "visible", timeout: 10000 });
      } catch (error) {
        console.log("❌ No se pudo encontrar el campo buscador con getByRole");
        await guardarEvidenciaError(
          currentPage,
          "campo_buscador_no_encontrado_cert"
        );
        throw new Error(
          "No se pudo encontrar el campo de búsqueda para certificados"
        );
      }
    }
    

    // Escribir en el campo de búsqueda para certificados
    await campoBuscador.click();
    await campoBuscador.fill("certificados digitales");
    await currentPage.waitForTimeout(3000);

    // Buscar y hacer click en el enlace de administración de certificados
    try {
      const certificadosLink = currentPage
        .locator('a:has-text("Administración de Certificados")')
        .first();
      await certificadosLink.waitFor({ state: "visible", timeout: 10000 });
      console.log("Enlace de certificados encontrado, haciendo click...");
      await certificadosLink.click();
      await currentPage.waitForTimeout(2000);
    } catch (error) {
      console.log(
        "No se encontró el enlace directo, intentando alternativas..."
      );
      try {
        const linkAlternativo = currentPage
          .locator('a:has-text("Administración de")')
          .first();
        await linkAlternativo.click();
        await currentPage.waitForTimeout(2000);
      } catch (error2) {
        await guardarEvidenciaError(currentPage, "error_acceso_certificados");
        throw new Error("No se pudo acceder a los certificados digitales");
      }
    }

    // --- LLAMADA A NUESTRA FUNCIÓN DE MODAL Y POPUP ---
    await manejarModalYPopup(currentPage);

    // --- Esperar popup o fallback manual ---
    let adminCertPage;
    try {
      adminCertPage = await currentPage.waitForEvent("popup", {
        timeout: 15000,
      });
      console.log("Popup de certificados digitales abierto correctamente");
    } catch {
      const currentUrl = currentPage.url();
      console.log("URL actual después del click:", currentUrl);

      if (currentUrl.includes("certificados") || currentUrl.includes("cot")) {
        adminCertPage = currentPage;
      } else {
        await currentPage.goto(
          "https://serviciosweb.afip.gob.ar/clavefiscal/adminrel/verCertificado.aspx"
        );
        adminCertPage = currentPage;
      }
    }

    const pages1 = context.pages();
    if (pages1.length >= 3) {
      await pages1[2].close();
      console.log("Tercera pestaña cerrada ✅");
    } else {
      console.log("No hay 3 pestañas abiertas ❌");
    }

    await adminCertPage.waitForLoadState("domcontentloaded");
    await adminCertPage.waitForTimeout(5000);

    console.log("✅ BLOQUE CERTIFICADOS DIGITALES COMPLETADO");

    // --- FLUJO DE GESTIÓN DE CERTIFICADOS ---
    if (
      (await adminCertPage.locator('text="No se puede encontrar"').count()) > 0
    ) {
      await guardarEvidenciaError(adminCertPage, "pagina_no_encontrada");
      throw new Error("La página de administración no cargó correctamente");
    }

    try {
      await adminCertPage.waitForTimeout(3000);
      const botonesIngresar = [
        "#cmdIngresar",
        'input[type="submit"][value*="Ingresar"]',
        'button:has-text("Ingresar")',
        'a:has-text("Ingresar")',
        'input[value="Ingresar"]',
      ];

      let botonEncontrado = false;
      for (const selector of botonesIngresar) {
        const boton = adminCertPage.locator(selector);
        if ((await boton.count()) > 0) {
          console.log(`Botón encontrado con selector: ${selector}`);
          await boton.click();
          botonEncontrado = true;
          await adminCertPage.waitForTimeout(3000);
          break;
        }
      }

      if (!botonEncontrado) {
        const aliasInput = adminCertPage.locator("#txtAliasCertificado");
        if ((await aliasInput.count()) > 0) {
          console.log("Ya estamos en el formulario de gestión");
        } else {
          await guardarEvidenciaError(adminCertPage, "boton_no_encontrado");
          throw new Error(
            "No se pudo encontrar el botón para ingresar al formulario"
          );
        }
      }

      await adminCertPage.waitForTimeout(2000);

      const alias = `TRIZAP_${cliente}_${año}_${Date.now()}`;
      await adminCertPage.locator("#txtAliasCertificado").fill(alias);
      console.log("Alias completado:", alias);

      await adminCertPage.locator('input[type="file"]').setInputFiles(csrPath);
      console.log("Archivo CSR subido");

      await adminCertPage.locator("#cmdIngresar").click();
      console.log("Formulario enviado");

      await adminCertPage.waitForTimeout(5000);

      await adminCertPage.locator('a:has-text("Ver")').first().click();
      await adminCertPage.waitForTimeout(3000);

      const downloadPromise = adminCertPage.waitForEvent("download");
      await adminCertPage.getByRole("button", { name: "Descargar" }).click();
      const download = await downloadPromise;

      const crtPath = path.join(
        csrsFolder,
        `CertificadoDN_${razonSocial2}_${año}.crt`
      );
      await download.saveAs(crtPath);
      console.log("Certificado descargado:", crtPath);
      // === BLOQUE RELACIONES 2 (Administración de relaciones final) ===
      console.log("=== INICIANDO BLOQUE RELACIONES 2 ===");

      // VOLVER A LA PÁGINA PRINCIPAL ANTES DE BUSCAR ADMINISTRADOR DE RELACIONES
      console.log("🔄 Volviendo a la página principal para relaciones 2...");
      await mainPage.goto("https://portalcf.cloud.afip.gob.ar/portal/app/");
      await mainPage.waitForTimeout(3000);

      await mainPage.getByRole("combobox", { name: "Buscador" }).click();
      await mainPage.getByRole("combobox", { name: "Buscador" }).fill("admini");

      const adminRelPopupPromise = mainPage.waitForEvent("popup");
      await mainPage
        .getByRole("link", { name: "Administrador de Relaciones" })
        .click();
      const adminRelPage = await adminRelPopupPromise;

      await adminRelPage.locator("#cmdNuevaRelacion").click();
      await adminRelPage
        .getByRole("button", { name: "Modificar el Servicio" })
        .click();
      await adminRelPage
        .getByRole("img", { name: "Agencia de Recaudación y Control Aduanero" })
        .click({ force: true });

      // === PARTE CORREGIDA - CLICK EN WEBSERVICES ===
      console.log("⏳ Esperando y haciendo click en WebServices...");

      // Esperar a que el elemento esté disponible y visible
      await adminRelPage.waitForTimeout(2000);

      // Intentar hacer click en WebServices con diferentes estrategias
      try {
        // Estrategia 1: Usar el selector exacto del elemento
        const webServicesCell = adminRelPage.locator(
          'td[colspan="2"]:has-text("WebServices")'
        );
        await webServicesCell.waitFor({ state: "visible", timeout: 10000 });
        await webServicesCell.click();
        console.log("✅ WebServices clickeado con selector específico");
      } catch (error) {
        console.log("❌ Primera estrategia falló, intentando alternativa...");

        // Estrategia 2: Usar evaluación JavaScript para forzar el click
        const clickSuccess = await adminRelPage.evaluate(() => {
          const elements = document.querySelectorAll('td[colspan="2"]');
          for (const element of elements) {
            if (element.textContent?.includes("WebServices")) {
              element.click();
              return true;
            }
          }
          return false;
        });

        if (clickSuccess) {
          console.log("✅ WebServices clickeado via JavaScript");
        } else {
          // Estrategia 3: Buscar por texto sin exactitud
          await adminRelPage
            .locator('td:has-text("WebServices")')
            .first()
            .click({ force: true });
          console.log("✅ WebServices clickeado con force");
        }
      }

      await adminRelPage.waitForTimeout(5000);

      await adminRelPage
        .getByRole("link", { name: "Facturación Electrónica" })
        .click({ force: true });
      await adminRelPage
        .getByRole("button", { name: "Buscar representante para la" })
        .click();

      // === SELECCIÓN DEL COMPUTADOR ADMINISTRADO ===
      console.log("⏳ Esperando selector de computadores administrados...");

      // Esperar a que el select esté disponible
      await adminRelPage.waitForSelector("#cboComputadoresAdministrados", {
        timeout: 15000,
      });

      // Hacer click para abrir el dropdown
      await adminRelPage.click("#cboComputadoresAdministrados");
      await adminRelPage.waitForTimeout(1000);

      // Seleccionar la primera opción
      console.log(
        "📝 Seleccionando primera opción del computador administrado..."
      );
      await adminRelPage.selectOption("#cboComputadoresAdministrados", {
        index: 1,
      });

      // Esperar a que se procese la selección
      await adminRelPage.waitForTimeout(2000);

      // Continuar con el flujo normal...
      await adminRelPage.locator("#cmdSeleccionarServicio").click();

      // PRIMERA CONFIRMACIÓN
      console.log("⏳ Esperando primer botón de confirmación...");
      await adminRelPage.waitForSelector("#cmdGenerarRelacion", {
        timeout: 15000,
        state: "visible",
      });
      await adminRelPage.click("#cmdGenerarRelacion");
      console.log("✅ Primer confirmación clickeada");

      // Esperar a que procese y aparezca la SEGUNDA confirmación
      await adminRelPage.waitForTimeout(5000);

      // Esperar a que se genere la relación completamente
      await adminRelPage.waitForTimeout(5000);
      console.log("✅ BLOQUE RELACIONES 2 COMPLETADO");

      const pfxPath = path.join(
        csrsFolder,
        `${cliente}_${razonSocial2}_${año}.pfx`
      );
      execSync(
        `openssl pkcs12 -export -out "${pfxPath}" -inkey "${clavePrivada}" -in "${crtPath}" -passout pass:`
      );
      console.log("Archivo PFX generado:", pfxPath);

      try {
        if (fs.existsSync(clavePrivada)) fs.unlinkSync(clavePrivada);
        if (fs.existsSync(csrPath)) fs.unlinkSync(csrPath);
        if (fs.existsSync(crtPath)) fs.unlinkSync(crtPath);
      } catch (err) {
        console.error("Error eliminando archivos temporales:", err.message);
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
      await guardarEvidenciaError(adminCertPage, "error_admin_certificados");
      await browser.close();
      throw new Error(`Error en la gestión de certificados: ${error.message}`);
    }
  } catch (error) {
    await guardarEvidenciaError(mainPage, "error_general");
    await browser.close();
    throw error;
  }
}

// === Endpoint API ===
app.get("/api/ping", (req, res) => res.json({ mensaje: "pong" }));

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
