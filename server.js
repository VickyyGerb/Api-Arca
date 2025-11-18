import express from "express";
import { chromium } from "playwright";
import { execSync, spawnSync } from "child_process";
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
    timeout: 60000,
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

    await campoBuscador.click();
    await campoBuscador.fill("certificados digitales");
    await currentPage.waitForTimeout(3000);

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

    await manejarModalYPopup(currentPage);

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

      console.log("🔄 Buscando botón para enviar formulario...");

      let formularioEnviado = false;
      const selectoresEnviar = [
        "#cmdIngresar",
        'input[type="submit"]',
        'button[type="submit"]',
        'input[value*="Enviar"]',
        'button:has-text("Enviar")',
        'input[value*="Aceptar"]',
        'button:has-text("Aceptar")',
        'input[value*="Continuar"]',
        'button:has-text("Continuar")',
        'input[value*="Generar"]',
        'button:has-text("Generar")',
        'input[name="cmdIngresar"]',
        'button[name="cmdIngresar"]',
        ".btn-primary",
        ".btn-success",
        'input[onclick*="submit"]',
        'button[onclick*="submit"]',
      ];

      for (const selector of selectoresEnviar) {
        try {
          const boton = adminCertPage.locator(selector);
          if ((await boton.count()) > 0 && (await boton.isVisible())) {
            console.log(`✅ Botón de envío encontrado: ${selector}`);
            await boton.click();
            formularioEnviado = true;
            console.log("✅ Formulario enviado");
            break;
          }
        } catch (error) {
          continue;
        }
      }

      if (!formularioEnviado) {
        console.log("🔍 Buscando botón por texto...");
        const textosBuscar = [
          "Enviar",
          "Aceptar",
          "Continuar",
          "Generar",
          "Ingresar",
          "Submit",
        ];

        for (const texto of textosBuscar) {
          try {
            const boton = adminCertPage.locator(`button:has-text("${texto}")`);
            if ((await boton.count()) > 0 && (await boton.isVisible())) {
              console.log(`✅ Botón encontrado por texto: "${texto}"`);
              await boton.click();
              formularioEnviado = true;
              console.log("✅ Formulario enviado");
              break;
            }
          } catch (error) {
            continue;
          }
        }
      }

      if (!formularioEnviado) {
        console.log("🔍 Buscando en inputs...");
        const textosInput = [
          "Enviar",
          "Aceptar",
          "Continuar",
          "Generar",
          "Ingresar",
        ];

        for (const texto of textosInput) {
          try {
            const input = adminCertPage.locator(`input[value*="${texto}"]`);
            if ((await input.count()) > 0 && (await input.isVisible())) {
              console.log(`✅ Input encontrado con valor: "${texto}"`);
              await input.click();
              formularioEnviado = true;
              console.log("✅ Formulario enviado");
              break;
            }
          } catch (error) {
            continue;
          }
        }
      }

      if (!formularioEnviado) {
        console.log("🔍 Intentando enviar via JavaScript...");
        const enviado = await adminCertPage.evaluate(() => {
          const forms = document.querySelectorAll("form");
          if (forms.length > 0) {
            forms[0].submit();
            return true;
          }

          const submitButtons = document.querySelectorAll(
            'input[type="submit"], button[type="submit"]'
          );
          if (submitButtons.length > 0) {
            submitButtons[0].click();
            return true;
          }

          const buttons = document.querySelectorAll(
            'button, input[type="button"]'
          );
          for (const button of buttons) {
            const text =
              button.textContent?.toLowerCase() ||
              button.value?.toLowerCase() ||
              "";
            if (
              text.includes("enviar") ||
              text.includes("aceptar") ||
              text.includes("continuar") ||
              text.includes("generar")
            ) {
              button.click();
              return true;
            }
          }

          return false;
        });

        if (enviado) {
          formularioEnviado = true;
          console.log("✅ Formulario enviado via JavaScript");
        }
      }

      if (!formularioEnviado) {
        await guardarEvidenciaError(adminCertPage, "error_enviar_formulario");
        throw new Error(
          "No se pudo encontrar el botón para enviar el formulario"
        );
      }

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
      console.log("=== INICIANDO BLOQUE RELACIONES ===");

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

      await adminRelPage.waitForTimeout(4000);

      try {
        await adminRelPage
          .locator('img[alt="Agencia de Recaudación y Control Aduanero"]')
          .click({ force: true, timeout: 5000 });
        console.log("✅ Click exitoso con selector alt exacto");
      } catch (error) {
        console.log("❌ Estrategia 1 falló, intentando estrategia 2...");
        try {
          await adminRelPage
            .locator('//img[@alt="Agencia de Recaudación y Control Aduanero"]')
            .click({ force: true, timeout: 5000 });
          console.log("✅ Click exitoso con XPath");
        } catch (error) {
          console.log("❌ Estrategia 2 falló, intentando estrategia 3...");
          try {
            await adminRelPage
              .locator('img[src*="afip"]')
              .click({ force: true, timeout: 5000 });
            console.log("✅ Click exitoso con selector src");
          } catch (error) {
            console.log(
              "❌ Estrategia 3 falló, intentando última estrategia..."
            );
            await adminRelPage.evaluate(() => {
              const img = document.querySelector(
                'img[alt="Agencia de Recaudación y Control Aduanero"]'
              );
              if (img) img.click();
            });
            console.log("✅ Click exitoso via JavaScript");
          }
        }
      }

      await adminRelPage.waitForTimeout(2000);

      try {
        const webServicesCell = adminRelPage.locator(
          'td[colspan="2"]:has-text("WebServices")'
        );
        await webServicesCell.waitFor({ state: "visible", timeout: 10000 });
        await webServicesCell.click();
        console.log("✅ WebServices clickeado con selector específico");
      } catch (error) {
        console.log("❌ Primera estrategia falló, intentando alternativa...");
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

      console.log("⏳ Esperando selector de computadores administrados...");
      await adminRelPage.waitForSelector("#cboComputadoresAdministrados", {
        timeout: 15000,
      });

      await adminRelPage.click("#cboComputadoresAdministrados");
      await adminRelPage.waitForTimeout(1000);
      console.log(
        "📝 Seleccionando primera opción del computador administrado..."
      );
      await adminRelPage.selectOption("#cboComputadoresAdministrados", {
        index: 1,
      });
      await adminRelPage.waitForTimeout(2000);
      await adminRelPage.locator("#cmdSeleccionarServicio").click();

      await adminRelPage.waitForSelector("#cmdGenerarRelacion", {
        timeout: 15000,
        state: "visible",
      });
      await adminRelPage.click("#cmdGenerarRelacion");
      console.log("✅ Primer confirmación clickeada");

      await adminRelPage.waitForTimeout(5000);
      await adminRelPage.waitForTimeout(5000);
      console.log("✅ BLOQUE RELACIONES COMPLETADO");

      const opensslResult = spawnSync(
        "openssl",
        [
          "pkcs12",
          "-export",
          "-inkey",
          clavePrivada,
          "-in",
          crtPath,
          "-passout",
          "pass:",
        ],
        { encoding: "buffer" }
      );

      if (opensslResult.error) throw opensslResult.error;
      if (opensslResult.status !== 0)
        throw new Error(opensslResult.stderr.toString());

      const pfxBuffer = opensslResult.stdout;

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
        pfxBuffer,
        fileName: `${cliente}_${razonSocial2}_${año}.pfx`,
        mensaje: "Certificado generado correctamente y devuelto como descarga",
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

app.get("/api/ping", (req, res) => {
  console.log("✅ Ping recibido");
  res.json({ mensaje: "pong", status: "servidor activo" });
});

// Endpoint principal CORREGIDO
app.get("/api/certificado", async (req, res) => {
  console.log("📥 Solicitud recibida en /api/certificado");
  console.log("Query parameters:", req.query);

  try {
    const { cliente, CUIT, CUIL, clave } = req.query;

    if (!cliente || !CUIT || !CUIL || !clave) {
      console.log("❌ Parámetros faltantes");
      return res.status(400).json({
        error: "Faltan parámetros: cliente, CUIT, CUIL, clave",
        recibido: {
          cliente,
          CUIT,
          CUIL,
          clave: clave ? "PROVIDED" : "MISSING",
        },
      });
    }

    console.log("🔄 Iniciando generación de certificado...");

    const resultado = await generarCertificado({ cliente, CUIT, CUIL, clave });

    console.log("✅ Certificado generado exitosamente");
    console.log("📁 Archivo:", resultado.fileName);
    console.log("📏 Tamaño:", resultado.pfxBuffer.length, "bytes");

    res.setHeader("Content-Type", "application/x-pkcs12");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${resultado.fileName}"`
    );
    res.setHeader("Content-Length", resultado.pfxBuffer.length);

    // Enviar el buffer directamente
    res.send(resultado.pfxBuffer);
  } catch (err) {
    console.error("💥 Error en endpoint /api/certificado:", err.message);
    console.error("Stack trace:", err.stack);

    res.status(500).json({
      error: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
});

// Endpoint de prueba adicional
app.get("/api/test", (req, res) => {
  console.log("🧪 Test endpoint llamado");
  res.json({
    mensaje: "Test exitoso",
    timestamp: new Date().toISOString(),
    parametros: req.query,
  });
});

// Manejo de rutas no encontradas
app.use((req, res) => {
  console.log(`❌ Ruta no encontrada: ${req.method} ${req.url}`);
  res.status(404).json({
    error: "Endpoint no encontrado",
    ruta: req.url,
    metodo: req.method,
    endpoints_disponibles: [
      "GET /api/ping",
      "GET /api/certificado?cliente=...&CUIT=...&CUIL=...&clave=...",
      "GET /api/test",
    ],
  });
});

app.listen(3000, () => {
  console.log("🚀 API corriendo en http://localhost:3000");
  console.log("📋 Endpoints disponibles:");
  console.log("   GET  /api/ping");
  console.log(
    "   GET  /api/certificado?cliente=...&CUIT=...&CUIL=...&clave=..."
  );
  console.log("   GET  /api/test");
});
