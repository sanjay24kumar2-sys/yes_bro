// server.js
const express = require("express");
const multer = require("multer");
const fs = require("fs-extra");
const path = require("path");
const { exec, execSync } = require("child_process"); // 👈 fixed
const AdmZip = require("adm-zip");

const app = express();

// Accept large uploads
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Create directories
["uploads", "uploads_tmp", "output", "keys"].forEach(dir => fs.ensureDirSync(dir));

// Multer setup (20 MB)
const upload = multer({
  dest: "uploads_tmp/",
  limits: { fileSize: 20 * 1024 * 1024 }
});

// Keystore
const KEYSTORE = path.join(__dirname, "keys/master.jks");
const PASS = "mypassword", ALIAS = "master";

// Create keystore if missing
if (!fs.existsSync(KEYSTORE)) {
  console.log("🔑 Generating keystore...");
  execSync(
    `keytool -genkeypair -keystore "${KEYSTORE}" -storepass ${PASS} -keypass ${PASS} -alias ${ALIAS} -keyalg RSA -keysize 2048 -validity 10000 -storetype PKCS12 -dname "CN=Android,O=Signer,C=IN"`
  );
  console.log("✅ Keystore created");
}

// Paths for Android tools
const BUILD_TOOLS = "/opt/android-sdk/build-tools/34.0.0";
const APKSIGNER = path.join(BUILD_TOOLS, "apksigner");
const ZIPALIGN = path.join(BUILD_TOOLS, "zipalign");

// In‑memory job status
const jobs = {};

// Async sign job
function startSigning(jobId, rawPath) {
  const aligned = path.join("uploads", `${jobId}_aligned.apk`);
  const signed = path.join("output", `${jobId}_signed.apk`);

  jobs[jobId] = { status: "processing" };

  exec(
    `"${ZIPALIGN}" -p 4 "${rawPath}" "${aligned}" && \
     "${APKSIGNER}" sign --ks "${KEYSTORE}" --ks-key-alias "${ALIAS}" \
     --ks-pass pass:${PASS} --key-pass pass:${PASS} \
     --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true \
     --out "${signed}" "${aligned}"`,
    { maxBuffer: 1024 * 1024 * 15 },
    (err, stdout, stderr) => {
      if (err) {
        jobs[jobId] = { status: "error", error: stderr || err.message };
      } else {
        jobs[jobId] = { status: "done", downloadUrl: `/download/${jobId}` };
      }
    }
  );
}

// Upload route — immediate response
app.post("/upload", upload.single("apk"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const jobId = Date.now().toString();
  const rawPath = path.join("uploads", `${jobId}.apk`);

  await fs.move(req.file.path, rawPath, { overwrite: true });

  // Start background signing
  startSigning(jobId, rawPath);

  // Respond immediately
  res.json({ jobId, message: "APK upload received, signing in progress" });
});

// Status polling
app.get("/status/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ status: "not found" });
  res.json(job);
});

// Download signed APK
app.get("/download/:jobId", (req, res) => {
  const signedPath = path.join("output", `${req.params.jobId}_signed.apk`);
  if (!fs.existsSync(signedPath)) return res.status(404).send("Not ready");
  res.download(signedPath, "signed.apk");
});

// Simple health check
app.get("/health", (req, res) => res.json({ status: "ok" }));

// **IMPORTANT for Railway: use process.env.PORT + 0.0.0.0**
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server listening on 0.0.0.0:${PORT}`);
});
