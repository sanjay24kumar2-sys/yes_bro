// server.js
const express = require("express");
const multer = require("multer");
const fs = require("fs-extra");
const path = require("path");
const { exec, execSync } = require("child_process");
const ApkReader = require("adbkit-apkreader");

const app = express();

// static + JSON limits
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));
app.use(express.static(path.join(__dirname, "public")));

// make required dirs
["uploads","uploads_tmp","output","keys"].forEach(d=>fs.ensureDirSync(d));

// multer
const upload = multer({ dest:"uploads_tmp/", limits:{ fileSize:50*1024*1024 } });

// keystore
const KEYSTORE = path.join(__dirname,"keys/master.jks");
const PASS="mypassword", ALIAS="master";

// create keystore if missing
if (!fs.existsSync(KEYSTORE)) {
  execSync(
    `keytool -genkeypair -keystore "${KEYSTORE}" -storepass ${PASS} -keypass ${PASS} -alias ${ALIAS} -keyalg RSA -keysize 2048 -validity 10000 -storetype PKCS12 -dname "CN=Android,O=SignerApp,C=IN"`
  );
}

// tools
const BUILD_TOOLS="/opt/android-sdk/build-tools/34.0.0";
const APKSIGNER=path.join(BUILD_TOOLS,"apksigner");
const ZIPALIGN=path.join(BUILD_TOOLS,"zipalign");

// job store
const jobs = {};

// extract package name
async function getPackageName(apkPath){
  try {
    const reader = await ApkReader.open(apkPath);
    const manifest = await reader.readManifest();
    return manifest.package;
  } catch {
    return null;
  }
}

// async signing background
function startSigning(jobId, rawPath, originalPackage){
  const aligned=path.join("uploads",`${jobId}_aligned.apk`);
  const signed=path.join("output",`${jobId}_signed.apk`);

  jobs[jobId] = { status:"processing", originalPackage };

  exec(
    `"${ZIPALIGN}" -p 4 "${rawPath}" "${aligned}" && \
     "${APKSIGNER}" sign --ks "${KEYSTORE}" --ks-key-alias "${ALIAS}" \
       --ks-pass pass:${PASS} --key-pass pass:${PASS} \
       --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true \
       --out "${signed}" "${aligned}"`,
    { maxBuffer:1024*1024*15 },
    async(err, stdout, stderr)=>{
      if(err){
        jobs[jobId] = { status:"error", error: stderr||err.message };
      } else {
        // get output signed package name
        const newPkg = await getPackageName(signed);
        jobs[jobId] = {
          status:"done",
          originalPackage,
          signedPackage:newPkg,
          downloadUrl:`/download/${jobId}`
        };
      }
    }
  );
}

// upload endpoint
app.post("/upload", upload.single("apk"), async (req,res)=>{
  if(!req.file) return res.status(400).json({error:"No APK uploaded"});

  const jobId = Date.now().toString();
  const rawPath = path.join("uploads",`${jobId}.apk`);
  await fs.move(req.file.path, rawPath,{overwrite:true});

  // get original package
  const originalPkg = await getPackageName(rawPath);

  // start signing in background
  startSigning(jobId, rawPath, originalPkg);

  res.json({ jobId, originalPkg, message:"Signing started" });
});

// job status
app.get("/status/:jobId",(req,res)=>{
  const job = jobs[req.params.jobId];
  if(!job) return res.status(404).json({status:"not found"});
  res.json(job);
});

// download
app.get("/download/:jobId",(req,res)=>{
  const file = path.join("output",`${req.params.jobId}_signed.apk`);
  if(!fs.existsSync(file)) return res.status(404).send("Signing not ready");
  res.download(file,"signed.apk");
});

// health check
app.get("/health",(req,res)=>res.json({status:"ok"}));

const PORT=process.env.PORT||3000;
app.listen(PORT,"0.0.0.0",()=>console.log(`Server listening on ${PORT}`));
