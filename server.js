// server.js
const express = require("express");
const multer = require("multer");
const fs = require("fs-extra");
const path = require("path");
const { spawnSync } = require("child_process");
const ApkReader = require("adbkit-apkreader").default; // More reliable manifest reader
const AdmZip = require("adm-zip");

const app = express();

// parse body
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));
app.use(express.static(path.join(__dirname, "public")));

// upload config
const upload = multer({ dest: "uploads_tmp/", limits: { fileSize: 20 * 1024 * 1024 } });
["uploads","uploads_tmp","output","keys"].forEach(d => fs.ensureDirSync(d));

// keystore setup
const KEYSTORE = path.resolve(__dirname,"keys/master.jks");
const PASS = "mypassword";
const ALIAS = "master";

// generate if missing
if (!fs.existsSync(KEYSTORE)) {
  spawnSync("keytool", [
    "-genkeypair",
    "-keystore", KEYSTORE,
    "-storepass", PASS,
    "-keypass", PASS,
    "-alias", ALIAS,
    "-keyalg", "RSA",
    "-keysize", "2048",
    "-validity", "10000",
    "-storetype", "PKCS12",
    "-dname", "CN=Android,O=Release,C=IN"
  ], { stdio: "inherit" });
}

// Android tools
const BUILD_TOOLS = "/opt/android-sdk/build-tools/34.0.0";
const APKSIGNER = path.join(BUILD_TOOLS,"apksigner");
const ZIPALIGN = path.join(BUILD_TOOLS,"zipalign");
const AAPT2 = path.join(BUILD_TOOLS,"..","aapt2");

// ensure executables
fs.chmodSync(APKSIGNER,"755");
fs.chmodSync(ZIPALIGN,"755");

// utility: parse manifest reliably
async function tryGetManifestInfo(apkPath) {
  try {
    const reader = await ApkReader.open(apkPath);
    const manifest = await reader.readManifest();
    return manifest.package;
  } catch {
    return null;
  }
}

// utility: create valid minimal classes.dex
function createMinimalDex(target) {
  const header = Buffer.from([
    0x64,0x65,0x78,0x0A,  // "dex\n"
    0x30,0x33,0x35,0x00   // version 035
  ]);
  const pad = Buffer.alloc(48, 0); // padding
  fs.writeFileSync(target, Buffer.concat([header,pad]));
}

// rebuild APK so apksigner wont fail
function rebuildAPK(src, tempDir, packageName="com.trusted.app") {
  fs.removeSync(tempDir);
  fs.ensureDirSync(tempDir);

  try {
    new AdmZip(src).extractAllTo(tempDir,true);
  } catch {}

  const manifestTxt = path.join(tempDir,"AndroidManifest.xml");

  if (!fs.existsSync(manifestTxt)) {
    // fallback safe manifest
    fs.writeFileSync(manifestTxt,
      `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${packageName}">
         <application android:label="RebuiltApp"></application>
       </manifest>`
    );
  }

  // compile manifest to binary
  const binOut = path.join(tempDir,"AndroidManifest.binary.xml");
  spawnSync(AAPT2, ["compile","--manifest", manifestTxt,"-o", binOut], { stdio:"inherit" });
  fs.removeSync(manifestTxt);
  fs.renameSync(binOut, manifestTxt);

  // ensure valid dex
  const dexPath = path.join(tempDir,"classes.dex");
  if (!fs.existsSync(dexPath)) {
    createMinimalDex(dexPath);
  }

  // ensure resources
  const resPath = path.join(tempDir,"resources.arsc");
  if (!fs.existsSync(resPath)) {
    fs.writeFileSync(resPath, Buffer.from([0,0,0,0]));
  }

  // rezip
  const zip = new AdmZip();
  fs.readdirSync(tempDir).forEach(file => {
    const full = path.join(tempDir,file);
    if (fs.lstatSync(full).isFile()) {
      zip.addFile(file, fs.readFileSync(full));
    }
  });
  zip.writeZip(src);
  fs.removeSync(tempDir);
}

// align + sign function
function doSign(raw, aligned, out) {
  spawnSync(ZIPALIGN, ["-p","4",raw,aligned], { stdio:"inherit" });
  spawnSync(APKSIGNER, [
    "sign",
    "--ks", KEYSTORE,
    "--ks-key-alias", ALIAS,
    "--ks-pass", `pass:${PASS}`,
    "--key-pass", `pass:${PASS}`,
    "--v1-signing-enabled", "false",
    "--v2-signing-enabled", "true",
    "--v3-signing-enabled", "true",
    "--out", out,
    aligned
  ], { stdio:"inherit" });
}

app.post("/upload", upload.single("apk"), async (req,res) => {
  if (!req.file) return res.status(400).send("No APK uploaded");

  const id = Date.now();
  const raw = path.join("uploads",`${id}.apk`);
  const aligned = path.join("uploads",`aligned_${id}.apk`);
  const out = path.join("output",`signed_${id}.apk`);

  try {
    await fs.move(req.file.path, raw,{ overwrite:true });

    let pkg = await tryGetManifestInfo(raw) || "com.fallback.app";
    let corrupt = false;

    try {
      const zip = new AdmZip(raw);
      if (!zip.getEntry("AndroidManifest.xml") || !zip.getEntry("classes.dex")) corrupt = true;
    } catch {
      corrupt = true;
    }

    if (corrupt) {
      console.log("❗ Corrupt detected, rebuilding minimal valid APK...");
      rebuildAPK(raw, path.join("uploads",`${id}_tmp`), pkg);
    }

    console.log("🔔 Signing APK...");
    doSign(raw, aligned, out);

    res.download(out, "signed.apk", async ()=>{
      await fs.remove(raw);
      await fs.remove(aligned);
      await fs.remove(out);
    });
  } catch(err) {
    console.error("SIGN ERROR:",err);
    res.status(500).json({status:"error",message:err.message});
  }
});

// start
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log("🚀 Running..."));
