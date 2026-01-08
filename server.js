// server.js
const express = require("express");
const multer = require("multer");
const fs = require("fs-extra");
const path = require("path");
const { exec } = require("child_process");
const AdmZip = require("adm-zip");

const app = express();
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));
app.use(express.static(path.join(__dirname,"public")));

// Simple in‑memory job store
const jobs = {};

const upload = multer({ dest: "uploads_tmp/", limits: { fileSize: 20 * 1024 * 1024 } });
["uploads","uploads_tmp","output","keys"].forEach(d => fs.ensureDirSync(d));

// Keystore
const KEYSTORE = path.resolve(__dirname,"keys/master.jks");
const PASS = "mypassword";
const ALIAS = "master";

if (!fs.existsSync(KEYSTORE)) {
  execSync(
    `keytool -genkeypair -keystore "${KEYSTORE}" -storepass ${PASS} -keypass ${PASS} -alias ${ALIAS} -keyalg RSA -keysize 2048 -validity 10000 -storetype PKCS12 -dname "CN=Android,O=Signer,C=IN"`,
    { stdio: "inherit" }
  );
}

// Android tools
const BUILD_TOOLS = "/opt/android-sdk/build-tools/34.0.0";
const APKSIGNER = path.join(BUILD_TOOLS,"apksigner");
const ZIPALIGN = path.join(BUILD_TOOLS,"zipalign");

// Async background sign
function backgroundSign(jobId, raw) {
  const aligned = path.join("uploads",`${jobId}_aligned.apk`);
  const signed = path.join("output",`${jobId}_signed.apk`);
  jobs[jobId] = { status:"processing" };

  exec(
    `"${ZIPALIGN}" -p 4 "${raw}" "${aligned}" && \
    "${APKSIGNER}" sign \
    --ks "${KEYSTORE}" --ks-key-alias "${ALIAS}" \
    --ks-pass pass:${PASS} --key-pass pass:${PASS} \
    --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true \
    --out "${signed}" "${aligned}"`,
    { maxBuffer: 1024 * 1024 * 15 },
    async (err, stdout, stderr) => {
      if (err) {
        jobs[jobId] = { status:"error", error: stderr || err.message };
        return;
      }
      jobs[jobId] = { status:"done", file:`/download/${jobId}` };
    }
  );
}

// Upload job endpoint
app.post("/upload", upload.single("apk"), async (req,res) => {
  if (!req.file) return res.status(400).json({ error:"No file uploaded" });

  const jobId = Date.now().toString();
  const raw = path.join("uploads",`${jobId}.apk`);
  await fs.move(req.file.path, raw, { overwrite:true });

  // Immediately return job id
  res.json({ jobId, message:"Signing started" });

  // Perform signing in background
  backgroundSign(jobId, raw);
});

// Status check
app.get("/status/:jobId", (req,res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ status:"not found" });
  res.json(job);
});

// Download signed APK
app.get("/download/:jobId", (req,res) => {
  const signedPath = path.join("output",`${req.params.jobId}_signed.apk`);
  if (!fs.existsSync(signedPath)) return res.status(404).send("Not ready");
  res.download(signedPath,"signed.apk");
});

// Health check ✓
app.get("/health", (req,res) => res.send("OK"));

// Listen correctly
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Server listening on ${PORT}`));
