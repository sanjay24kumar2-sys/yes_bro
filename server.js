const express = require("express");
const multer = require("multer");
const { exec } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs-extra");
const path = require("path");

const app = express();
const upload = multer({ dest: "uploads/", limits: { fileSize: 100 * 1024 * 1024 } });

fs.ensureDirSync("uploads");
fs.ensureDirSync("output");
fs.ensureDirSync("keys");

app.use(express.static("public"));

const jobs = {}; // Store job status

// Upload endpoint
app.post("/upload", upload.single("apk"), async (req, res) => {
  if (!req.file) return res.status(400).send("No APK uploaded");

  const jobId = uuidv4();
  jobs[jobId] = { status: "pending", downloadUrl: null, error: null };

  const apkPath = path.join("uploads", `${jobId}.apk`);
  const signedApk = path.join("output", `signed_${jobId}.apk`);
  const keystore = path.join("keys", `${jobId}.jks`);

  const storePass = uuidv4();
  const keyPass = uuidv4();
  const alias = "alias";

  await fs.move(req.file.path, apkPath);

  // Process signing asynchronously
  (async () => {
    try {
      // Generate keystore
      await new Promise((resolve, reject) => {
        exec(`keytool -genkeypair -keystore ${keystore} -storepass ${storePass} -keypass ${keyPass} -alias ${alias} -keyalg RSA -keysize 2048 -validity 1000 -dname "CN=RandomSigner,O=Test,C=IN"`, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Sign APK
      await new Promise((resolve, reject) => {
        exec(`apksigner sign --ks ${keystore} --ks-key-alias ${alias} --ks-pass pass:${storePass} --key-pass pass:${keyPass} --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true --out ${signedApk} ${apkPath}`, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      jobs[jobId].status = "done";
      jobs[jobId].downloadUrl = `/download/${jobId}`;

    } catch (e) {
      console.error(e);
      jobs[jobId].status = "error";
      jobs[jobId].error = e.toString();
    } finally {
      await fs.remove(apkPath);
      await fs.remove(keystore);
    }
  })();

  res.json({ jobId });
});

// Status endpoint
app.get("/status/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ status: "error", error: "Job not found" });
  res.json(job);
});

app.get("/download/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  const signedApk = path.join("output", `signed_${jobId}.apk`);
  if (!fs.existsSync(signedApk)) return res.status(404).send("File not found");

  res.download(signedApk, "signed.apk", async () => {
    await fs.remove(signedApk);
    delete jobs[jobId];
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));