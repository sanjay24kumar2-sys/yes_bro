// server.js
const express = require("express");
const multer = require("multer");
const fs = require("fs-extra");
const path = require("path");
const { execSync } = require("child_process");
const AdmZip = require("adm-zip");

const app = express();
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Setup multer upload
const upload = multer({ dest: "uploads_tmp/", limits: { fileSize: 50 * 1024 * 1024 } });
["uploads","uploads_tmp","output","keys"].forEach(d => fs.ensureDirSync(d));

// Keystore (auto generate)
const KEYSTORE = path.resolve(__dirname, "keys/master.jks");
const PASS = "mypassword";
const ALIAS = "master";

if (!fs.existsSync(KEYSTORE)) {
  console.log("🔑 Generating keystore...");
  execSync(
    `keytool -genkeypair -keystore "${KEYSTORE}" -storepass ${PASS} -keypass ${PASS} -alias ${ALIAS} -keyalg RSA -keysize 2048 -validity 10000 -storetype PKCS12 -dname "CN=Android,O=SignMe,C=IN"`,
    { stdio: "inherit" }
  );
  console.log("✅ Keystore created!");
}

// Build-tools paths
const BUILD_TOOLS = "/opt/android-sdk/build-tools/34.0.0";
const APKSIGNER = path.join(BUILD_TOOLS, "apksigner");
const ZIPALIGN = path.join(BUILD_TOOLS, "zipalign");

// Ensure binaries are executable
fs.chmodSync(APKSIGNER, "755");
fs.chmodSync(ZIPALIGN, "755");

// HELPERS

// Make minimal valid classes.dex
function makeMinimalDex(targetPath) {
  const dexHeader = Buffer.from([
    0x64,0x65,0x78,0x0A, // "dex\n"
    0x30,0x33,0x35,0x00 // version "035"
  ]);
  const pad = Buffer.alloc(48, 0); 
  fs.writeFileSync(targetPath, Buffer.concat([dexHeader, pad]));
}

// Build a valid APK structure from scratch
function buildValidAPK(apkPath, pkg) {
  const tmpDir = apkPath + "_tmp";
  fs.removeSync(tmpDir);
  fs.ensureDirSync(tmpDir);

  // Try to extract original if possible
  try { new AdmZip(apkPath).extractAllTo(tmpDir, true); } catch {}

  // Manifest
  const manifestPath = path.join(tmpDir, "AndroidManifest.xml");
  const manifestData = 
    `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${pkg}">
      <application android:label="RebuiltApp"></application>
     </manifest>`;
  fs.writeFileSync(manifestPath, manifestData);

  // Minimal dex
  const dexPath = path.join(tmpDir, "classes.dex");
  makeMinimalDex(dexPath);

  // Resources placeholder
  const resPath = path.join(tmpDir, "resources.arsc");
  if (!fs.existsSync(resPath)) {
    fs.writeFileSync(resPath, Buffer.from([0,0,0,0]));
  }

  // META-INF folder
  fs.ensureDirSync(path.join(tmpDir, "META-INF"));

  // Rezip
  const zip = new AdmZip();
  fs.readdirSync(tmpDir).forEach(file => {
    const full = path.join(tmpDir, file);
    if (fs.lstatSync(full).isFile()) {
      zip.addFile(file, fs.readFileSync(full));
    }
  });
  zip.writeZip(apkPath);
  fs.removeSync(tmpDir);
}

// Align & sign
function alignAndSign(raw, aligned, out) {
  execSync(`"${ZIPALIGN}" -p 4 "${raw}" "${aligned}"`, { stdio: "inherit" });
  execSync(
    `"${APKSIGNER}" sign --ks "${KEYSTORE}" --ks-key-alias "${ALIAS}"
      --ks-pass pass:${PASS} --key-pass pass:${PASS}
      --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true
      --out "${out}" "${aligned}"`,
    { stdio: "inherit" }
  );
}

app.post("/upload", upload.single("apk"), async (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");

  const id = Date.now();
  const raw = path.join("uploads", `${id}.apk`);
  const aligned = path.join("uploads", `aligned_${id}.apk`);
  const signed = path.join("output", `signed_${id}.apk`);

  await fs.move(req.file.path, raw, { overwrite: true });

  try {
    // Force rebuild from corruption to valid
    buildValidAPK(raw, "com.rebuilt.apk");

    console.log("📌 Aligning & Signing...");
    alignAndSign(raw, aligned, signed);

    res.download(signed, "signed.apk", async () => {
      await fs.remove(raw);
      await fs.remove(aligned);
      await fs.remove(signed);
    });
  } catch (err) {
    console.error("❌ SIGNING FAILED:", err.message);
    res.status(500).json({ status:"error", message: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server started on port ${PORT}...`));
