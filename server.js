const express = require("express");
const multer = require("multer");
const { exec } = require("child_process");
const uuidv4 = require("uuid").v4;
const fs = require("fs-extra");
const path = require("path");

const app = express();
const upload = multer({ dest: "uploads/" });

fs.ensureDirSync("uploads");
fs.ensureDirSync("output");
fs.ensureDirSync("keys");

app.use(express.static("public"));

const jobs = {};

// upload
app.post("/upload", upload.single("apk"), async (req, res) => {
  if (!req.file) return res.status(400).send("No file");

  const id = uuidv4();
  const apk = `uploads/${id}.apk`;
  const signed = `output/signed_${id}.apk`;
  const keystore = `keys/${id}.jks`;

  await fs.move(req.file.path, apk);
  jobs[id] = { status: "signing" };

  (async () => {
    try {
      await run(`keytool -genkeypair -keystore ${keystore} -storepass pass123 -keypass pass123 -alias alias -keyalg RSA -dname "CN=APK"`);

      await run(`apksigner sign --ks ${keystore} --ks-pass pass:pass123 --key-pass pass:pass123 --out ${signed} ${apk}`);

      jobs[id] = { status: "done", downloadUrl: `/download/${id}` };
    } catch (e) {
      jobs[id] = { status: "error", error: e.toString() };
    }
  })();

  res.json({ jobId: id });
});

// status
app.get("/status/:id", (req, res) => {
  res.json(jobs[req.params.id] || { status: "unknown" });
});

// download
app.get("/download/:id", (req, res) => {
  const file = `output/signed_${req.params.id}.apk`;
  if (!fs.existsSync(file)) return res.status(404).send("Not found");
  res.download(file);
});

function run(cmd) {
  return new Promise((ok, err) => {
    exec(cmd, (e) => (e ? err(e) : ok()));
  });
}

app.listen(3000, () => console.log("✅ Server running on 3000"));