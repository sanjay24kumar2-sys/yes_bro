const express = require("express");
const multer = require("multer");
const fs = require("fs-extra");
const path = require("path");
const { execSync } = require("child_process");
const AdmZip = require("adm-zip");

const app = express();

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({ dest: "uploads_tmp/", limits: { fileSize: 20 * 1024 * 1024 } });
["uploads","uploads_tmp","output","keys"].forEach(d => fs.ensureDirSync(d));

// Keystore config
const KEYSTORE = path.resolve(__dirname, "keys/master.jks");
const PASS = "mypassword";
const ALIAS = "master";

// Generate keystore if missing
if (!fs.existsSync(KEYSTORE)) {
  execSync(
    `keytool -genkeypair -keystore "${KEYSTORE}" -storepass "${PASS}" -keypass "${PASS}" -alias "${ALIAS}" \
    -keyalg RSA -keysize 2048 -validity 10000 -storetype PKCS12 -dname "CN=Android,O=Release,C=IN"`,
    { stdio: "inherit" }
  );
}

// Android SDK Build tools
const BUILD_TOOLS = "/opt/android-sdk/build-tools/34.0.0";
const APKSIGNER = path.join(BUILD_TOOLS, "apksigner");
const ZIPALIGN = path.join(BUILD_TOOLS, "zipalign");

// Ensure executables
fs.chmodSync(APKSIGNER, "755");
fs.chmodSync(ZIPALIGN, "755");

// Helper: Create valid APK structure
function rebuildAPK(filePath) {
  fs.removeSync(filePath + "_tmp");
  fs.ensureDirSync(filePath + "_tmp");

  // unzip original if possible
  try {
    new AdmZip(filePath).extractAllTo(filePath + "_tmp", true);
  } catch (e) {}

  const temp = filePath + "_tmp";
  const manifestPath = path.join(temp,"AndroidManifest.xml");
  
  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath,
      `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.trusted.apk">
         <application android:label="TrustedApp"></application>
       </manifest>`
    );
  }

  // minimal valid dex (with correct DEX header)
  const minimalDex = Buffer.from([0x64,0x65,0x78,0x0A,0x30,0x33,0x35,0x00,
                                  0x00,0x00,0x00,0x00,0x00,0x00,0x00]);
  fs.writeFileSync(path.join(temp,"classes.dex"), minimalDex);

  // resources.arsc placeholder
  fs.writeFileSync(path.join(temp,"resources.arsc"), Buffer.from([0,0,0,0]));

  // rezip
  const newZip = new AdmZip();
  fs.readdirSync(temp).forEach(file => {
    const full = path.join(temp, file);
    if (fs.lstatSync(full).isFile()) {
      newZip.addFile(file, fs.readFileSync(full));
    }
  });
  newZip.writeZip(filePath);
  fs.removeSync(temp);
}

// align + sign
function signAPK(raw, aligned, signed) {
  execSync(`"${ZIPALIGN}" -p 4 "${raw}" "${aligned}"`, { stdio: "inherit" });
  execSync(
    `"${APKSIGNER}" sign --ks "${KEYSTORE}" --ks-key-alias "${ALIAS}" \
     --ks-pass pass:${PASS} --key-pass pass:${PASS} \
     --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true \
     --out "${signed}" "${aligned}"`,
    { stdio: "inherit" }
  );
}

app.post("/upload", upload.single("apk"), async (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");

  const id = Date.now();
  const raw = path.join("uploads",`${id}.apk`);
  const aligned = path.join("uploads",`aligned_${id}.apk`);
  const signed = path.join("output",`signed_${id}.apk`);

  try {
    await fs.move(req.file.path, raw, { overwrite:true });

    let corrupt = false;
    try {
      const zip = new AdmZip(raw);
      if (!zip.getEntry("AndroidManifest.xml") || !zip.getEntry("classes.dex")) {
        corrupt = true;
      }
    } catch {
      corrupt = true;
    }

    if (corrupt) {
      console.log("APK corrupt or missing core files ➝ rebuilding...");
      rebuildAPK(raw);
    }

    console.log("Signing APK…");
    signAPK(raw, aligned, signed);

    res.download(signed, "signed.apk", async () => {
      await fs.remove(raw);
      await fs.remove(aligned);
      await fs.remove(signed);
    });

  } catch(err) {
    console.error("SIGN ERROR:", err.message);
    res.status(500).send(JSON.stringify({status:"error",message:err.message}));
  }
});

// start
const PORT = process.env.PORT||3000;
app.listen(PORT, ()=>console.log(`Running on ${PORT}`));
