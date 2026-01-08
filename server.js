const express = require("express");
const multer = require("multer");
const { execSync } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs-extra");
const path = require("path");

const app = express();

const upload = multer({
  dest: "uploads_tmp/",
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB limit
});

app.use(express.static("public"));

// Ensure required folders exist
["uploads", "uploads_tmp", "output", "keys"].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

console.log("All required folders are ready");

app.post("/upload", upload.single("apk"), async (req, res) => {
  if (!req.file || !req.file.path) return res.status(400).send("❌ No APK uploaded");

  const id = uuidv4();
  const apkPath = path.join("uploads", `${id}.apk`);
  const signedApk = path.join("output", `signed_${id}.apk`);
  const keystore = path.join("keys", `${id}.jks`);

  const storePass = uuidv4();
  const keyPass = storePass;
  const alias = "alias";

  try {
    // Move uploaded file to final uploads directory
    await fs.move(req.file.path, apkPath);

    // Generate keystore
    execSync(`
      keytool -genkeypair \
      -keystore "${keystore}" \
      -storepass "${storePass}" \
      -keypass "${keyPass}" \
      -alias "${alias}" \
      -keyalg RSA \
      -keysize 2048 \
      -validity 1000 \
      -storetype PKCS12 \
      -dname "CN=RandomSigner,O=Test,C=IN"
    `, { stdio: "inherit" });

    // Sign the APK with min-sdk-version added to fix the error
    execSync(`
      apksigner sign \
      --ks "${keystore}" \
      --ks-key-alias "${alias}" \
      --ks-pass pass:${storePass} \
      --key-pass pass:${keyPass} \
      --v1-signing-enabled false \
      --v2-signing-enabled true \
      --v3-signing-enabled true \
      --min-sdk-version 21 \
      --out "${signedApk}" \
      "${apkPath}"
    `, { stdio: "inherit" });

    // Send the signed APK for download
    res.download(signedApk, "signed.apk", async (err) => {
      // Cleanup all files
      await fs.remove(apkPath);
      await fs.remove(keystore);
      await fs.remove(signedApk);
      if (err) console.error("Download error:", err);
    });

  } catch (e) {
    console.error("Signing error:", e.toString());

    // Cleanup uploaded file and keystore if exist
    if (await fs.pathExists(apkPath)) await fs.remove(apkPath);
    if (await fs.pathExists(keystore)) await fs.remove(keystore);
    if (await fs.pathExists(signedApk)) await fs.remove(signedApk);

    res.status(500).send("Signing failed");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
