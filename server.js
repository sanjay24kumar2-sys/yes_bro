const express = require("express");
const multer = require("multer");
const { execSync } = require("child_process");
const fs = require("fs-extra");
const path = require("path");
const AdmZip = require("adm-zip");

const app = express();

// Body parser
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Serve frontend
app.use(express.static(path.join(__dirname, "public")));

// Multer setup
const upload = multer({
  dest: "uploads_tmp/",
  limits: { fileSize: 20 * 1024 * 1024 },
});

// Ensure directories exist
["uploads", "uploads_tmp", "output", "keys"].forEach((d) => fs.ensureDirSync(d));

// Keystore config
const KEYSTORE = path.resolve(__dirname, "keys/master.jks");
const PASS = "mypassword";
const ALIAS = "master";

// Generate keystore if missing
if (!fs.existsSync(KEYSTORE)) {
  console.log("🔑 Generating keystore...");
  try {
    execSync(
      `keytool -genkeypair -keystore "${KEYSTORE}" -storepass "${PASS}" -keypass "${PASS}" -alias "${ALIAS}" -keyalg RSA -keysize 2048 -validity 10000 -storetype PKCS12 -dname "CN=Android,O=Release,C=IN"`,
      { stdio: "inherit" }
    );
    console.log("✅ Keystore generated!");
  } catch (err) {
    console.error("❌ Keystore generation failed:", err.message);
    process.exit(1);
  }
}

// Android build-tools
const BUILD_TOOLS = "/opt/android-sdk/build-tools/34.0.0";
const APKSIGNER = path.join(BUILD_TOOLS, "apksigner");
const ZIPALIGN = path.join(BUILD_TOOLS, "zipalign");

if (!fs.existsSync(APKSIGNER) || !fs.existsSync(ZIPALIGN)) {
  console.error("❌ apksigner or zipalign not found!");
  process.exit(1);
}
fs.chmodSync(APKSIGNER, "755");
fs.chmodSync(ZIPALIGN, "755");

// Upload & sign route
app.post("/upload", upload.single("apk"), async (req, res) => {
  if (!req.file) return res.status(400).send("⚠️ No APK uploaded");

  const id = Date.now();
  const raw = path.join("uploads", `${id}.apk`);
  const aligned = path.join("uploads", `aligned_${id}.apk`);
  const signed = path.join("output", `signed_${id}.apk`);

  try {
    await fs.move(req.file.path, raw, { overwrite: true });

    let zip;
    let isCorrupt = false;

    try {
      zip = new AdmZip(raw);
      const manifest = zip.getEntry("AndroidManifest.xml");
      if (!manifest || manifest.header.size === 0) isCorrupt = true;
    } catch {
      isCorrupt = true;
    }

    // If corrupted, add dummy AndroidManifest.xml to force signing
    if (isCorrupt) {
      console.warn("⚠️ APK is corrupted. Adding dummy AndroidManifest.xml for signing.");
      zip = zip || new AdmZip();
      zip.addFile("AndroidManifest.xml", Buffer.from('<manifest package="com.temp.app"/>'));
      zip.writeZip(raw);
    }

    console.log("🛠 Aligning APK...");
    execSync(`"${ZIPALIGN}" -p 4 "${raw}" "${aligned}"`, { stdio: "inherit" });

    console.log("🛠 Signing APK (v1=false, v2/v3/v4 enabled)...");
    execSync(
      `"${APKSIGNER}" sign \
      --ks "${KEYSTORE}" \
      --ks-key-alias "${ALIAS}" \
      --ks-pass pass:${PASS} \
      --key-pass pass:${PASS} \
      --v1-signing-enabled false \
      --v2-signing-enabled true \
      --v3-signing-enabled true \
      --v4-signing-enabled true \
      --min-sdk-version 21 \
      --out "${signed}" \
      "${aligned}"`,
      { stdio: "inherit" }
    );

    console.log("✅ Verifying APK...");
    execSync(`"${APKSIGNER}" verify --verbose "${signed}"`, { stdio: "inherit" });

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}...`));
