const express = require("express");
const multer = require("multer");
const { execSync } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs-extra");
const path = require("path");

const app = express();

const upload = multer({
  dest: "uploads_tmp/",
  limits: { fileSize: 100 * 1024 * 1024 }
});

app.use(express.static("public"));

["uploads", "uploads_tmp", "output", "keys"].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

app.post("/upload", upload.single("apk"), async (req, res) => {
  if (!req.file) return res.status(400).send("No APK");

  const id = uuidv4();
  const rawApk = path.join("uploads", `${id}.apk`);
  const alignedApk = path.join("uploads", `aligned_${id}.apk`);
  const signedApk = path.join("output", `signed_${id}.apk`);
  const keystore = path.join("keys", `${id}.jks`);

  const pass = "password";
  const alias = "alias";

  try {
    await fs.move(req.file.path, rawApk);

    // 1️⃣ zipalign (VERY IMPORTANT)
    execSync(`zipalign -f 4 "${rawApk}" "${alignedApk}"`);

    // 2️⃣ generate keystore
    execSync(`
      keytool -genkeypair \
      -keystore "${keystore}" \
      -storepass ${pass} \
      -keypass ${pass} \
      -alias ${alias} \
      -keyalg RSA \
      -keysize 2048 \
      -validity 10000 \
      -storetype PKCS12 \
      -dname "CN=Android,O=Debug,C=IN"
    `);

    // 3️⃣ SIGN (THIS IS THE MAGIC)
    execSync(`
      apksigner sign \
      --ks "${keystore}" \
      --ks-key-alias "${alias}" \
      --ks-pass pass:${pass} \
      --key-pass pass:${pass} \
      --v1-signing-enabled false \
      --v2-signing-enabled true \
      --v3-signing-enabled true \
      --min-sdk-version 21 \
      --out "${signedApk}" \
      "${alignedApk}"
    `);

    res.download(signedApk, "signed.apk");

  } catch (e) {
    console.error(e.toString());
    res.status(500).send("Signing failed");
  }
});

app.listen(3000, () => console.log("Server running on 3000"));
