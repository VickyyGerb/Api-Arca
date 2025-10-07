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
  if (!fs.existsSync(csrsFolder)) fs.mkdirSync(csrFolder, { recursive: true });

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

  // === Navegación a Administración de Certificados ===
  await loginPage
    .getByRole("combobox", { name: "Buscador" })
    .fill("certificados digitales");

  await loginPage.waitForTimeout(2000);

  let adminPage;

  // Estrategia 1: Intentar click directo en el servicio
  try {
    console.log("Buscando servicio de certificados...");

    // Esperar a que aparezcan los resultados
    await loginPage.waitForTimeout(3000);

    // Intentar diferentes selectores para encontrar el enlace
    const certificadosLink = loginPage
      .locator(
        'a:has-text("Administración de Certificados"), a:has-text("Certificados Digitales"), a:has-text("Administración de")'
      )
      .first();

    await certificadosLink.waitFor({ state: "visible", timeout: 10000 });
    console.log("Enlace de certificados encontrado, haciendo click...");

    const [popup] = await Promise.all([
      loginPage.waitForEvent("popup"),
      certificadosLink.click(),
    ]);

    adminPage = popup;
    console.log("Popup abierto exitosamente");
  } catch (error) {
    console.log("No se pudo abrir via enlace directo:", error.message);

    // Estrategia 2: Buscar en "Todos los servicios"
    try {
      console.log("Intentando via 'Todos los servicios'...");
      await loginPage
        .getByRole("link", { name: "Todos los servicios" })
        .click();
      await loginPage.waitForTimeout(2000);

      // Buscar certificados en todos los servicios
      await loginPage
        .getByRole("textbox", { name: "Buscar" })
        .fill("certificados digitales");
      await loginPage.waitForTimeout(2000);

      const servicioLink = loginPage
        .locator('a:has-text("Administración de Certificados")')
        .first();
      await servicioLink.waitFor({ state: "visible", timeout: 5000 });

      const [popup] = await Promise.all([
        loginPage.waitForEvent("popup"),
        servicioLink.click(),
      ]);

      adminPage = popup;
      console.log("Popup abierto via todos los servicios");
    } catch (error2) {
      console.log("No se pudo abrir via todos los servicios:", error2.message);
      throw new Error("No se pudo acceder a la administración de certificados");
    }
  }

  // === Esperar y verificar la página de administración ===
  await adminPage.waitForLoadState("domcontentloaded");
  await adminPage.waitForTimeout(3000);

  console.log("URL actual:", adminPage.url());
  console.log("Título:", await adminPage.title());

  // Verificar si estamos en la página correcta
  const currentUrl = adminPage.url();
  if (!currentUrl.includes("afip.gov.ar")) {
    throw new Error("No se pudo cargar la página de AFIP correctamente");
  }

  // === Manejar diferentes escenarios en la página de administración ===
  try {
    // Esperar a que cargue algún elemento identificable de la página
    await adminPage.waitForTimeout(5000);

    // Buscar el botón de ingresar con diferentes selectores
    const ingresarSelectors = [
      "#cmdIngresar",
      'input[type="submit"][value*="Ingresar"]',
      'button:has-text("Ingresar")',
      'a:has-text("Ingresar")',
      'input[value="Ingresar"]',
      '.btn:has-text("Ingresar")',
      'button[onclick*="ingresar"]',
    ];

    let ingresarButtonFound = false;

    for (const selector of ingresarSelectors) {
      try {
        const button = adminPage.locator(selector);
        if ((await button.count()) > 0 && (await button.isVisible())) {
          console.log(`Botón encontrado con selector: ${selector}`);
          await button.click();
          ingresarButtonFound = true;
          break;
        }
      } catch (error) {
        // Continuar con el siguiente selector
        continue;
      }
    }

    if (!ingresarButtonFound) {
      // Si no encontramos botón específico, verificar si ya estamos en la página de gestión
      const gestionElements = [
        "#txtAliasCertificado",
        'input[type="file"]',
        'input[name="alias"]',
        'input[placeholder*="alias"]',
      ];

      for (const selector of gestionElements) {
        if ((await adminPage.locator(selector).count()) > 0) {
          console.log("Ya estamos en la página de gestión de certificados");
          ingresarButtonFound = true;
          break;
        }
      }
    }

    if (!ingresarButtonFound) {
      throw new Error(
        "No se pudo encontrar el botón para ingresar a la gestión"
      );
    }
  } catch (error) {
    console.log("Error al interactuar con la página:", error);
    throw new Error(
      `No se pudo acceder a la gestión de certificados: ${error.message}`
    );
  }

  // === Esperar a que cargue el formulario de certificados ===
  await adminPage.waitForTimeout(3000);

  // Verificar que estamos en el formulario correcto
  const aliasInput = adminPage
    .locator(
      '#txtAliasCertificado, input[name="alias"], input[placeholder*="alias"]'
    )
    .first();
  await aliasInput.waitFor({ state: "visible", timeout: 10000 });

  // === Crear alias y subir CSR ===
  const alias = `CERTIFICADO${razonSocial2}_${Date.now()}`;
  await aliasInput.fill(alias);

  // Buscar el input file
  const fileInput = adminPage.locator('input[type="file"]');
  await fileInput.setInputFiles(csrPath);

  // Buscar y hacer click en el botón de enviar/subir
  const submitSelectors = [
    "#cmdIngresar",
    'input[type="submit"]',
    'button[type="submit"]',
    'button:has-text("Enviar")',
    'button:has-text("Subir")',
    'button:has-text("Aceptar")',
    ".btn-primary",
  ];

  let submitted = false;
  for (const selector of submitSelectors) {
    try {
      const button = adminPage.locator(selector);
      if ((await button.count()) > 0 && (await button.isVisible())) {
        console.log(`Enviando formulario con selector: ${selector}`);
        await button.click();
        submitted = true;
        break;
      }
    } catch (error) {
      continue;
    }
  }

  if (!submitted) {
    throw new Error("No se pudo encontrar el botón para enviar el formulario");
  }

  // === Esperar procesamiento y descargar CRT ===
  await adminPage.waitForTimeout(5000);

  // Buscar enlace o botón para ver/descargar
  const viewSelectors = [
    'a:has-text("Ver")',
    'a:has-text("Descargar")',
    'button:has-text("Ver")',
    'button:has-text("Descargar")',
    '.btn:has-text("Ver")',
  ];

  let viewClicked = false;
  for (const selector of viewSelectors) {
    try {
      const viewButton = adminPage.locator(selector).first();
      if ((await viewButton.count()) > 0 && (await viewButton.isVisible())) {
        console.log(
          `Haciendo click en Ver/Descargar con selector: ${selector}`
        );
        await viewButton.click();
        viewClicked = true;
        await adminPage.waitForTimeout(3000);
        break;
      }
    } catch (error) {
      continue;
    }
  }

  if (!viewClicked) {
    throw new Error(
      "No se pudo encontrar el botón para ver/descargar el certificado"
    );
  }

  // Descargar el certificado
  const downloadPromise = adminPage.waitForEvent("download");

  const downloadSelectors = [
    'button:has-text("Descargar")',
    'a:has-text("Descargar")',
    'input[value*="Descargar"]',
    '.btn:has-text("Descargar")',
  ];

  let downloadClicked = false;
  for (const selector of downloadSelectors) {
    try {
      const downloadButton = adminPage.locator(selector).first();
      if (
        (await downloadButton.count()) > 0 &&
        (await downloadButton.isVisible())
      ) {
        console.log(`Descargando con selector: ${selector}`);
        await downloadButton.click();
        downloadClicked = true;
        break;
      }
    } catch (error) {
      continue;
    }
  }

  if (!downloadClicked) {
    throw new Error("No se pudo encontrar el botón de descarga");
  }

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
    mensaje: "Certificado generado correctamente",
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
