const express = require("express");
const multer = require("multer");
const { execSync } = require("child_process");
const fs = require("fs-extra");
const path = require("path");

const app = express();

// Max upload 20MB
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
app.use(express.static("public"));

// Multer config
const upload = multer({
  dest: "uploads_tmp/",
  limits: { fileSize: 20 * 1024 * 1024 }
});

// Ensure folders exist
["uploads", "uploads_tmp", "output", "keys"].forEach(d => fs.ensureDirSync(d));

// Keystore config
const KEYSTORE = path.resolve("keys/master.jks");
const PASS = "mypassword";
const ALIAS = "master";

// Create keystore if missing
if (!fs.existsSync(KEYSTORE)) {
  console.log("Creating master keystore...");
  execSync(
    `keytool -genkeypair -keystore "${KEYSTORE}" -storepass "${PASS}" -keypass "${PASS}" -alias "${ALIAS}" -keyalg RSA -keysize 2048 -validity 10000 -storetype PKCS12 -dname "CN=Android,O=Release,C=IN"`,
    { stdio: "inherit" }
  );
}

// Paths to build-tools
const BUILD_TOOLS = "/opt/android-sdk/build-tools/34.0.0";
const ZIPALIGN = path.join(BUILD_TOOLS, "zipalign");
const APKSIGNER = path.join(BUILD_TOOLS, "apksigner");

// Ensure executables
if (!fs.existsSync(ZIPALIGN) || !fs.existsSync(APKSIGNER)) {
  console.error("ERROR: zipalign or apksigner not found. Check build-tools.");
  process.exit(1);
}
fs.chmodSync(ZIPALIGN, 0o755);
fs.chmodSync(APKSIGNER, 0o755);

app.post("/upload", upload.single("apk"), async (req, res) => {
  if (!req.file) return res.status(400).send("No APK uploaded");

  const id = Date.now();
  const raw = path.join("uploads", `${id}.apk`);
  const aligned = path.join("uploads", `aligned_${id}.apk`);
  const signed = path.join("output", `signed_${id}.apk`);

  try {
    await fs.move(req.file.path, raw);

    console.log("Zipaligning...");
    execSync(`${ZIPALIGN} -p -f 4 "${raw}" "${aligned}"`);

    console.log("Signing APK (V2+V3+V4)...");
    const signCmd = `${APKSIGNER} sign \
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
"${aligned}"`;
    console.log("Command:", signCmd);
    execSync(signCmd);

    console.log("Verifying APK...");
    execSync(`${APKSIGNER} verify --verbose "${signed}"`);

    res.download(signed, "signed.apk", async () => {
      await fs.remove(raw);
      await fs.remove(aligned);
      await fs.remove(signed);
    });

  } catch (err) {
    console.error("SIGNING ERROR:", err);
    res.status(500).send("Signing failed. Check server logs.");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on", PORT));
