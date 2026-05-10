const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs").promises;
const { execSync, spawn } = require("child_process");
const readline = require("readline");

const CONFIG_FILE = "agent_config.json";
const HISTORY_FILE = "chat_history.json";

const models = [
  "gemini-2.0-flash",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.5-pro",
  "gemini-3-pro-preview",
  "gemma-4-26b-a4b-it",
  "gemma-4-31b-it"
];

let chatHistory = [];

// ---------- HISTORY ----------

async function loadHistory() {
  try {
    const data = await fs.readFile(HISTORY_FILE, "utf8");
    chatHistory = JSON.parse(data);
  } catch {
    chatHistory = [];
  }
}

async function saveHistory() {
  await fs.writeFile(HISTORY_FILE, JSON.stringify(chatHistory, null, 2));
}

// ---------- CONFIG ----------

function getConfig() {
  try {
    const fsSync = require("fs");
    const raw = fsSync.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);

    if (!models.includes(parsed.model)) {
      parsed.model = models[0];
    }
    if (typeof parsed.auto !== "boolean") {
      parsed.auto = false;
    }
    return parsed;
  } catch {
    return { model: models[0], auto: false };
  }
}

function saveConfig(newConfig) {
  const fsSync = require("fs");
  const current = getConfig();
  fsSync.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({ ...current, ...newConfig }, null, 2)
  );
}

// ---------- CLI ----------

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "➤ "
});

let loadingInterval;
function startLoading(msg = "Berpikir...") {
  const P = ["\\", "|", "/", "-"];
  let x = 0;
  process.stdout.write(`\r ${P[0]} ${msg}`);
  loadingInterval = setInterval(() => {
    process.stdout.write(`\r ${P[x++ % P.length]} ${msg}`);
  }, 100);
}

function stopLoading() {
  if (loadingInterval) {
    clearInterval(loadingInterval);
    process.stdout.write("\r\x1b[K");
    loadingInterval = null;
  }
}

function cleanText(text) {
  return text.replace(/\*\*/g, "").replace(/\*/g, "").trim();
}

// ---------- INTENT DETECTION (GLOBAL, RULE-BASED) ----------

function isFileTask(text) {
  const t = text.toLowerCase();

  const verbs = [
    "buat", "tulis", "edit", "ubah", "perbaiki",
    "refactor", "pindah", "pindahin", "pindahkan",
    "rename", "copy", "salin", "duplikat",
    "hapus", "hapus semua", "bersihin", "bersihkan",
    "lihat isi", "tampilkan isi", "baca file", "tunjukin isi",
    "cek", "periksa", "generate", "jalankan", "run"
  ];

  const commands = ["rm ", "mv ", "cp ", "cat ", "less ", "tail ", "head ", "mkdir "];

  const fileHints = [
    "file", "folder", "direktori", "directory",
    ".js", ".ts", ".sh", ".json", ".html", ".css", ".env", ".log",
    "package.json", "node_modules"
  ];

  const hitVerb = verbs.some(v => t.includes(v));
  const hitCmd = commands.some(c => t.includes(c));
  const hitHint = fileHints.some(h => t.includes(h));

  return hitVerb || hitCmd || hitHint;
}

function isDeleteIntent(text) {
  const t = text.toLowerCase();
  return (
    t.includes("hapus") ||
    t.includes("hapus semua") ||
    t.includes("delete") ||
    t.includes("remove") ||
    t.includes("rm ") ||
    t.includes("rm -rf") ||
    t.includes("bersihin") ||
    t.includes("bersihkan")
  );
}

function isMoveOrRenameIntent(text) {
  const t = text.toLowerCase();
  return (
    t.includes("rename") ||
    t.includes("ganti nama") ||
    t.includes("pindah") ||
    t.includes("pindahin") ||
    t.includes("mv ") ||
    t.includes("move ")
  );
}

function isCopyIntent(text) {
  const t = text.toLowerCase();
  return (
    t.includes("copy") ||
    t.includes("salin") ||
    t.includes("duplikat") ||
    t.includes("cp ")
  );
}

function isMkdirIntent(text) {
  const t = text.toLowerCase();
  return (
    t.includes("buat folder") ||
    t.includes("buat direktori") ||
    t.includes("buat directory") ||
    t.includes("mkdir ")
  );
}

function isViewFileIntent(text) {
  const t = text.toLowerCase();
  return (
    t.includes("lihat isi") ||
    t.includes("tampilkan isi") ||
    t.includes("baca file") ||
    t.includes("tunjukin isi") ||
    t.includes("lihat file") ||
    t.includes("cek isi") ||
    t.includes("cat ") ||
    t.includes("less ") ||
    t.includes("tail ") ||
    t.includes("head ")
  );
}

function isCheckSomethingIntent(text) {
  const t = text.toLowerCase();
  return (
    t.includes("cek") ||
    t.includes("periksa") ||
    t.includes("sudah pakai") ||
    t.includes("sudah pake") ||
    t.includes("sudah terinstal") ||
    t.includes("sudah terinstall") ||
    t.includes("sudah ada belum") ||
    t.includes("udah ada belum") ||
    t.includes("ada atau belum")
  );
}

function isChangeDirIntent(text) {
  const t = text.toLowerCase();
  return (
    t.startsWith("cd ") ||
    t.includes("pindah ke folder") ||
    t.includes("pindah ke direktori") ||
    t.includes("pindah ke directory")
  );
}

function detectModeChange(text) {
  const t = text.toLowerCase();
  const wantsAuto =
    t.includes("mode auto") ||
    t.includes("jadi auto") ||
    t.includes("pindah ke auto") ||
    t.includes("auto mode") ||
    t.includes("otomatis") ||
    t.includes("jalan sendiri");

  const wantsManual =
    t.includes("mode manual") ||
    t.includes("jadi manual") ||
    t.includes("pindah ke manual") ||
    t.includes("manual aja") ||
    t.includes("konfirmasi dulu") ||
    t.includes("jangan auto");

  if (wantsAuto && !wantsManual) return "auto";
  if (wantsManual && !wantsAuto) return "manual";
  return null;
}

function detectModelChange(text) {
  const t = text.toLowerCase();
  let target = null;

  const patterns = [
    /model\s+([a-z0-9.\-]+)\b/i,
    /pakai\s+([a-z0-9.\-]+)\b/i,
    /pindah\s+ke\s+([a-z0-9.\-]+)\b/i,
    /gunakan\s+([a-z0-9.\-]+)\b/i
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) {
      target = m[1];
      break;
    }
  }

  if (!target) return null;
  target = target.replace(/\s+/g, "-");
  const found = models.find((m) => m.toLowerCase() === target.toLowerCase());
  return found || null;
}

// ---------- PARSER RESPON AI ----------

async function parseResponse(response) {
  const lines = response.split("\n");
  let fileName = null;
  let fileContent = null;
  let inFile = false;
  let installCmd = null;
  let runCmd = null;

  let rmCmd = null;
  let mvCmd = null;
  let cpCmd = null;
  let mkdirCmd = null;
  let viewCmd = null;

  for (let line of lines) {
    const rawLine = line;
    const trimmed = line.trim();

    if (trimmed.startsWith("FILE:")) {
      fileName = trimmed.slice(5).trim();
      inFile = true;
      continue;
    }
    if (trimmed.startsWith("KODE:")) {
      continue;
    }
    if (inFile && trimmed === "---END---") {
      inFile = false;
      continue;
    }
    if (inFile && fileName) {
      fileContent = (fileContent || "") + rawLine + "\n";
      continue;
    }
    if (trimmed.startsWith("INSTALL:")) {
      installCmd = trimmed.slice(8).trim();
    }
    if (trimmed.startsWith("RUN:")) {
      runCmd = trimmed.slice(4).trim();
    }

    if (!trimmed || trimmed.startsWith("#")) continue;

    if (!runCmd && trimmed.startsWith("rm ")) rmCmd = trimmed;
    if (!runCmd && trimmed.startsWith("mv ")) mvCmd = trimmed;
    if (!runCmd && trimmed.startsWith("cp ")) cpCmd = trimmed;
    if (!runCmd && trimmed.startsWith("mkdir ")) mkdirCmd = trimmed;
    if (
      !runCmd &&
      (trimmed.startsWith("cat ") ||
        trimmed.startsWith("less ") ||
        trimmed.startsWith("tail ") ||
        trimmed.startsWith("head "))
    ) {
      viewCmd = trimmed;
    }
  }

  return {
    fileName,
    fileContent: fileContent?.trim(),
    installCmd,
    runCmd,
    rmCmd,
    mvCmd,
    cpCmd,
    mkdirCmd,
    viewCmd
  };
}

// ---------- EXEC HELPERS ----------

async function safeExec(cmd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { stdio: "inherit", shell: true });
    child.on("close", resolve);
  });
}

// rm .ext -> rm *.ext
function normalizeDeleteCommand(rawCmd) {
  let cmd = rawCmd.trim();
  const m = cmd.match(/^rm\s+(\.[a-z0-9*?]+)$/i);
  if (m) {
    cmd = `rm *${m[1]}`;
  }
  return cmd;
}

function previewDeleteTargets(cmd) {
  try {
    const parts = cmd.split(" ").slice(1).join(" ").trim();
    if (!parts) return null;
    const out = execSync(`ls ${parts}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return out.trim();
  } catch {
    return null;
  }
}

function previewGenericCommand(cmd) {
  try {
    const bin = cmd.split(" ")[0];
    if (bin === "mv" || bin === "cp") {
      const args = cmd.split(" ").slice(1).filter(Boolean);
      const src = args[0];
      if (src) {
        execSync(`ls ${src}`, { stdio: ["ignore", "pipe", "ignore"] });
        return `Sumber ada: ${src}`;
      }
    }
    return null;
  } catch {
    return "[Info] Sumber yang dimaksud mungkin tidak ada, periksa lagi command.";
  }
}

// ---------- CEK DEPENDENCY / FILE (GLOBAL) ----------

function readPackageJson(path = "package.json") {
  try {
    const raw = execSync(`cat ${path}`, { encoding: "utf8" });
    return raw;
  } catch {
    return null;
  }
}

function checkDependencyInstalled(depName, userInput) {
  const t = userInput.toLowerCase();
  let path = "package.json";

  if (t.includes("banucv") && !t.includes("cd ")) {
    path = "banucv/package.json";
  }

  const raw = readPackageJson(path);
  if (!raw) return false;
  return raw.includes(`"${depName}"`);
}

function checkFileExists(pattern, userInput) {
  const t = userInput.toLowerCase();
  let base = ".";

  if (t.includes("banucv") && !t.includes("cd ")) {
    base = "banucv";
  }

  try {
    const out = execSync(`cd ${base} && ls ${pattern}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((x) => `${base}/${x}`);
  } catch {
    return [];
  }
}

// Versi lebih "global" tapi masih aman
function extractCheckTarget(userInput) {
  const t = userInput.toLowerCase();

  // 1) ".ext" + kata 'file' -> file
  const mInlineFile = userInput.match(/file\s+([^\s]+\.[a-z0-9]+)/i);
  if (mInlineFile && mInlineFile[1]) {
    const name = mInlineFile[1];
    return { kind: "file", name, suggestion: `touch ${name}` };
  }

  // 2) "cek file X"
  const mFile = userInput.match(/cek\s+file\s+([^\s]+)/i);
  if (mFile && mFile[1]) {
    const name = mFile[1];
    return { kind: "file", name, suggestion: `touch ${name}` };
  }

  // 3) sebut ".env"
  if (t.includes(".env")) {
    return { kind: "file", name: ".env", suggestion: "touch .env" };
  }

  // 4) "cek NAMA" (bukan 'file')
  const mCekDep = userInput.match(/cek\s+([a-zA-Z0-9@/_\-]+)/i);
  if (mCekDep && mCekDep[1] && mCekDep[1].toLowerCase() !== "file") {
    const pkg = mCekDep[1];
    return { kind: "dependency", name: pkg, suggestion: `npm install ${pkg}` };
  }

  // 5) "NAMA sudah pakai / sudah terinstal / sudah ada"
  const pkgMatch = userInput.match(
    /([a-zA-Z0-9@/_\-]+)\s+(sudah pakai|sudah pake|sudah terinstal|sudah terinstall|sudah ada)/i
  );
  if (pkgMatch && pkgMatch[1]) {
    const pkg = pkgMatch[1];
    return {
      kind: "dependency",
      name: pkg,
      suggestion: `npm install ${pkg}`
    };
  }

  // 6) fallback global: ada kata "cek", ambil token yang tersisa
  if (t.includes("cek")) {
    const cleaned = userInput
      .replace(/cek|tolong|dong|dulu|ya|gak|nggak|ga|please/gi, "")
      .trim();

    const tokens = cleaned.split(/\s+/).filter(Boolean);
    if (tokens.length > 0) {
      const maybe = tokens[0];
      if (/\.[a-z0-9]+$/i.test(maybe)) {
        return { kind: "file", name: maybe, suggestion: `touch ${maybe}` };
      }
      return {
        kind: "dependency",
        name: maybe,
        suggestion: `npm install ${maybe}`
      };
    }
  }

  return null;
}

async function handleCheckSomething(userInput, config) {
  const target = extractCheckTarget(userInput);
  if (!target) {
    // Tidak ada pesan template; biarkan model yang menjawab di level AI kalau perlu
    return;
  }

  if (target.kind === "dependency") {
    const installed = checkDependencyInstalled(target.name, userInput);
    if (installed) {
      console.log(`Dependency ${target.name} sudah ada di package.json.`);
      return;
    }
    console.log(`Dependency ${target.name} BELUM ada di package.json.`);
    if (!target.suggestion) return;

    let proceed = config.auto;
    if (!proceed) {
      const jawab = await new Promise((res) =>
        rl.question(
          `[?] Install sekarang dengan: ${target.suggestion} ? (y/n): `,
          res
        )
      );
      proceed = jawab.trim().toLowerCase().startsWith("y");
    }
    if (proceed) {
      console.log(`[▶] Menjalankan: ${target.suggestion}`);
      await safeExec(target.suggestion);
    }
    return;
  }

  if (target.kind === "file") {
    const matches = checkFileExists(target.name, userInput);
    if (matches.length > 0) {
      console.log(`File ditemukan:\n${matches.join("\n")}`);
      return;
    }
    console.log(`File ${target.name} TIDAK ditemukan.`);
    if (!target.suggestion) return;

    let proceed = config.auto;
    if (!proceed) {
      const jawab = await new Promise((res) =>
        rl.question(
          `[?] Buat sekarang dengan: ${target.suggestion} ? (y/n): `,
          res
        )
      );
      proceed = jawab.trim().toLowerCase().startsWith("y");
    }
    if (proceed) {
      console.log(`[▶] Menjalankan: ${target.suggestion}`);
      await safeExec(target.suggestion);
    }
  }
}

// ---------- CORE ----------

async function runAI(userInput, candidateModels = null, triedQuotaFallback = false) {
  const modeChange = detectModeChange(userInput);
  const modelChange = detectModelChange(userInput);
  let config = getConfig();
  let handledByControl = false;

  if (modeChange === "auto") {
    saveConfig({ auto: true });
    config = getConfig();
    console.log(
      "Mode eksekusi diubah ke: AUTO (tanpa konfirmasi untuk tugas file/kode)."
    );
    handledByControl = true;
  } else if (modeChange === "manual") {
    saveConfig({ auto: false });
    config = getConfig();
    console.log(
      "Mode eksekusi diubah ke: MANUAL (selalu tanya dulu untuk tugas file/kode)."
    );
    handledByControl = true;
  }

  if (modelChange) {
    saveConfig({ model: modelChange });
    config = getConfig();
    console.log(`Model aktif diubah ke: ${modelChange}`);
    handledByControl = true;
  }

  if (handledByControl && !userInput.toLowerCase().includes("sekaligus")) {
    return;
  }

  if (isChangeDirIntent(userInput)) {
    const t = userInput.trim();
    let target = null;

    if (t.startsWith("cd ")) {
      target = t.slice(3).trim();
    } else {
      const m = userInput.match(
        /pindah ke (folder|direktori|directory)\s+([^\s]+)/i
      );
      if (m && m[2]) {
        target = m[2];
      }
    }

    if (!target) {
      console.log("Folder yang mau dituju apa? Contoh: cd banucv");
      return;
    }

    try {
      process.chdir(target);
      console.log(`Sekarang di: ${process.cwd()}`);
    } catch (e) {
      console.log(`Gagal pindah ke '${target}': ${String(e.message || e)}`);
    }
    return;
  }

  const queue =
    candidateModels || [config.model, ...models.filter((m) => m !== config.model)];
  const currentModel = queue[0];

  if (!process.env.GOOGLE_API_KEY && !process.env.GEMINI_API_KEY) {
    console.log(
      "[!] GOOGLE_API_KEY / GEMINI_API_KEY belum diset (export GOOGLE_API_KEY=...)"
    );
    return;
  }

  const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  const currentDir = process.cwd();
  let fileList = "";
  try {
    fileList = execSync("ls -F", { encoding: "utf8" });
  } catch {
    fileList = "Tidak bisa membaca daftar file.";
  }

  const fileTask = isFileTask(userInput);
  const deleteIntent = isDeleteIntent(userInput);
  const moveIntent = isMoveOrRenameIntent(userInput);
  const copyIntent = isCopyIntent(userInput);
  const mkdirIntent = isMkdirIntent(userInput);
  const viewIntent = isViewFileIntent(userInput);
  const checkIntent = isCheckSomethingIntent(userInput);

  if (checkIntent) {
    await handleCheckSomething(userInput, config);
    // tidak return di sini; biarkan model tetap menjawab secara natural kalau mau
  }

  startLoading(`Memakai ${currentModel}...`);

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const geminiModel = genAI.getGenerativeModel({ model: currentModel });

    const systemPrompt = `Kamu 'oy', asisten koding senior Termux. Lokasi: ${currentDir}.
Files:
${fileList}

KEMAMPUAN UTAMA (GLOBAL):
- Bantu manajemen file/folder (buat, pindah, hapus, lihat isi, dll).
- Bantu cek dan mengelola dependency (nama package apapun) dan file konfigurasi (seperti .env).
- Bantu generate, memperbaiki, dan merapikan kode (Node.js, Bash, HTML, dll).

ATURAN JAWABAN:
- Jawab langsung ke inti, bahasa Indonesia santai.
- Dilarang menulis reasoning, analisis internal, atau teks seperti "User says", "Context", "Role", "Constraints".
- Dilarang markdown (* atau **).
- Untuk pertanyaan biasa, jawab teks biasa saja.

TENTANG MODEL:
- Daftar model dan pergantian model diatur oleh skrip lewat config.
- User bisa pakai perintah: "oy ganti model" atau kalimat seperti "pakai gemini-2.5-flash".
- Kamu hanya menjelaskan, tidak mengubah model sendiri.

TENTANG MODE EKSEKUSI:
- Mode AUTO/MANUAL diatur skrip, bukan oleh kamu langsung.
- Kamu boleh menjelaskan perbedaan mode kalau ditanya.

FORMAT KHUSUS (TUGAS FILE/KODE SAJA):
- Gunakan hanya jika user jelas minta buat/ubah/perbaiki file/script:
  FILE: nama.ext
  KODE:
  (isi kode)
  ---END---
  INSTALL: perintah lengkap
  RUN: perintah lengkap

Untuk pertanyaan biasa: JANGAN gunakan FILE:, INSTALL:, atau RUN:.`;

    await loadHistory();
    const chat = geminiModel.startChat({
      history: chatHistory,
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 2048
      }
    });

    const result = await chat.sendMessage(systemPrompt + "\n\nUser: " + userInput);
    const response = cleanText(result.response.text());

    stopLoading();
    console.log(`\n--- OY (${currentModel}) ---`);
    console.log(response);

    chatHistory = chatHistory.concat([
      { role: "user", parts: [{ text: userInput }] },
      { role: "model", parts: [{ text: response }] }
    ]);
    await saveHistory();

    const parsed = await parseResponse(response);

    if (fileTask) {
      if (parsed.fileName && parsed.fileContent) {
        await fs.writeFile(parsed.fileName, parsed.fileContent);
        console.log(`[✓] File dibuat/diupdate: ${parsed.fileName}`);
      }

      let cmdToRun = parsed.installCmd || parsed.runCmd;

      if (!cmdToRun) {
        if (deleteIntent && parsed.rmCmd) {
          cmdToRun = normalizeDeleteCommand(parsed.rmCmd);
        } else if (moveIntent && parsed.mvCmd) {
          cmdToRun = parsed.mvCmd;
        } else if (copyIntent && parsed.cpCmd) {
          cmdToRun = parsed.cpCmd;
        } else if (mkdirIntent && parsed.mkdirCmd) {
          cmdToRun = parsed.mkdirCmd;
        } else if (viewIntent && parsed.viewCmd) {
          cmdToRun = parsed.viewCmd;
        }
      }

      if (cmdToRun) {
        let extraInfo = "";

        if (deleteIntent && cmdToRun.startsWith("rm")) {
          const preview = previewDeleteTargets(cmdToRun);
          if (preview) {
            extraInfo = `\nTarget yang akan dihapus:\n${preview}\n`;
          } else {
            extraInfo = `\n[Info] Tidak bisa menampilkan daftar file yang cocok, periksa lagi pola: ${cmdToRun}\n`;
          }
        } else if (moveIntent || copyIntent || mkdirIntent || viewIntent) {
          const preview = previewGenericCommand(cmdToRun);
          if (preview) {
            extraInfo = `\n${preview}\n`;
          }
        }

        let proceed = config.auto;
        if (!proceed) {
          const promptText = `${extraInfo}[?] Jalankan: ${cmdToRun} ? (y/n): `;
          const jawab = await new Promise((res) => rl.question(promptText, res));
          proceed = jawab.trim().toLowerCase().startsWith("y");
        }
        if (proceed) {
          console.log(`[▶] Menjalankan: ${cmdToRun}`);
          await safeExec(cmdToRun);
        }
      }
    }

    if (currentModel !== config.model) {
      saveConfig({ model: currentModel });
      console.log(`[Info] Model aktif diganti otomatis ke: ${currentModel}`);
    }
  } catch (e) {
    stopLoading();
    const msg = String(e.message || e);

    if ((msg.includes("404") || msg.toLowerCase().includes("not found")) && queue.length > 1) {
      console.log(`[!] ${currentModel} tidak tersedia, coba model cadangan...`);
      return runAI(userInput, queue.slice(1), triedQuotaFallback);
    }

    if ((msg.includes("quota") || msg.includes("429")) && !triedQuotaFallback && queue.length > 1) {
      console.log(`[!] ${currentModel} kena limit, coba model cadangan...`);
      return runAI(userInput, queue.slice(1), true);
    }

    if (msg.includes("quota") || msg.includes("429")) {
      console.log("[!] Semua model kena limit. Coba lagi nanti atau ganti akun/API key.");
      return;
    }

    console.log(`[!] Error di ${currentModel}: ${msg}`);
  }
}

// ---------- ENTRY ----------

async function start() {
  const args = process.argv.slice(2);
  const first = (args[0] || "").toLowerCase();

  if (["--help", "-h", "-help"].includes(first)) {
    const config = getConfig();
    console.log(`
OY - Asisten Coding Termux
--------------------------
oy                # Chat interaktif
oy "perintah..."  # Satu kali tanya
oy auto on/off    # Auto-jalankan INSTALL/RUN dan cek dependency/file
oy ganti model    # Pilih model dari daftar
oy reset          # Hapus riwayat chat

Model aktif: ${config.model}
Auto-run: ${config.auto ? "ON" : "OFF"}
`);
    process.exit(0);
  }

  if (first === "ganti" && args[1] === "model") {
    console.log("Daftar model:");
    models.forEach((m, i) => console.log(` ${i + 1}. ${m}`));
    rl.question("Pilih nomor: ", (c) => {
      const idx = parseInt(c) - 1;
      if (models[idx]) {
        saveConfig({ model: models[idx] });
        console.log(`Model aktif: ${models[idx]}`);
      }
      process.exit(0);
    });
    return;
  }

  if (first === "auto") {
    const on = args[1] === "on";
    saveConfig({ auto: on });
    console.log(`Auto-run: ${on ? "ON" : "OFF"}`);
    process.exit(0);
  }

  if (first === "reset") {
    try {
      await fs.unlink(HISTORY_FILE);
    } catch {}
    console.log("Ingatan direset.");
    process.exit(0);
  }

  if (args.length > 0) {
    await runAI(args.join(" "));
    process.exit(0);
  }

  console.log("Agent AI oy siap. Ketik 'exit' untuk keluar.");
  rl.prompt();
  rl.on("line", async (line) => {
    const t = line.trim();
    if (t.toLowerCase() === "exit") process.exit(0);
    if (t) await runAI(t);
    rl.prompt();
  });
}

start();