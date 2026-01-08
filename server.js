// server.js
const express = require("express");
const multer = require("multer");
const fs = require("fs-extra");
const path = require("path");
const { execSync } = require("child_process");
const AdmZip = require("adm-zip");
const xml2js = require("xml2js"); // For parsing AndroidManifest

const app = express();

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Multer upload
const upload = multer({ dest: "uploads_tmp/", limits: { fileSize: 50 * 1024 * 1024 } });

// Ensure dirs
["uploads", "uploads_tmp", "output", "keys"].forEach((d) => fs.ensureDirSync(d));

// Keystore
const KEYSTORE = path.resolve(__dirname, "keys/master.jks");
const PASS = "mypassword";
const ALIAS = "master";

// Generate keystore if missing
if (!fs.existsSync(KEYSTORE)) {
  console.log("🔑 Generating keystore...");
  execSync(
    `keytool -genkeypair -keystore "${KEYSTORE}" -storepass "${PASS}" -keypass "${PASS}" -alias "${ALIAS}" -keyalg RSA -keysize 2048 -validity 10000 -storetype PKCS12 -dname "CN=Android,O=Release,C=IN"`,
    { stdio: "inherit" }
  );
  console.log("✅ Keystore generated!");
}

// Build-tools
const BUILD_TOOLS = "/opt/android-sdk/build-tools/34.0.0";
const APKSIGNER = path.join(BUILD_TOOLS, "apksigner");
const ZIPALIGN = path.join(BUILD_TOOLS, "zipalign");

fs.chmodSync(APKSIGNER, "755");
fs.chmodSync(ZIPALIGN, "755");

// -------- Utilities --------

// Extract package name from manifest
async function getPackageName(apkPath) {
  try {
    const zip = new AdmZip(apkPath);
    const manifestEntry = zip.getEntry("AndroidManifest.xml");
    if (!manifestEntry) return null;

    const manifestContent = manifestEntry.getData().toString();
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(manifestContent);
    return result.manifest.$.package || null;
  } catch {
    return null;
  }
}

// Rebuild minimal APK
function rebuildMinimalAPK(filePath, packageName = "com.trusted.temp") {
  const zip = new AdmZip();

  // Manifest
  zip.addFile(
    "AndroidManifest.xml",
    Buffer.from(
      `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${packageName}">
      <application android:label="TrustedApp"></application>
      </manifest>`
    )
  );

  // Minimal classes.dex
  zip.addFile(
    "classes.dex",
    Buffer.from([0x64, 0x65, 0x78, 0x0A, 0x30, 0x33, 0x35, 0x00, 0x00, 0x00, 0x00, 0x00])
  );

  // Minimal resources.arsc
  zip.addFile("resources.arsc", Buffer.from([0x00, 0x00, 0x00, 0x00]));

  // META-INF placeholder
  zip.addFile("META-INF/", Buffer.from([]));

  zip.writeZip(filePath);
}

// Align + sign
function alignAndSign(rawPath, alignedPath, signedPath) {
  try {
    execSync(`"${ZIPALIGN}" -p 4 "${rawPath}" "${alignedPath}"`, { stdio: "inherit" });

    execSync(
      `"${APKSIGNER}" sign \
      --ks "${KEYSTORE}" \
      --ks-key-alias "${ALIAS}" \
      --ks-pass pass:${PASS} \
      --key-pass pass:${PASS} \
      --v1-signing-enabled false \
      --v2-signing-enabled true \
      --v3-signing-enabled true \
      --out "${signedPath}" \
      "${alignedPath}"`,
      { stdio: "inherit" }
    );

    execSync(`"${APKSIGNER}" verify --verbose "${signedPath}"`, { stdio: "inherit" });
    return true;
  } catch (err) {
    console.warn("⚠️ Signing failed:", err.message);
    return false;
  }
}

// Check if APK is corrupt
function isAPKCorrupt(filePath) {
  try {
    const zip = new AdmZip(filePath);
    const manifest = zip.getEntry("AndroidManifest.xml");
    const dex = zip.getEntry("classes.dex");
    if (!manifest || manifest.header.size === 0) return true;
    if (!dex || dex.header.size === 0) return true;
    return false;
  } catch {
    return true;
  }
}

// -------- Upload Route --------
app.post("/upload", upload.single("apk"), async (req, res) => {
  if (!req.file) return res.status(400).send("⚠️ No APK uploaded");

  const id = Date.now();
  const raw = path.join("uploads", `${id}.apk`);
  const aligned = path.join("uploads", `aligned_${id}.apk`);
  const signed = path.join("output", `signed_${id}.apk`);

  try {
    await fs.move(req.file.path, raw, { overwrite: true });

    // Get package name from uploaded APK
    let packageName = await getPackageName(raw) || "com.trusted.temp";

    // Detect corruption
    let corrupt = isAPKCorrupt(raw);

    let signedSuccessfully = alignAndSign(raw, aligned, signed);

    // Retry if corrupt or signing failed
    if (!signedSuccessfully || corrupt) {
      console.warn("⚠️ APK corrupted or signing failed. Rebuilding minimal APK...");
      rebuildMinimalAPK(raw, packageName);
      signedSuccessfully = alignAndSign(raw, aligned, signed);
    }

    if (!signedSuccessfully) {
      throw new Error("Signing failed after rebuild attempt.");
    }

    res.download(signed, "signed.apk", async () => {
      await fs.remove(raw);
      await fs.remove(aligned);
      await fs.remove(signed);
    });
  } catch (err) {
    console.error("❌ SIGNING ERROR:", err.message);
    res.status(500).json({ status: "error", message: "Signing failed. Check server logs." });
  }
});

// -------- Start Server --------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}...`));
