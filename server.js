const express = require("express");
const multer = require("multer");
const { execSync } = require("child_process");
const fs = require("fs-extra");
const path = require("path");
const AdmZip = require("adm-zip");

const app = express();

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({ dest: "uploads_tmp/", limits: { fileSize: 20 * 1024 * 1024 } });
["uploads", "uploads_tmp", "output", "keys"].forEach((d) => fs.ensureDirSync(d));

const KEYSTORE = path.resolve(__dirname, "keys/master.jks");
const PASS = "mypassword";
const ALIAS = "master";

// Generate keystore if missing
if (!fs.existsSync(KEYSTORE)) {
  console.log("🔑 Generating keystore...");
  execSync(
    `keytool -genkeypair -keystore "${KEYSTORE}" -storepass "${PASS}" -keypass "${PASS}" -alias "${ALIAS}" -keyalg RSA -keysize 2048 -validity 10000 -storetype PKCS12 -dname "CN=Android,O=Release,C=IN"`,
    { stdio: "inherit" }
  );
  console.log("✅ Keystore generated!");
}

const BUILD_TOOLS = "/opt/android-sdk/build-tools/34.0.0";
const APKSIGNER = path.join(BUILD_TOOLS, "apksigner");
const ZIPALIGN = path.join(BUILD_TOOLS, "zipalign");

fs.chmodSync(APKSIGNER, "755");
fs.chmodSync(ZIPALIGN, "755");

// ---------- Utility Functions ----------

// Analyze APK to check if corrupted
function analyzeAPK(filePath) {
  try {
    const zip = new AdmZip(filePath);
    const manifest = zip.getEntry("AndroidManifest.xml");
    const dex = zip.getEntry("classes.dex");
    return {
      isCorrupt: !manifest || !dex || manifest.header.size === 0 || dex.header.size === 0,
      zip,
    };
  } catch {
    return { isCorrupt: true, zip: null };
  }
}

// Rebuild corrupted APK with minimal valid files
function rebuildCorruptedAPK(filePath, oldZip) {
  const zip = oldZip || new AdmZip();

  // Add minimal AndroidManifest.xml if missing
  if (!zip.getEntry("AndroidManifest.xml")) {
    zip.addFile("AndroidManifest.xml", Buffer.from('<manifest package="com.trusted.temp"/>'));
  }

  // Add minimal classes.dex if missing
  if (!zip.getEntry("classes.dex")) {
    // Minimal DEX header + empty class
    zip.addFile(
      "classes.dex",
      Buffer.from([
        0x64,0x65,0x78,0x0A,0x30,0x33,0x35,0x00, // dex\n035 header
        0x00,0x00,0x00,0x00 // padding
      ])
    );
  }

  // Add dummy resources.arsc if missing
  if (!zip.getEntry("resources.arsc")) {
    zip.addFile("resources.arsc", Buffer.from([0x00,0x00,0x00,0x00]));
  }

  zip.writeZip(filePath);
}

// Sign APK with retry logic
async function signAPK(rawPath, alignedPath, signedPath) {
  try {
    execSync(`"${ZIPALIGN}" -p 4 "${rawPath}" "${alignedPath}"`, { stdio: "inherit" });
    execSync(
      `"${APKSIGNER}" sign \
      --ks "${KEYSTORE}" \
      --ks-key-alias "${ALIAS}" \
      --ks-pass pass:${PASS} \
      --key-pass pass:${PASS} \
      --v1-signing-enabled false \
      --v2-signing-enabled true \
      --v3-signing-enabled true \
      --out "${signedPath}" \
      "${alignedPath}"`,
      { stdio: "inherit" }
    );
    execSync(`"${APKSIGNER}" verify --verbose "${signedPath}"`, { stdio: "inherit" });
    return true;
  } catch (err) {
    console.warn("⚠️ Signing attempt failed:", err.message);
    return false;
  }
}

// ---------- Upload Route ----------
app.post("/upload", upload.single("apk"), async (req, res) => {
  if (!req.file) return res.status(400).send("⚠️ No APK uploaded");

  const id = Date.now();
  const raw = path.join("uploads", `${id}.apk`);
  const aligned = path.join("uploads", `aligned_${id}.apk`);
  const signed = path.join("output", `signed_${id}.apk`);

  try {
    await fs.move(req.file.path, raw, { overwrite: true });

    // Analyze APK
    let { isCorrupt, zip } = analyzeAPK(raw);

    let signedSuccessfully = await signAPK(raw, aligned, signed);

    // Retry with rebuilt minimal APK if corrupted or first attempt failed
    if (!signedSuccessfully || isCorrupt) {
      console.warn("⚠️ First attempt failed or APK corrupted. Rebuilding and retrying...");
      rebuildCorruptedAPK(raw, zip);
      signedSuccessfully = await signAPK(raw, aligned, signed);
    }

    if (!signedSuccessfully) throw new Error("Signing failed even after retry.");

    res.download(signed, "signed.apk", async () => {
      await fs.remove(raw);
      await fs.remove(aligned);
      await fs.remove(signed);
    });
  } catch (err) {
    console.error("❌ SIGNING ERROR:", err.message);
    res.status(500).json({ status: "error", message: "Signing failed. Check server logs." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}...`));
