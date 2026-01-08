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

["uploads", "uploads_tmp", "output", "keys"].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

/* 🔒 FIXED KEYSTORE (NO RANDOM SIGNATURE) */
const KEYSTORE = "keys/master.jks";
const STOREPASS = "mypassword";
const ALIAS = "master";

app.post("/upload", upload.single("apk"), async (req, res) => {
  if (!req.file) return res.status(400).send("No APK");

  const id = Date.now();
  const rawApk = `uploads/${id}.apk`;
  const alignedApk = `uploads/aligned_${id}.apk`;
  const signedApk = `output/signed_${id}.apk`;

  try {
    await fs.move(req.file.path, rawApk);

    // zipalign (build-tools)
    execSync(`zipalign -f 4 "${rawApk}" "${alignedApk}"`, { stdio: "inherit" });

    // SIGN (V1 OFF → WARNING AAYEGI)
    execSync(`
      apksigner sign \
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
    console.error(e);
    res.status(500).send("Signing failed");
  }
});

/* ✅ RAILWAY PORT FIX */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on", PORT));
