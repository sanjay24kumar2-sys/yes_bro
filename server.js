const express = require("express");
const multer = require("multer");
const { execSync } = require("child_process");
const fs = require("fs-extra");
const path = require("path");
const AdmZip = require("adm-zip"); // APK validation

const app = express();

// Body parser
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Serve frontend
app.use(express.static(path.join(__dirname, "public")));

// Multer setup (max 20MB)
const upload = multer({
  dest: "uploads_tmp/",
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
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

// Ensure apksigner exists
if (!fs.existsSync(APKSIGNER)) {
  console.error("❌ apksigner not found at", APKSIGNER);
  process.exit(1);
}
fs.chmodSync(APKSIGNER, "755");

// Upload & sign route
app.post("/upload", upload.single("apk"), async (req, res) => {
  if (!req.file) return res.status(400).send("⚠️ No APK uploaded");

  const id = Date.now();
  const raw = path.join("uploads", `${id}.apk`);
  const signed = path.join("output", `signed_${id}.apk`);

  try {
    // Move uploaded file
    await fs.move(req.file.path, raw, { overwrite: true });

    // Validate APK
    try {
      new AdmZip(raw); // Will throw if APK is corrupted
    } catch {
      await fs.remove(raw);
      return res.status(400).send("❌ Uploaded APK is invalid or corrupted");
    }

    console.log("🛠 Signing APK...");
    execSync(
      `"${APKSIGNER}" sign --ks "${KEYSTORE}" --ks-key-alias "${ALIAS}" --ks-pass pass:${PASS} --key-pass pass:${PASS} --min-sdk-version 21 --out "${signed}" "${raw}"`,
      { stdio: "inherit" }
    );

    console.log("✅ Verifying APK...");
    execSync(`"${APKSIGNER}" verify --verbose "${signed}"`, { stdio: "inherit" });

    // Send signed APK
    res.download(signed, "signed.apk", async () => {
      await fs.remove(raw);
      await fs.remove(signed);
    });

  } catch (err) {
    console.error("❌ SIGNING ERROR:", err.message);
    res.status(500).send("❌ Signing failed. Check server logs.");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}...`));
