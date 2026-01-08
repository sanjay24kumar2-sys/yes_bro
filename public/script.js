const form = document.getElementById("form");
const status = document.getElementById("status");

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const file = document.getElementById("apk").files[0];
  if (!file) return;

  status.innerText = "Signing APK... please wait";

  const data = new FormData();
  data.append("apk", file);

  const res = await fetch("/upload", {
    method: "POST",
    body: data
  });

  if (!res.ok) {
    status.innerText = "Error signing APK";
    return;
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "signed.apk";
  a.click();

  status.innerText = "Done ✔ APK downloaded";
});
