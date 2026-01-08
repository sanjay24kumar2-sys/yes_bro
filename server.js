const express = require("express");
const multer = require("multer");
const { execSync } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs-extra");
const path = require("path");

const app = express();
const upload = multer({ limits: { fileSize: 100 * 1024 * 1024 } });

app.use(express.static("public"));

app.post("/upload", upload.single("apk"), async (req, res) => {
  if (!req.file) return res.status(400).send("No APK uploaded");

  const id = uuidv4();
  const apkPath = `uploads/${id}.apk`;
  const signedApk = `output/signed_${id}.apk`;
  const keystore = `keys/${id}.jks`;

  const storePass = uuidv4();
  const keyPass = uuidv4();
  const alias = "alias";

  try {
    await fs.move(req.file.path, apkPath);

    // 🔑 random keystore
    execSync(`
keytool -genkeypair \
-keystore ${keystore} \
-storepass ${storePass} \
-keypass ${keyPass} \
-alias ${alias} \
-keyalg RSA \
-keysize 2048 \
-validity 1000 \
-dname "CN=RandomSigner,O=Test,C=IN"
    `);

    // ✍️ sign APK (V1 disabled)
    execSync(`
apksigner sign \
--ks ${keystore} \
--ks-key-alias ${alias} \
--ks-pass pass:${storePass} \
--key-pass pass:${keyPass} \
--v1-signing-enabled false \
--v2-signing-enabled true \
--v3-signing-enabled true \
--out ${signedApk} \
${apkPath}
    `);

    res.download(signedApk, "signed.apk", () => {
      fs.remove(apkPath);
      fs.remove(keystore);
      fs.remove(signedApk);
    });

  } catch (e) {
    console.error(e.toString());
    res.status(500).send("Signing failed");
  }
});

app.listen(process.env.PORT || 3000, () =>
  console.log("Server running")
);
