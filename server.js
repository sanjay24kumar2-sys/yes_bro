const express = require("express");
const multer = require("multer");
const { execSync } = require("child_process");
const fs = require("fs-extra");
const path = require("path");

const app = express();

// Body parser
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Serve frontend
app.use(express.static(path.join(__dirname, "public")));

// Multer setup
const upload = multer({ dest: "uploads_tmp/", limits: { fileSize: 50 * 1024 * 1024 } });

// Ensure directories
["uploads", "uploads_tmp", "output", "keys"].forEach(d => fs.ensureDirSync(d));

// Keystore
const KEYSTORE = path.resolve(__dirname, "keys/master.jks");
const PASS = "mypassword";
const ALIAS = "master";

// Generate keystore if missing
if (!fs.existsSync(KEYSTORE)) {
  console.log("Generating keystore...");
  execSync(
    `keytool -genkeypair -keystore "${KEYSTORE}" -storepass "${PASS}" -keypass "${PASS}" -alias "${ALIAS}" -keyalg RSA -keysize 2048 -validity 10000 -storetype PKCS12 -dname "CN=Android,O=Release,C=IN"`,
    { stdio: "inherit" }
  );
}

// Android build-tools & apksigner.jar path
const BUILD_TOOLS = "/opt/android-sdk/build-tools/34.0.0";
const APKSIGNER_JAR = path.join(BUILD_TOOLS, "lib", "apksigner.jar");

if (!fs.existsSync(APKSIGNER_JAR)) {
  console.error("apksigner.jar not found at", APKSIGNER_JAR);
  process.exit(1);
}

// Upload & sign route
app.post("/upload", upload.single("apk"), async (req, res) => {
  if (!req.file) return res.status(400).send("No APK uploaded");

  const id = Date.now();
  const raw = path.join("uploads", `${id}.apk`);
  const signed = path.join("output", `signed_${id}.apk`);

  try {
    await fs.move(req.file.path, raw);

    console.log("Signing APK...");
    // Fixed: Add --min-sdk-version 21 to avoid MinSdkVersionException
    execSync(
      `java -jar "${APKSIGNER_JAR}" sign \
      --ks "${KEYSTORE}" --ks-key-alias "${ALIAS}" \
      --ks-pass pass:${PASS} --key-pass pass:${PASS} \
      --min-sdk-version 21 \
      --out "${signed}" "${raw}"`,
      { stdio: "inherit" }
    );

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

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}...`));
