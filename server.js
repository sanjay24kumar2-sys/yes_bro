// server.js
const express = require("express");
const multer = require("multer");
const fs = require("fs-extra");
const path = require("path");
const { exec } = require("child_process");
const AdmZip = require("adm-zip");

const app = express();

// Max upload size 50MB
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Multer setup
const upload = multer({ dest: "uploads_tmp/", limits: { fileSize: 50 * 1024 * 1024 } });
["uploads","uploads_tmp","output","keys"].forEach(dir => fs.ensureDirSync(dir));

// Keystore setup
const KEYSTORE = path.join(__dirname, "keys/master.jks");
const PASS = "mypassword";
const ALIAS = "master";

// Generate keystore if missing
if (!fs.existsSync(KEYSTORE)) {
  console.log("🔑 Keystore generating...");
  execSync(`keytool -genkeypair -keystore "${KEYSTORE}" -storepass "${PASS}" -keypass "${PASS}" -alias "${ALIAS}" -keyalg RSA -keysize 2048 -validity 10000 -storetype PKCS12 -dname "CN=Android,O=Signer,C=IN"`);
  console.log("✅ Keystore created!");
}

// Android Build tools
const BUILD_TOOLS = "/opt/android-sdk/build-tools/34.0.0";
const APKSIGNER = path.join(BUILD_TOOLS, "apksigner");
const ZIPALIGN = path.join(BUILD_TOOLS, "zipalign");

// Ensure tools are executable
try { fs.chmodSync(APKSIGNER, "755"); fs.chmodSync(ZIPALIGN, "755"); } catch { /* ignore */ }

// Create minimal valid classes.dex
function makeMinimalDex(dexPath) {
  const header = Buffer.from([
    0x64,0x65,0x78,0x0A, // "dex\n"
    0x30,0x33,0x35,0x00  // version "035"
  ]);
  const pad = Buffer.alloc(48, 0);
  fs.writeFileSync(dexPath, Buffer.concat([header, pad]));
}

// Rebuild APK into a valid structure
function rebuildToValid(apkPath) {
  const tmpDir = apkPath + "_tmp";
  fs.removeSync(tmpDir);
  fs.ensureDirSync(tmpDir);

  // Try extract original
  try { new AdmZip(apkPath).extractAllTo(tmpDir, true); } catch {}

  // Write a basic AndroidManifest if absent
  const manifestPath = path.join(tmpDir, "AndroidManifest.xml");
  const manifestXml = `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.auto.rebuilt">
  <application android:label="Rebuilt"></application></manifest>`;
  fs.writeFileSync(manifestPath, manifestXml);

  // Ensuring valid dex + resource
  makeMinimalDex(path.join(tmpDir, "classes.dex"));
  if (!fs.existsSync(path.join(tmpDir, "resources.arsc"))) {
    fs.writeFileSync(path.join(tmpDir, "resources.arsc"), Buffer.from([0,0,0,0]));
  }

  // META-INF folder
  fs.ensureDirSync(path.join(tmpDir, "META-INF"));

  // Rezip it
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

// Async signing
function doSign(raw, aligned, signed, callback) {
  exec(
    `"${ZIPALIGN}" -p 4 "${raw}" "${aligned}" && \
    "${APKSIGNER}" sign --ks "${KEYSTORE}" \
      --ks-key-alias "${ALIAS}" \
      --ks-pass pass:${PASS} \
      --key-pass pass:${PASS} \
      --v1-signing-enabled false \
      --v2-signing-enabled true \
      --v3-signing-enabled true \
      --out "${signed}" "${aligned}"`,
    { maxBuffer: 1024 * 1024 * 15 },
    callback
  );
}

app.post("/upload", upload.single("apk"), async (req, res) => {
  if (!req.file) return res.status(400).json({ status:"error", message:"No file uploaded" });

  const id = Date.now();
  const raw = path.join("uploads", `${id}.apk`);
  const aligned = path.join("uploads", `aligned_${id}.apk`);
  const signed = path.join("output", `signed_${id}.apk`);

  // Move uploaded
  await fs.move(req.file.path, raw, { overwrite:true });

  try {
    console.log("⚙️ Rebuilding APK to valid format...");
    rebuildToValid(raw);

    console.log("⚙️ Signing APK...");
    doSign(raw, aligned, signed, async (err, stdout, stderr) => {
      if (err) {
        console.error("❌ Signing error:", stderr || err.message);
        return res.status(500).json({ status:"error", message: stderr || err.message });
      }

      console.log("✅ Signed! Sending file...");
      res.download(signed, "signed.apk", async () => {
        await fs.remove(raw);
        await fs.remove(aligned);
        await fs.remove(signed);
      });
    });
  } catch (e) {
    console.error("❌ Build/Sign failure:", e.message);
    res.status(500).json({ status:"error", message:e.message });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on port ${PORT}`));
