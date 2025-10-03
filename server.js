import express from "express";
import { chromium } from "playwright";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());

// === Función que ejecuta el flujo completo ===
async function generarCertificado({ CUIT, CUIL, clave }) {
  const año = new Date().getFullYear();
  const csrsFolder = path.join(process.cwd(), "csrs");
  if (!fs.existsSync(csrsFolder)) fs.mkdirSync(csrsFolder, { recursive: true });

  const browser = await chromium.launch({ headless: false }); // cambiar a true en server
  const context = await browser.newContext();
  const page = await context.newPage();

  // === LOGIN AFIP ===
  await page.goto("https://www.afip.gob.ar/landing/default.asp");
  const loginPopupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Iniciar sesión" }).click();
  const loginPage = await loginPopupPromise;

  await loginPage.getByRole("spinbutton").fill(CUIL);
  await loginPage.getByRole("button", { name: "Siguiente" }).click();
  await loginPage.locator('input[type="password"]:visible').fill(clave);
  await loginPage.getByRole("button", { name: "Ingresar" }).click();

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

  await loginPage
    .getByRole("combobox", { name: "Buscador" })
    .fill("certificados dig");

  await loginPage.waitForTimeout(1000);

  // Click en Administración de Certificados (NO esperar popup todavía)
  try {
    await loginPage.getByRole("link", { name: "Administración de" }).click();
  } catch (error) {
    await loginPage.locator('a:has-text("Agregar servicio")').first().click();
  }

  await loginPage.waitForTimeout(1000);

  // === Manejar modal opcional "Agregar Servicio" y popup ===
  let adminPage;

  const modalContinuar = loginPage.getByRole("button", { name: "Continuar" });

  try {
    // Espera hasta 5 segundos a que aparezca el botón del modal
    await modalContinuar.waitFor({ state: "visible", timeout: 5000 });
    console.log("Modal 'Agregar Servicio' detectado, haciendo click...");
    await modalContinuar.click({ force: true }); // fuerza el click

    // Esperar popup que se abre tras aceptar el modal
    try {
      adminPage = await loginPage.waitForEvent("popup", { timeout: 10000 });
      console.log("Popup abierto tras aceptar modal");
    } catch {
      console.log(
        "No se abrió popup tras modal, continuando en la misma página..."
      );
      adminPage = loginPage; // si no hay popup, seguir en la misma página
    }
  } catch {
    console.log("Modal no apareció, intentando popup directo...");
    // Si no aparece el modal, esperar popup normal
    try {
      adminPage = await loginPage.waitForEvent("popup", { timeout: 10000 });
      console.log("Popup abierto directamente");
    } catch {
      console.log("No se abrió popup, continuando en la misma página...");
      adminPage = loginPage; // si tampoco hay popup, seguir en la misma página
    }
  }

  // Esperar a que la página del admin cargue
  await adminPage.waitForLoadState("domcontentloaded");
  await adminPage.waitForTimeout(2000);

  await adminPage.locator("#cmdIngresar").click();
  await adminPage.waitForTimeout(2000);

  // === Crear alias y subir CSR ===
  const alias = `CERTIFICADO${razonSocial2}_${Date.now()}`;
  await adminPage.locator("#txtAliasCertificado").fill(alias);
  await adminPage.locator('input[type="file"]').setInputFiles(csrPath);

  await adminPage.locator("#cmdIngresar").click();
  await adminPage.waitForTimeout(2000);

  // === Descargar CRT ===
  await adminPage.getByRole("link", { name: "Ver" }).nth(0).click();
  await adminPage.waitForTimeout(2000);
  const downloadPromise = adminPage.waitForEvent("download");
  await adminPage.getByRole("button", { name: "Descargar" }).click();
  const download = await downloadPromise;
  const crtPath = path.join(
    csrsFolder,
    `CertificadoDN_${razonSocial2}_${año}.crt`
  );
  await download.saveAs(crtPath);

  // === Generar PFX ===
  const pfxPath = path.join(
    csrsFolder,
    `Certificado_${razonSocial2}_${año}.pfx`
  );
  execSync(
    `openssl pkcs12 -export -out "${pfxPath}" -inkey "${clavePrivada}" -in "${crtPath}" -passout pass:`
  );

  await browser.close();

  return {
    razonSocial,
    alias,
    clavePrivada,
    csrPath,
    crtPath,
    pfxPath,
    mensaje: "CSR y PFX generados correctamente",
  };
}

// === Endpoint API ===
app.post("/api/certificado", async (req, res) => {
  try {
    const { CUIT, CUIL, clave } = req.body;
    if (!CUIT || !CUIL || !clave) {
      return res
        .status(400)
        .json({ error: "Faltan parámetros: CUIT, CUIL, clave" });
    }

    const resultado = await generarCertificado({ CUIT, CUIL, clave });
    res.json(resultado);
  } catch (err) {
    console.error("Error en generarCertificado:", err);
    res.status(500).json({ error: err.message });
  }
});

// === Iniciar servidor ===
app.listen(3000, () => {
  console.log("API corriendo en http://localhost:3000");
});
