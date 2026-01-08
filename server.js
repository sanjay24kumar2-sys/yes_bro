// server.js
const express = require("express");
const multer = require("multer");
const fs = require("fs-extra");
const path = require("path");
const { execSync } = require("child_process");
const AdmZip = require("adm-zip");

const app = express();

// parse body
app.use(express.json({ limit:"50mb" }));
app.use(express.urlencoded({ extended:true, limit:"50mb" }));
app.use(express.static(path.join(__dirname,"public")));

// upload config
const upload = multer({ dest:"uploads_tmp/", limits:{ fileSize:20*1024*1024 } });
["uploads","uploads_tmp","output","keys"].forEach(d => fs.ensureDirSync(d));

// keystore
const KEYSTORE = path.resolve(__dirname,"keys/master.jks");
const PASS = "mypassword";
const ALIAS = "master";

// generate keystore if missing
if (!fs.existsSync(KEYSTORE)) {
  execSync(`keytool -genkeypair -keystore "${KEYSTORE}" -storepass "${PASS}" -keypass "${PASS}" -alias "${ALIAS}" -keyalg RSA -keysize 2048 -validity 10000 -storetype PKCS12 -dname "CN=Android,O=Release,C=IN"`);
}

// SDK tools
const BUILD_TOOLS = "/opt/android-sdk/build-tools/34.0.0";
const APKSIGNER = path.join(BUILD_TOOLS,"apksigner");
const ZIPALIGN = path.join(BUILD_TOOLS,"zipalign");
const AAPT2 = path.join(BUILD_TOOLS,"..","aapt2"); // ensure aapt2 installed

// make sure executables are allowed
fs.chmodSync(APKSIGNER,"755");
fs.chmodSync(ZIPALIGN,"755");

// helper to rebuild valid minimal APK
function rebuildAPK(srcZipPath, tempDir) {
  fs.removeSync(tempDir);
  fs.ensureDirSync(tempDir);

  // unzip original
  try {
    new AdmZip(srcZipPath).extractAllTo(tempDir,true);
  } catch {}

  // ensure AndroidManifest.xml exists
  const manifestPath = path.join(tempDir,"AndroidManifest.xml");
  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath,
      `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.trusted.app">
       <application android:label="TrustedApp"></application>
       </manifest>`);
  }

  // compile manifest to binary XML
  const compiledManifest = path.join(tempDir,"AndroidManifestComp.xml");
  execSync(`"${AAPT2}" compile --manifest "${manifestPath}" -o "${compiledManifest}"`,{stdio:"inherit"});

  // remove old text manifest
  fs.removeSync(manifestPath);
  fs.renameSync(compiledManifest,manifestPath);

  // ensure dex
  if (!fs.existsSync(path.join(tempDir,"classes.dex"))) {
    const minimalDex = Buffer.from([0x64,0x65,0x78,0x0A,0x30,0x33,0x35,0x00,0,0,0,0]);
    fs.writeFileSync(path.join(tempDir,"classes.dex"),minimalDex);
  }

  // ensure resources.arsc
  if (!fs.existsSync(path.join(tempDir,"resources.arsc"))) {
    fs.writeFileSync(path.join(tempDir,"resources.arsc"),Buffer.from([0,0,0,0]));
  }

  // rezip
  const newZip = new AdmZip();
  fs.readdirSync(tempDir).forEach(f=>{
    const full = path.join(tempDir,f);
    if (fs.lstatSync(full).isFile()) {
      newZip.addFile(f,fs.readFileSync(full));
    }
  });
  newZip.writeZip(srcZipPath);
}

// align & sign
function alignAndSign(raw,aligned,signed) {
  execSync(`"${ZIPALIGN}" -p 4 "${raw}" "${aligned}"`,{stdio:"inherit"});
  execSync(
    `"${APKSIGNER}" sign --ks "${KEYSTORE}" --ks-key-alias "${ALIAS}" --ks-pass pass:${PASS} --key-pass pass:${PASS} --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true --out "${signed}" "${aligned}"`,
    {stdio:"inherit"}
  );
}

app.post("/upload", upload.single("apk"), async (req,res)=>{
  if (!req.file) return res.status(400).send("No upload");

  const id = Date.now();
  const raw = path.join("uploads",`${id}.apk`);
  const aligned = path.join("uploads",`aligned_${id}.apk`);
  const signed = path.join("output",`signed_${id}.apk`);

  try {
    await fs.move(req.file.path,raw,{overwrite:true});

    // analyze
    const corrupt = (() => {
      try {const z=new AdmZip(raw); return !z.getEntry("AndroidManifest.xml");} catch {return true;}
    })();

    if (corrupt) {
      console.log("🔧 Rebuilding minimal valid APK format...");
      rebuildAPK(raw,path.join("uploads",`${id}_temp`));
    }

    console.log("🛠 Align & Sign...");
    alignAndSign(raw,aligned,signed);

    res.download(signed,"signed.apk", async ()=>{
      await fs.remove(raw);
      await fs.remove(aligned);
      await fs.remove(signed);
    });
  } catch(err) {
    console.error("SIGN ERROR:",err.message);
    res.status(500).send(JSON.stringify({status:"error",message:err.message}));
  }
});

const PORT = process.env.PORT||3000;
app.listen(PORT,()=>console.log(`🚀 Running on ${PORT}...`));
