const express = require("express");
const multer = require("multer");
const { exec } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs-extra");
const path = require("path");

const app = express();
const upload = multer({ dest: "uploads/" });

fs.ensureDirSync("uploads");
fs.ensureDirSync("output");
fs.ensureDirSync("keys");

app.use(express.static("public"));

const jobs = {};

app.post("/upload", upload.single("apk"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const id = uuidv4();
  const apk = path.join("uploads", `${id}.apk`);
  const signed = path.join("output", `signed_${id}.apk`);
  const keystore = path.join("keys", `${id}.jks`);

  await fs.move(req.file.path, apk);

  jobs[id] = { status: "signing" };
  res.json({ jobId: id });

  (async () => {
    try {
      await run(`
        keytool -genkeypair -noprompt \
        -keystore ${keystore} \
        -storepass pass123 \
        -keypass pass123 \
        -alias alias \
        -keyalg RSA \
        -keysize 2048 \
        -validity 10000 \
        -dname "CN=APK Signer, OU=Dev, O=Test, L=IN, S=IN, C=IN"
      `);

      await run(`
        ${process.env.ANDROID_SDK_ROOT}/build-tools/34.0.0/apksigner sign \
        --ks ${keystore} \
        --ks-pass pass:pass123 \
        --key-pass pass:pass123 \
        --out ${signed} \
        ${apk}
      `);

      jobs[id] = {
        status: "done",
        downloadUrl: `/download/${id}`
      };

    } catch (e) {
      jobs[id] = {
        status: "error",
        error: e.message
      };
      console.error("JOB ERROR:", e.message);
    }
  })();
});

app.get("/status/:id", (req, res) => {
  res.json(jobs[req.params.id] || { status: "unknown" });
});

app.get("/download/:id", (req, res) => {
  const file = path.join("output", `signed_${req.params.id}.apk`);
  if (!fs.existsSync(file)) return res.status(404).send("Not found");
  res.download(file);
});

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { shell: "/bin/bash" }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

app.listen(3000, () => console.log("✅ Server running on port 3000"));
