import express from "express";
import { chromium } from "playwright";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());

// === Función que ejecuta todo el flujo ===
async function generarCertificado({ CUIT, CUIL, clave }) {
  const año = new Date().getFullYear();
  const csrsFolder = path.join(process.cwd(), "csrs");
  if (!fs.existsSync(csrsFolder)) fs.mkdirSync(csrsFolder, { recursive: true });

  const browser = await chromium.launch({ headless: false }); // poner true en server
  const context = await browser.newContext();
  const page = await context.newPage();

  // === Ir a AFIP ===
  await page.goto("https://www.afip.gob.ar/landing/default.asp");

  // === Login ===
  const loginPopupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Iniciar sesión" }).click();
  const loginPage = await loginPopupPromise;

  await loginPage.getByRole("spinbutton").fill(CUIL);
  await loginPage.getByRole("button", { name: "Siguiente" }).click();
  await loginPage.locator('input[type="password"]:visible').fill(clave);
  await loginPage.getByRole("button", { name: "Ingresar" }).click();

  // === Obtener razón social ===
  const razonSocial = (await loginPage
    .locator("nav#cabeceraAFIPlogoNegro strong.text-primary")
    .textContent())?.trim();

  if (!razonSocial) throw new Error("No se pudo obtener la razón social.");
  const razonSocial2 = razonSocial.replace(/\s+/g, "_");

  const clavePrivada = path.join(csrsFolder, `MiClavePrivada_${razonSocial2}_${año}.key`);
  const csrPath = path.join(csrsFolder, `MiPedidoCSR_${razonSocial2}_${año}.csr`);

  // === Generar clave privada y CSR ===
  execSync(`openssl genrsa -out "${clavePrivada}" 2048`);
  execSync(
    `openssl req -new -key "${clavePrivada}" ` +
      `-subj "/C=AR/O=Agencia ${razonSocial2} SAS/CN=Sistema de Gestion/serialNumber=CUIT ${CUIT}" ` +
      `-out "${csrPath}"`
  );

  // === Administración de certificados digitales ===
  await loginPage.getByRole('link', { name: 'Administración de Certificados Digitales' }).click();
  await loginPage.waitForTimeout(2000);

  // === Manejo modal "Agregar Servicio" dentro de iframe ===
  try {
    console.log("🔍 Buscando modal 'Agregar Servicio' dentro de iframe...");

    // Ajusta la URL o nombre del iframe según corresponda
    const modalFrame = page.frames().find(f => f.url().includes('certificados'));
    
    if (modalFrame) {
      const boton = modalFrame.locator('button', { hasText: 'Continuar' }).first();
      if ((await boton.count()) > 0) {
        await boton.click({ force: true });
        console.log("✅ Botón 'Continuar' clickeado dentro del iframe.");
        await loginPage.waitForTimeout(2000);
      } else {
        console.log("ℹ️ Botón 'Continuar' no apareció en el iframe, seguimos flujo.");
      }
    } else {
      console.log("ℹ️ No se encontró iframe del modal, seguimos flujo normal.");
    }
  } catch (e) {
    console.log("⚠️ Error manejando el modal en iframe, seguimos flujo:", e);
  }

  // === Subir CSR y crear alias ===
  const alias = `CERTIFICADO_${razonSocial2}_${Date.now()}`;
  await loginPage.locator("#txtAliasCertificado").fill(alias);
  await loginPage.locator('input[type="file"]').setInputFiles(csrPath);
  await loginPage.waitForTimeout(1500);

  await loginPage.locator("#cmdIngresar").click();
  await loginPage.waitForTimeout(2000);

  const aliasRows = loginPage.locator("table tr td:first-child");
  await aliasRows.last().waitFor({ state: "visible", timeout: 10000 });
  const lastAlias = await aliasRows.last().textContent();
  console.log("Último alias creado:", lastAlias?.trim());

  // === Descargar CRT ===
  await loginPage.getByRole("link", { name: "Ver" }).nth(0).click();
  await loginPage.waitForTimeout(2000);

  const downloadPromise = loginPage.waitForEvent("download");
  await loginPage.getByRole("button", { name: "Descargar" }).click();
  const download = await downloadPromise;

  const crtPath = path.join(csrsFolder, `CertificadoDN_${razonSocial2}_${año}.crt`);
  await download.saveAs(crtPath);
  console.log(`CRT descargado: ${crtPath}`);

  // === Generar PFX ===
  const pfxPath = path.join(csrsFolder, `Certificado_${razonSocial2}_${año}.pfx`);
  execSync(`openssl pkcs12 -export -out "${pfxPath}" -inkey "${clavePrivada}" -in "${crtPath}" -passout pass:`);
  console.log(`PFX generado: ${pfxPath}`);

  await browser.close();

  return {
    razonSocial,
    clavePrivada,
    csrPath,
    crtPath,
    pfxPath,
    alias: lastAlias?.trim(),
    mensaje: "CSR, CRT y PFX generados correctamente",
  };
}

// === API ===
app.post("/api/certificado", async (req, res) => {
  try {
    const { CUIT, CUIL, clave } = req.body;
    if (!CUIT || !CUIL || !clave) {
      return res.status(400).json({ error: "Faltan parámetros: CUIT, CUIL, clave" });
    }

    const resultado = await generarCertificado({ CUIT, CUIL, clave });
    res.json(resultado);
  } catch (err) {
    console.error("Error en generarCertificado:", err);
    res.status(500).json({ error: err.message });
  }
});

// === Iniciar server ===
app.listen(3000, () => {
  console.log("API corriendo en http://localhost:3000");
});
