const express = require("express");
const multer = require("multer");
const { execSync } = require("child_process");
const fs = require("fs-extra");

const app = express();

app.use(express.json({ limit: "200mb" }));
app.use(express.urlencoded({ extended: true, limit: "200mb" }));
app.use(express.static("public"));

const upload = multer({
  dest: "uploads_tmp/",
  limits: { fileSize: 100 * 1024 * 1024 }
});

["uploads","uploads_tmp","output","keys"].forEach(d =>
  fs.ensureDirSync(d)
);

const KEYSTORE = "keys/master.jks";
const PASS = "mypassword";
const ALIAS = "master";

if (!fs.existsSync(KEYSTORE)) {
  execSync(`
    keytool -genkeypair \
    -keystore ${KEYSTORE} \
    -storepass ${PASS} \
    -keypass ${PASS} \
    -alias ${ALIAS} \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -storetype PKCS12 \
    -dname "CN=Android,O=Release,C=IN"
  `);
}



const ZIPALIGN = "/opt/android-sdk/build-tools/34.0.0/zipalign";
const APKSIGNER = "/opt/android-sdk/build-tools/34.0.0/apksigner";

app.post("/upload", upload.single("apk"), async (req, res) => {
  if (!req.file) return res.status(400).send("No APK");

  const id = Date.now();
  const raw = `uploads/${id}.apk`;
  const aligned = `uploads/aligned_${id}.apk`;
  const signed = `output/signed_${id}.apk`;

  try {
    await fs.move(req.file.path, raw);

    execSync(`${ZIPALIGN} -p -f 4 "${raw}" "${aligned}"`);

    execSync(`
      ${APKSIGNER} sign \
      --ks ${KEYSTORE} \
      --ks-key-alias ${ALIAS} \
      --ks-pass pass:${PASS} \
      --key-pass pass:${PASS} \
      --v1-signing-enabled false \
      --v2-signing-enabled true \
      --v3-signing-enabled true \
      --v4-signing-enabled true \
      --min-sdk-version 21 \
      --out "${signed}" \
      "${aligned}"
    `);

    execSync(`${APKSIGNER} verify --verbose "${signed}"`);

    res.download(signed, "signed.apk");

  } catch (e) {
    console.error(e.toString());
    res.status(500).send("Signing failed");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on", PORT));
