import express from "express";
import { chromium } from "playwright";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());

// === Función que ejecuta el flujo ===
async function generarCertificado({ CUIT, CUIL, clave }) {
  const año = new Date().getFullYear();
  const csrsFolder = path.join(process.cwd(), "csrs");
  if (!fs.existsSync(csrsFolder)) fs.mkdirSync(csrsFolder, { recursive: true });

  const browser = await chromium.launch({ headless: false }); // ponelo true en server
  const context = await browser.newContext();
  const page = await context.newPage();

  // ⚠️ Este es solo un ejemplo, ajusta la URL inicial
  await page.goto("https://www.afip.gob.ar/landing/default.asp");

  // === LOGIN ===
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

  // === Generar CSR ===
  execSync(`openssl genrsa -out "${clavePrivada}" 2048`);
  execSync(
    `openssl req -new -key "${clavePrivada}" ` +
      `-subj "/C=AR/O=Agencia ${razonSocial2} SAS/CN=Sistema de Gestion/serialNumber=CUIT ${CUIT}" ` +
      `-out "${csrPath}"`
  );

  await loginPage
    .getByRole("combobox", { name: "Buscador" })
    .fill("certificados dig");
  const adminPopupPromise = loginPage.waitForEvent("popup");
  await loginPage.getByRole("link", { name: "Administración de" }).click();
  const adminPage = await adminPopupPromise;

  await adminPage.locator("#cmdIngresar").click();
  await adminPage.waitForTimeout(2000);

  // ===== Crear alias y subir CSR =====
  const alias = `CERTIFICADO${razonSocial2}_${Date.now()}`;
  const aliasInput = adminPage.locator("#txtAliasCertificado");
  await aliasInput.click();
  await aliasInput.fill(alias);

  const fileInput = adminPage.locator('input[type="file"]');
  await fileInput.setInputFiles(csrPath);

  await page.waitForTimeout(1500); // Esperar un segundo extra para que AFIP procese el archivo

  // ===== ESPERAR BOTÓN "Agregar alias" HABILITADO =====
  await adminPage.locator("#cmdIngresar").click();

  console.log("✅ Alias agregado correctamente.");

  await adminPage.waitForTimeout(2000);

  const aliasRows = adminPage.locator("table tr td:first-child"); // columna Alias
  await aliasRows.last().waitFor({ state: "visible", timeout: 10000 });

  const lastAlias = await aliasRows.last().textContent();
  console.log("Último alias creado:", lastAlias?.trim());

  // ===== Descargar el CRT correspondiente al último alias =====
  await adminPage.getByRole(`link`, { name: "Ver" }).nth(0).click();
  await adminPage.waitForTimeout(2000);
  const downloadPromise = adminPage.waitForEvent("download");
  await adminPage.getByRole("button", { name: "Descargar" }).click();
  const download = await downloadPromise;
  const crtPath = path.join(
    csrsFolder,
    `CertificadoDN_${razonSocial2}_${año}.crt`
  );
  await download.saveAs(crtPath);

  console.log(`CRT descargado correctamente: ${crtPath}`);
  // ===== Generar PFX a partir del CRT descargado =====
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
    clavePrivada,
    csrPath,
    crtPath,
    pfxPath,
    mensaje: "CSR generado correctamente",
  };
}

// === API ===
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
app.get("/", (req, res) => {
  res.send("🚀 API ARCA funcionando. Usá POST /api/certificado");
});

// === Iniciar server ===
app.listen(3000, () => {
  console.log("API corriendo en http://localhost:3000");
});
