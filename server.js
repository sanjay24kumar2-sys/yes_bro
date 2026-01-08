const express = require("express");
const multer = require("multer");
const { execSync } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs-extra");
const path = require("path");

const app = express();

// Multer storage
const upload = multer({
  dest: "uploads_tmp/",
  limits: { fileSize: 100 * 1024 * 1024 },
});

app.use(express.static("public"));

// Ensure folders exist
["uploads", "uploads_tmp", "output", "keys"].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

console.log("Folders ready ✔️");

// POST /upload
app.post("/upload", upload.single("apk"), async (req, res) => {
  if (!req.file || !req.file.path) return res.status(400).send("No APK uploaded");

  const id = uuidv4();
  const apkPath = path.join("uploads", `${id}.apk`);
  const signedApk = path.join("output", `signed_${id}.apk`);
  const keystore = path.join("keys", `${id}.jks`);

  const storePass = uuidv4();
  const keyPass = storePass; // ✅ PKCS12 compatible
  const alias = "alias";

  try {
    // Move uploaded file
    await fs.move(req.file.path, apkPath);

    // 🔑 Generate random keystore (PKCS12)
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
    `);

    // ✍️ Sign APK (V1 fail, V2/V3 enabled)
    execSync(`
apksigner sign \
--ks "${keystore}" \
--ks-key-alias "${alias}" \
--ks-pass pass:${storePass} \
--key-pass pass:${keyPass} \
--v1-signing-enabled false \
--v2-signing-enabled true \
--v3-signing-enabled true \
--out "${signedApk}" \
"${apkPath}"
    `);

    // Send file to client
    res.download(signedApk, "signed.apk", async () => {
      await fs.remove(apkPath);
      await fs.remove(keystore);
      await fs.remove(signedApk);
    });

  } catch (e) {
    console.error("Signing error:", e.toString());
    res.status(500).send("Signing failed");
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Server running ✔️"));
