const express = require("express");
const multer = require("multer");
const { execSync } = require("child_process");
const fs = require("fs-extra");
const path = require("path");

const app = express();

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Multer setup
const upload = multer({ dest: "uploads_tmp/", limits: { fileSize: 20 * 1024 * 1024 } });

["uploads", "uploads_tmp", "output", "keys"].forEach(d => fs.ensureDirSync(d));

// Keystore config
const KEYSTORE = path.resolve(__dirname, "keys/master.jks");
const PASS = "mypassword";
const ALIAS = "master";

// Generate keystore if not exists
if (!fs.existsSync(KEYSTORE)) {
  console.log("Generating keystore...");
  execSync(`keytool -genkeypair -keystore "${KEYSTORE}" -storepass "${PASS}" -keypass "${PASS}" -alias "${ALIAS}" -keyalg RSA -keysize 2048 -validity 10000 -storetype PKCS12 -dname "CN=Android,O=Release,C=IN"`);
}

// Path to apksigner.jar
const BUILD_TOOLS = "/opt/android-sdk/build-tools/34.0.0";
const APKSIGNER_JAR = path.join(BUILD_TOOLS, "lib", "apksigner.jar");

// Check if apksigner.jar exists
if (!fs.existsSync(APKSIGNER_JAR)) {
  console.error("apksigner.jar not found at", APKSIGNER_JAR);
  process.exit(1);
}

app.post("/upload", upload.single("apk"), async (req, res) => {
  if (!req.file) return res.status(400).send("No APK uploaded");

  const id = Date.now();
  const raw = path.join("uploads", `${id}.apk`);
  const signed = path.join("output", `signed_${id}.apk`);

  try {
    // Move uploaded file
    await fs.move(req.file.path, raw);

    console.log("Signing APK with apksigner.jar...");
    execSync(`java -jar "${APKSIGNER_JAR}" sign --ks "${KEYSTORE}" --ks-key-alias "${ALIAS}" --ks-pass pass:${PASS} --key-pass pass:${PASS} --out "${signed}" "${raw}"`, { stdio: "inherit" });

    console.log("Verifying APK...");
    execSync(`java -jar "${APKSIGNER_JAR}" verify --verbose "${signed}"`, { stdio: "inherit" });

    res.download(signed, "signed.apk", async () => {
      await fs.remove(raw);
      await fs.remove(signed);
    });

  } catch (err) {
    console.error("SIGNING ERROR:", err.message);
    if (err.stdout) console.error("STDOUT:", err.stdout.toString());
    if (err.stderr) console.error("STDERR:", err.stderr.toString());
    res.status(500).send("Signing failed. Check server logs.");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}...`));
