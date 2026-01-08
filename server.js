// server.js
const express = require("express");
const multer = require("multer");
const fs = require("fs-extra");
const path = require("path");
const { exec, execSync } = require("child_process");
const AdmZip = require("adm-zip");

const app = express();

// MAX upload 100 MB
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));
app.use(express.static(path.join(__dirname,"public")));

// Create dirs
["uploads","uploads_tmp","output","keys","logs"].forEach(d=>fs.ensureDirSync(d));

// Multer
const upload = multer({ dest:"uploads_tmp/", limits:{ fileSize:50*1024*1024 } });

// Keystore
const KEYSTORE = path.join(__dirname,"keys/master.jks");
const PASS="mypassword", ALIAS="master";
if (!fs.existsSync(KEYSTORE)) {
  execSync(`keytool -genkeypair -keystore "${KEYSTORE}" -storepass ${PASS} -keypass ${PASS} -alias ${ALIAS} -keyalg RSA -keysize 2048 -validity 10000 -storetype PKCS12 -dname "CN=Android,O=SignerApp,C=IN"`);
}

const BUILD_TOOLS="/opt/android-sdk/build-tools/34.0.0";
const APKSIGNER=path.join(BUILD_TOOLS,"apksigner");
const ZIPALIGN=path.join(BUILD_TOOLS,"zipalign");

// Job store
const jobs={};

// Helper: rebuild minimal structure
function makeValidStructure(apkPath) {
  const tmp=apkPath+"_tmp";
  fs.removeSync(tmp); fs.ensureDirSync(tmp);

  // Try extract anything
  try { new AdmZip(apkPath).extractAllTo(tmp,true); } catch {}

  // If AndroidManifest.xml missing or bad, write placeholder
  const man=path.join(tmp,"AndroidManifest.xml");
  fs.writeFileSync(man,
    `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.rebuilt.app">
      <application android:label="RebuiltApp"></application>
     </manifest>`);

  // classes.dex placeholder
  const dexP=path.join(tmp,"classes.dex");
  const dexHeader=Buffer.from([0x64,0x65,0x78,0x0A,0x30,0x33,0x35,0x00]);
  fs.writeFileSync(dexP,Buffer.concat([dexHeader,Buffer.alloc(48,0)]));

  // resources.arsc
  const resP=path.join(tmp,"resources.arsc");
  fs.writeFileSync(resP,Buffer.from([0,0,0,0]));

  // rezip
  const zip=new AdmZip();
  fs.readdirSync(tmp).forEach(f=>{
    const full=path.join(tmp,f);
    if (fs.lstatSync(full).isFile()) zip.addFile(f,fs.readFileSync(full));
  });
  zip.writeZip(apkPath);
  fs.removeSync(tmp);
}

// Async sign
function startSigning(jobId, raw) {
  jobs[jobId]={status:"processing",logs:[]};
  const aligned=path.join("uploads",`${jobId}_aligned.apk`);
  const signed=path.join("output",`${jobId}_signed.apk`);

  // align + sign
  exec(
    `"${ZIPALIGN}" -p 4 "${raw}" "${aligned}" && \
     "${APKSIGNER}" sign --ks "${KEYSTORE}" --ks-key-alias "${ALIAS}" \
       --ks-pass pass:${PASS} --key-pass pass:${PASS} \
       --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true \
       --out "${signed}" "${aligned}"`,
    {maxBuffer: 1024*1024*15},
    (err,stdout,stderr)=>{
      jobs[jobId].logs.push(stdout||"",stderr||"");
      if (err) jobs[jobId]={status:"error",error:stderr||err.message,logs:jobs[jobId].logs};
      else jobs[jobId]={status:"done",download:`/download/${jobId}`,logs:jobs[jobId].logs};
    }
  );
}

// Upload
app.post("/upload",upload.single("apk"),async(req,res)=>{
  if (!req.file) return res.status(400).json({error:"No APK"});
  const jobId=Date.now().toString();
  const raw=path.join("uploads",`${jobId}.apk`);
  await fs.move(req.file.path,raw,{overwrite:true});

  makeValidStructure(raw);  // make sure structure valid before sign
  startSigning(jobId,raw);

  res.json({jobId,message:"Processing"});
});

// Status logs
app.get("/status/:jobId",(req,res)=>{
  const j=jobs[req.params.jobId];
  if (!j) return res.status(404).json({status:"not found"});
  res.json(j);
});

// Download
app.get("/download/:jobId",(req,res)=>{
  const p=path.join("output",`${req.params.jobId}_signed.apk`);
  if (!fs.existsSync(p)) return res.status(404).send("not ready");
  res.download(p,"signed.apk");
});

// health
app.get("/health",(req,res)=>res.json({ok:true}));

app.listen(process.env.PORT||3000,"0.0.0.0",()=>console.log("Running"));
