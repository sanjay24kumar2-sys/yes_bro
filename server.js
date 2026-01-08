const express = require("express");
const multer = require("multer");
const { execSync } = require("child_process");
const fs = require("fs-extra");
const path = require("path");

const app = express();

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static("public"));

// Multer setup (20 MB max upload)
const upload = multer({ dest: "uploads_tmp/", limits: { fileSize: 20 * 1024 * 1024 } });

// Ensure directories exist
["uploads", "uploads_tmp", "output", "keys"].forEach(d => fs.ensureDirSync(d));

// Keystore setup
const KEYSTORE = path.resolve(__dirname, "keys/master.jks");
const PASS = "mypassword";
const ALIAS = "master";

// Generate keystore if not exists
if (!fs.existsSync(KEYSTORE)) {
    console.log("Generating keystore...");
    execSync(`keytool -genkeypair -keystore "${KEYSTORE}" -storepass "${PASS}" -keypass "${PASS}" -alias "${ALIAS}" -keyalg RSA -keysize 2048 -validity 10000 -storetype PKCS12 -dname "CN=Android,O=Release,C=IN"`);
}

// Build-tools paths
const BUILD_TOOLS = "/opt/android-sdk/build-tools/34.0.0";
const ZIPALIGN = path.join(BUILD_TOOLS, "zipalign");
const APKSIGNER = path.join(BUILD_TOOLS, "apksigner");

// Ensure executables exist
if (!fs.existsSync(ZIPALIGN)) {
    console.error("zipalign not found at", ZIPALIGN);
    process.exit(1);
}
if (!fs.existsSync(APKSIGNER)) {
    console.error("apksigner not found at", APKSIGNER);
    process.exit(1);
}

// Make sure they are executable
fs.chmodSync(ZIPALIGN, 0o755);
fs.chmodSync(APKSIGNER, 0o755);

// Upload & signing endpoint
app.post("/upload", upload.single("apk"), async (req, res) => {
    if (!req.file) return res.status(400).send("No APK uploaded");

    const id = Date.now();
    const raw = path.join("uploads", `${id}.apk`);
    const aligned = path.join("uploads", `aligned_${id}.apk`);
    const signed = path.join("output", `signed_${id}.apk`);

    try {
        // Move uploaded APK
        await fs.move(req.file.path, raw);

        console.log("Zipaligning APK...");
        execSync(`${ZIPALIGN} -p -f 4 "${raw}" "${aligned}"`, { stdio: "inherit" });

        console.log("Signing APK...");
        execSync(`${APKSIGNER} sign --ks "${KEYSTORE}" --ks-key-alias "${ALIAS}" --ks-pass pass:${PASS} --key-pass pass:${PASS} --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true --v4-signing-enabled true --out "${signed}" "${aligned}"`, { stdio: "inherit" });

        console.log("Verifying signed APK...");
        execSync(`${APKSIGNER} verify --verbose "${signed}"`, { stdio: "inherit" });

        // Send signed APK to client
        res.download(signed, "signed.apk", async () => {
            await fs.remove(raw);
            await fs.remove(aligned);
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
