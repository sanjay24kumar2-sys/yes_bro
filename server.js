const express = require("express");
const multer = require("multer");
const { execSync } = require("child_process");
const fs = require("fs-extra");
const path = require("path");

const app = express();

app.use(express.json({ limit: "200mb" }));
app.use(express.urlencoded({ extended: true, limit: "200mb" }));
app.use(express.static("public"));

const upload = multer({
  dest: "uploads_tmp/",
  limits: { fileSize: 100 * 1024 * 1024 }
});

const DIRS = ["uploads", "uploads_tmp", "output", "keys"];
DIRS.forEach(d => fs.ensureDirSync(d));

/* 🔒 FIXED KEYSTORE CONFIG */
const KEYSTORE = "keys/master.jks";
const STOREPASS = "mypassword";
const ALIAS = "master";

/* 🔑 AUTO CREATE KEYSTORE (IMPORTANT FIX) */
if (!fs.existsSync(KEYSTORE)) {
  console.log("Creating master keystore...");
  execSync(`
    keytool -genkeypair \
    -keystore "${KEYSTORE}" \
    -storepass ${STOREPASS} \
    -keypass ${STOREPASS} \
    -alias ${ALIAS} \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -storetype PKCS12 \
    -dname "CN=Android,O=Release,C=IN"
  `, { stdio: "inherit" });
}

const ZIPALIGN = "/opt/android-sdk/build-tools/34.0.0/zipalign";
const APKSIGNER = "/opt/android-sdk/build-tools/34.0.0/apksigner";

app.post("/upload", upload.single("apk"), async (req, res) => {
  if (!req.file) return res.status(400).send("No APK");

  const id = Date.now();
  const rawApk = `uploads/${id}.apk`;
  const alignedApk = `uploads/aligned_${id}.apk`;
  const signedApk = `output/signed_${id}.apk`;

  try {
    await fs.move(req.file.path, rawApk);

    /* 1️⃣ ZIPALIGN */
    execSync(`${ZIPALIGN} -f 4 "${rawApk}" "${alignedApk}"`, { stdio: "inherit" });

    /* 2️⃣ SIGN APK (V1 OFF) */
    execSync(`
      ${APKSIGNER} sign \
      --ks "${KEYSTORE}" \
      --ks-key-alias "${ALIAS}" \
      --ks-pass pass:${STOREPASS} \
      --key-pass pass:${STOREPASS} \
      --v1-signing-enabled false \
      --v2-signing-enabled true \
      --v3-signing-enabled true \
      --min-sdk-version 21 \
      --out "${signedApk}" \
      "${alignedApk}"
    `, { stdio: "inherit" });

    res.download(signedApk, "signed.apk", async () => {
      await fs.remove(rawApk);
      await fs.remove(alignedApk);
      await fs.remove(signedApk);
    });

  } catch (e) {
    console.error("SIGN ERROR:", e.toString());
    res.status(500).send("Signing failed");
  }
});

/* ✅ RAILWAY PORT */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on", PORT));
