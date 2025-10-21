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

// === Función utilitaria para guardar evidencia de errores ===
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

// === Función que ejecuta el flujo completo ===
async function generarCertificado({ cliente, CUIT, CUIL, clave }) {
  const año = new Date().getFullYear();

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // === LOGIN AFIP ===
    await page.goto("https://www.afip.gob.ar/landing/default.asp");
    const loginPopupPromise = page.waitForEvent("popup");
    await page.getByRole("link", { name: "Iniciar sesión" }).click();
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
        `-subj "/C=AR/O=Agencia ${razonSocial2} SAS/CN=Sistema de Gestion/serialNumber=CUIT ${CUIT}" ` +
        `-out "${csrPath}"`
    );

    console.log("Buscando servicio de certificados digitales...");

    await loginPage
      .getByRole("combobox", { name: "Buscador" })
      .fill("certificados digitales");
    await loginPage.waitForTimeout(3000);

    let adminPage;

    try {
      const certificadosLink = loginPage
        .locator('a:has-text("Administración de Certificados")')
        .first();
      await certificadosLink.waitFor({ state: "visible", timeout: 10000 });
      console.log("Enlace de certificados encontrado, haciendo click...");
      await certificadosLink.click();
      await loginPage.waitForTimeout(2000);
    } catch (error) {
      console.log(
        "No se encontró el enlace directo, intentando alternativas..."
      );
      try {
        const linkAlternativo = loginPage
          .locator('a:has-text("Administración de")')
          .first();
        await linkAlternativo.click();
        await loginPage.waitForTimeout(2000);
      } catch (error2) {
        await guardarEvidenciaError(loginPage, "error_acceso_certificados");
        throw new Error("No se pudo acceder a los certificados digitales");
      }
    }

    let modalAparecio = false;
    try {
      const modalButton = loginPage.getByRole("button", { name: "Continuar" });
      await modalButton.waitFor({ state: "visible", timeout: 5000 });
      console.log("Modal detectado, haciendo click en Continuar...");
      await modalButton.click();
      modalAparecio = true;
      await loginPage.waitForTimeout(2000);
    } catch {
      console.log("No apareció el modal, continuando...");
    }

    try {
      adminPage = await loginPage.waitForEvent("popup", { timeout: 15000 });
      console.log("Popup de administración abierto correctamente");
    } catch {
      const currentUrl = loginPage.url();
      console.log("URL actual después del click:", currentUrl);

      if (currentUrl.includes("certificados") || currentUrl.includes("cot")) {
        adminPage = loginPage;
      } else {
        await loginPage.goto(
          "https://serviciosweb.afip.gob.ar/clavefiscal/adminrel/verCertificado.aspx"
        );
        adminPage = loginPage;
      }
    }

    await adminPage.waitForLoadState("domcontentloaded");
    await adminPage.waitForTimeout(5000);

    if ((await adminPage.locator('text="No se puede encontrar"').count()) > 0) {
      await guardarEvidenciaError(adminPage, "pagina_no_encontrada");
      throw new Error("La página de administración no cargó correctamente");
    }

    try {
      await adminPage.waitForTimeout(3000);
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
        const aliasInput = adminPage.locator("#txtAliasCertificado");
        if ((await aliasInput.count()) > 0) {
          console.log("Ya estamos en el formulario de gestión");
        } else {
          await guardarEvidenciaError(adminPage, "boton_no_encontrado");
          throw new Error(
            "No se pudo encontrar el botón para ingresar al formulario"
          );
        }
      }

      await adminPage.waitForTimeout(2000);

      const alias = `TRIZAP_${cliente}_${año}_${Date.now()}`;
      await adminPage.locator("#txtAliasCertificado").fill(alias);
      console.log("Alias completado:", alias);

      await adminPage.locator('input[type="file"]').setInputFiles(csrPath);
      console.log("Archivo CSR subido");

      await adminPage.locator("#cmdIngresar").click();
      console.log("Formulario enviado");

      await adminPage.waitForTimeout(5000);

      await adminPage.locator('a:has-text("Ver")').first().click();
      await adminPage.waitForTimeout(3000);

      const downloadPromise = adminPage.waitForEvent("download");
      await adminPage.getByRole("button", { name: "Descargar" }).click();
      const download = await downloadPromise;

      const crtPath = path.join(
        csrsFolder,
        `CertificadoDN_${razonSocial2}_${año}.crt`
      );
      await download.saveAs(crtPath);
      console.log("Certificado descargado:", crtPath);

      const pfxPath = path.join(
        csrsFolder,
        `${cliente}_${razonSocial2}_${año}.pfx`
      );
      execSync(
        `openssl pkcs12 -export -out "${pfxPath}" -inkey "${clavePrivada}" -in "${crtPath}"`
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
      await guardarEvidenciaError(adminPage, "error_admin_certificados");
      await browser.close();
      throw new Error(`Error en la gestión de certificados: ${error.message}`);
    }
  } catch (error) {
    await guardarEvidenciaError(page, "error_general");
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
