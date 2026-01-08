// server.js
const express = require("express");
const multer = require("multer");
const fs = require("fs-extra");
const path = require("path");
const { execSync } = require("child_process");
const AdmZip = require("adm-zip");

const app = express();

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Multer upload
const upload = multer({ dest: "uploads_tmp/", limits: { fileSize: 50 * 1024 * 1024 } });

// Ensure directories exist
["uploads", "uploads_tmp", "output", "keys"].forEach((d) => fs.ensureDirSync(d));

// Keystore setup
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

// Android build-tools
const BUILD_TOOLS = "/opt/android-sdk/build-tools/34.0.0";
const APKSIGNER = path.join(BUILD_TOOLS, "apksigner");
const ZIPALIGN = path.join(BUILD_TOOLS, "zipalign");

fs.chmodSync(APKSIGNER, "755");
fs.chmodSync(ZIPALIGN, "755");

// -------- Utility functions --------

// Check if APK is valid ZIP and contains manifest/dex
function isAPKCorrupt(filePath) {
  try {
    const zip = new AdmZip(filePath);
    const manifest = zip.getEntry("AndroidManifest.xml");
    const dex = zip.getEntry("classes.dex");
    if (!manifest || manifest.header.size === 0) return true;
    if (!dex || dex.header.size === 0) return true;
    return false;
  } catch {
    return true; // ZIP cannot be loaded → corrupted
  }
}

// Rebuild minimal trusted APK
function rebuildMinimalAPK(filePath) {
  const zip = new AdmZip();

  // AndroidManifest.xml
  zip.addFile(
    "AndroidManifest.xml",
    Buffer.from(
      `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.trusted.temp">
      <application android:label="TrustedApp"></application>
      </manifest>`
    )
  );

  // Minimal classes.dex with proper DEX header
  const dummyDex = Buffer.from([
    0x64, 0x65, 0x78, 0x0A, // "dex\n"
    0x30, 0x33, 0x35, 0x00, // version 035
    0x00, 0x00, 0x00, 0x00, // rest of header placeholder
  ]);
  zip.addFile("classes.dex", dummyDex);

  // Minimal resources.arsc
  zip.addFile("resources.arsc", Buffer.from([0x00, 0x00, 0x00, 0x00]));

  // Required META-INF folder for signing
  zip.addFile("META-INF/", Buffer.from([]));

  zip.writeZip(filePath);
}

// Align + sign APK
function alignAndSign(rawPath, alignedPath, signedPath) {
  try {
    // Align
    execSync(`"${ZIPALIGN}" -p 4 "${rawPath}" "${alignedPath}"`, { stdio: "inherit" });

    // Sign (v1=false, v2+v3=true)
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

    // Verify
    execSync(`"${APKSIGNER}" verify --verbose "${signedPath}"`, { stdio: "inherit" });
    return true;
  } catch (err) {
    console.warn("⚠️ Signing failed:", err.message);
    return false;
  }
}

// -------- Upload route --------
app.post("/upload", upload.single("apk"), async (req, res) => {
  if (!req.file) return res.status(400).send("⚠️ No APK uploaded");

  const id = Date.now();
  const raw = path.join("uploads", `${id}.apk`);
  const aligned = path.join("uploads", `aligned_${id}.apk`);
  const signed = path.join("output", `signed_${id}.apk`);

  try {
    await fs.move(req.file.path, raw, { overwrite: true });

    let corrupt = isAPKCorrupt(raw);
    let signedSuccessfully = alignAndSign(raw, aligned, signed);

    if (!signedSuccessfully || corrupt) {
      console.warn("⚠️ APK corrupted or signing failed. Rebuilding minimal APK and retrying...");
      rebuildMinimalAPK(raw);
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

// -------- Start server --------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}...`));
