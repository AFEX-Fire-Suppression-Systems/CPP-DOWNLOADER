const MAX_UI_CHARS = 500_000;

const COMMAND_DELAY_MS = 20;
const LOG_TRANSFER_IDLE_MS = 2000;
const DEBUG_TERMINAL_ENABLED_BY_CODE = false;
const DEBUG_SHOW_TX_MESSAGES = false;
const DEBUG_SHOW_RX_MESSAGES = false;

const connectBtn = document.getElementById("connectBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const getLogBtn = document.getElementById("getLogBtn");
const clearBtn = document.getElementById("clearBtn");
const downloadBtn = document.getElementById("downloadBtn");
const refreshBtn = document.getElementById("refreshBtn");
const exportLanguageSelect = document.getElementById("exportLanguage");
const debugToggle = document.getElementById("debugToggle");
const debugTerminalSection = document.getElementById("debugTerminalSection");
const debugCommandInput = document.getElementById("debugCommandInput");
const debugSendBtn = document.getElementById("debugSendBtn");
const debugClearBtn = document.getElementById("debugClearBtn");
const debugTerminalOutput = document.getElementById("debugTerminalOutput");
const baudRateInput = document.getElementById("baudRate");
const statusText = document.getElementById("statusText");
const workingHoursText = document.getElementById("workingHours");
const serialNumberText = document.getElementById("serialNumber");
const firmwareVersionText = document.getElementById("firmwareVersion");
const hardwareVersionText = document.getElementById("hardwareVersion");
const delayText = document.getElementById("delay");
const logOutput = document.getElementById("logOutput");
const compatWarning = document.getElementById("compatWarning");
const informationSection = document.querySelector(".information");
const downloadProgressSection = document.getElementById("downloadProgress");
const downloadProgressBar = document.getElementById("downloadProgressBar");
const downloadProgressText = document.getElementById("downloadProgressText");

const COMPACT_PANEL_PLUS_FILTER = {
  usbVendorId: 1155,
  usbProductId: 22336
};

let port = null;
let reader = null;
let keepReading = false;
let captureBuffer = "";
let isConnected = false;
let responseBuffer = "";
let logFilterCarry = "";
let autoDownloadArmed = false;
let logTransferStarted = false;
let logDownloadIdleTimer = null;
let progressLineCarry = "";
let transferStartIndex = null;
let transferCurrentIndex = null;
let debugTerminalEnabled = false;
let debugTerminalBuffer = "";
let debugRxCarry = "";
let rxFrameCarry = "";
const pendingResponseWaiters = [];
const isSerialSupported = "serial" in navigator;
const textEncoder = new TextEncoder();

const MAX_DEBUG_CHARS = 120_000;

function setDebugTerminalVisibility(visible) {
  if (!debugTerminalSection) {
    return;
  }

  debugTerminalSection.hidden = !visible;
}

function refreshDebugControls() {
  const canUse = debugTerminalEnabled && isConnected && isSerialSupported;
  if (debugSendBtn) {
    debugSendBtn.disabled = !canUse;
  }

  if (debugClearBtn) {
    debugClearBtn.disabled = !debugTerminalEnabled;
  }

  if (debugCommandInput) {
    debugCommandInput.disabled = !debugTerminalEnabled;
  }
}

function appendToDebugTerminal(text) {
  if (!debugTerminalEnabled || !text) {
    return;
  }

  debugTerminalBuffer += text;
  if (debugTerminalBuffer.length > MAX_DEBUG_CHARS) {
    debugTerminalBuffer = debugTerminalBuffer.slice(debugTerminalBuffer.length - MAX_DEBUG_CHARS);
  }

  if (debugTerminalOutput) {
    debugTerminalOutput.textContent = debugTerminalBuffer;
    debugTerminalOutput.scrollTop = debugTerminalOutput.scrollHeight;
  }
}

function clearDebugTerminal() {
  debugTerminalBuffer = "";
  debugRxCarry = "";
  if (debugTerminalOutput) {
    debugTerminalOutput.textContent = "";
  }
}

function appendRxToDebugTerminal(text) {
  if (!debugTerminalEnabled || !DEBUG_SHOW_RX_MESSAGES || !text) {
    return;
  }

  debugRxCarry += text.replace(/\r/g, "");

  let frameStart = 0;
  for (let index = 0; index < debugRxCarry.length; index += 1) {
    const char = debugRxCarry[index];
    if (char !== ";" && char !== "\n") {
      continue;
    }

    const frame = debugRxCarry.slice(frameStart, index + 1).trim();
    if (frame) {
      appendToDebugTerminal(`[RX] ${frame}\n`);
    }

    frameStart = index + 1;
  }

  debugRxCarry = debugRxCarry.slice(frameStart);
}

function setDebugTerminalEnabled(enabled) {
  debugTerminalEnabled = enabled;
  setDebugTerminalVisibility(enabled);
  refreshDebugControls();

  if (enabled) {
    appendToDebugTerminal("[Debug terminal enabled]\n");
    return;
  }

  clearDebugTerminal();
}

async function sendCustomDebugCommand() {
  if (!debugTerminalEnabled || !port?.writable) {
    return;
  }

  const raw = debugCommandInput?.value?.trim() ?? "";
  if (!raw) {
    return;
  }

  const writer = port.writable.getWriter();
  try {
    const command = raw.endsWith("\r\n") ? raw : `${raw}\r\n`;
    const data = textEncoder.encode(command);
    await writer.write(data);
    if (DEBUG_SHOW_TX_MESSAGES) {
      appendToDebugTerminal(`[TX] ${raw}\n`);
    }
    debugCommandInput.value = "";
  } catch (error) {
    appendToDebugTerminal(`[TX ERROR] ${error.message}\n`);
    setStatus(`Write failed: ${error.message}`);
  } finally {
    writer.releaseLock();
  }
}

async function sendCommand(command, statusMessage) {
  if (!port?.writable) {
    return false;
  }

  const writer = port.writable.getWriter();
  try {
    const data = textEncoder.encode(command);
    await writer.write(data);

    if (DEBUG_SHOW_TX_MESSAGES) {
      appendToDebugTerminal(`[TX] ${command.replace(/\r\n$/, "")}\n`);
    }

    if (statusMessage) {
      setStatus(statusMessage);
    }

    return true;
  } catch (error) {
    appendToDebugTerminal(`[TX ERROR] ${error.message}\n`);
    setStatus(`Write failed: ${error.message}`);
    return false;
  } finally {
    writer.releaseLock();
  }
}

function setDownloadProgressVisibility(visible) {
  if (!downloadProgressSection) {
    return;
  }

  downloadProgressSection.hidden = !visible;
}

function setDownloadProgress(percent, text) {
  if (downloadProgressBar) {
    downloadProgressBar.value = percent;
  }

  if (downloadProgressText) {
    downloadProgressText.textContent = text;
  }
}

function resetDownloadProgressState() {
  progressLineCarry = "";
  transferStartIndex = null;
  transferCurrentIndex = null;
  setDownloadProgress(0, "0%");
}

function updateDownloadProgressFromLog(text) {
  if (!autoDownloadArmed || !text) {
    return;
  }

  const combined = progressLineCarry + text;
  const lines = combined.split(/\r?\n/);
  progressLineCarry = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.includes("@END OF LOGS;")) {
      setDownloadProgress(100, "100%");
      finishAutoDownloadIfReady();
      continue;
    }

    const entryMatch = trimmed.match(/^(\d+),/);
    if (!entryMatch) {
      continue;
    }

    const entryIndex = Number(entryMatch[1]);
    if (!Number.isFinite(entryIndex) || entryIndex <= 0) {
      continue;
    }

    if (transferStartIndex === null) {
      transferStartIndex = entryIndex;
    }

    transferCurrentIndex = entryIndex;

    if (transferStartIndex > 0) {
      const total = transferStartIndex;
      const completed = Math.min(total, Math.max(0, total - transferCurrentIndex + 1));
      const percent = Math.min(100, Math.round((completed / total) * 100));
      setDownloadProgress(percent, `${percent}% (${completed}/${total})`);
    }
  }
}

function clearAutoDownloadTimer() {
  if (logDownloadIdleTimer) {
    clearTimeout(logDownloadIdleTimer);
    logDownloadIdleTimer = null;
  }
}

function finishAutoDownloadIfReady() {
  clearAutoDownloadTimer();

  if (!autoDownloadArmed) {
    return;
  }

  autoDownloadArmed = false;
  setDownloadProgressVisibility(false);

  if (logTransferStarted && captureBuffer.length > 0) {
    setStatus("Log transfer complete.");
    downloadLog();
    return;
  }

  setStatus("Log request finished. No log data received.");
}

function scheduleAutoDownloadCheck() {
  if (!autoDownloadArmed) {
    return;
  }

  clearAutoDownloadTimer();
  logDownloadIdleTimer = setTimeout(() => {
    finishAutoDownloadIfReady();
  }, LOG_TRANSFER_IDLE_MS);
}

function isCompactPanelPlusPort(serialPort) {
  const info = serialPort?.getInfo?.();
  return (
    info?.usbVendorId === COMPACT_PANEL_PLUS_FILTER.usbVendorId &&
    info?.usbProductId === COMPACT_PANEL_PLUS_FILTER.usbProductId
  );
}

function setStatus(text) {
  statusText.textContent = text;
}
function setWorkingHours(hours) {
    workingHoursText.textContent = hours;
}
function setSerialNumber(serial) {
    serialNumberText.textContent = serial;
}
function setFirmwareVersion(version) {
    firmwareVersionText.textContent = version;
}
function setHardwareVersion(version) {
    hardwareVersionText.textContent = version;
}
function setDelay(delay){
    delayText.textContent = delay;
}

function parseWorkingHoursFrame(frame) {
  const match = frame.match(/^(?:@WORKING_HOURS:)?D{3,4}=(\d+),HH=(\d+),MM=(\d+)$/i);
  if (!match) {
    return null;
  }

  return {
    ddd: match[1].padStart(3, "0"),
    hh: match[2].padStart(2, "0"),
    mm: match[3].padStart(2, "0")
  };
}

function notifyPendingResponseWaiters(frame) {
  if (!frame || pendingResponseWaiters.length === 0) {
    return;
  }

  for (let index = pendingResponseWaiters.length - 1; index >= 0; index -= 1) {
    const waiter = pendingResponseWaiters[index];
    let matches = false;

    try {
      matches = waiter.match(frame);
    } catch {
      matches = false;
    }

    if (!matches) {
      continue;
    }

    clearTimeout(waiter.timeoutId);
    pendingResponseWaiters.splice(index, 1);
    waiter.resolve(frame);
  }
}

function clearPendingResponseWaiters(reason = "Disconnected") {
  while (pendingResponseWaiters.length > 0) {
    const waiter = pendingResponseWaiters.pop();
    clearTimeout(waiter.timeoutId);
    waiter.reject(new Error(reason));
  }
}

function waitForResponseFrame(match, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const waiter = {
      match: typeof match === "function" ? match : () => true,
      resolve,
      reject,
      timeoutId: 0
    };

    waiter.timeoutId = setTimeout(() => {
      const index = pendingResponseWaiters.indexOf(waiter);
      if (index !== -1) {
        pendingResponseWaiters.splice(index, 1);
      }
      reject(new Error("Timed out waiting for response."));
    }, timeoutMs);

    pendingResponseWaiters.push(waiter);
  });
}

function handleIncomingFrame(frame) {
  if (!frame) {
    return;
  }

  const oldHardwareMatch = frame.match(/^@HARDWARE_VERSION:([A-Za-z0-9]+)\.([A-Za-z0-9]+)$/i);
  if (oldHardwareMatch) {
    setHardwareVersion(`${oldHardwareMatch[1]}.${oldHardwareMatch[2]}`);
  }

  const oldFirmwareMatch = frame.match(/^@FIRMWARE_VERSION:(\d+)\.(\d+)\.(\d+)$/i);
  if (oldFirmwareMatch) {
    setFirmwareVersion(`${oldFirmwareMatch[1]}.${oldFirmwareMatch[2]}.${oldFirmwareMatch[3]}`);
  }

  const oldSerialMatch = frame.match(/^@AFEX_SERIAL_NUMBER:([^\r\n]+)$/i);
  if (oldSerialMatch) {
    const cleanedSerial = oldSerialMatch[1].replace(/\D/g, "");
    setSerialNumber(cleanedSerial || "N/A");
  }

  const oldWorkingHours = parseWorkingHoursFrame(frame);
  if (oldWorkingHours) {
    setWorkingHours(`${oldWorkingHours.ddd}:${oldWorkingHours.hh}:${oldWorkingHours.mm}`);
  }

  const oldDelayMatch = frame.match(/^@DELAY:([0-9]+(?:\.[0-9]+)?)$/i);
  if (oldDelayMatch) {
    setDelay(`${oldDelayMatch[1]} Sec`);
  }

  notifyPendingResponseWaiters(frame);
}

function processIncomingFrames(text) {
  if (!text) {
    return;
  }

  rxFrameCarry += text.replace(/\r/g, "");
  let frameStart = 0;

  for (let index = 0; index < rxFrameCarry.length; index += 1) {
    const char = rxFrameCarry[index];
    if (char !== ";" && char !== "\n") {
      continue;
    }

    const frame = rxFrameCarry.slice(frameStart, index).trim();
    if (frame) {
      handleIncomingFrame(frame);
    }

    frameStart = index + 1;
  }

  rxFrameCarry = rxFrameCarry.slice(frameStart);
  if (rxFrameCarry.length > 20_000) {
    rxFrameCarry = rxFrameCarry.slice(-20_000);
  }
}

function resetInfoValues() {
  setWorkingHours("N/A");
  setSerialNumber("N/A");
  setFirmwareVersion("N/A");
  setHardwareVersion("N/A");
  setDelay("N/A");
}

function setInformationVisibility(visible) {
  if (!informationSection) {
    return;
  }

  informationSection.hidden = !visible;
}

function filterDeviceInfoFromLog(text) {
  if (!text) {
    return "";
  }

  const metadataPattern =
    /@HARDWARE_VERSION:[A-Za-z0-9]+\.[A-Za-z0-9]+;|@FIRMWARE_VERSION:\d+\.\d+\.\d+;|@AFEX_SERIAL_NUMBER:[^;\r\n]*;|@WORKING_HOURS:DDD=\d+,HH=\d+,MM=\d+;|@DELAY:[0-9]+(?:\.[0-9]+)?;/g;

  const combined = logFilterCarry + text;
  let carry = "";
  let safeText = combined;

  const lastAt = combined.lastIndexOf("@");
  if (lastAt !== -1) {
    const tail = combined.slice(lastAt);
    if (!tail.includes(";")) {
      safeText = combined.slice(0, lastAt);
      carry = tail;
    }
  }

  logFilterCarry = carry;
  return safeText.replace(metadataPattern, "");
}

function refreshButtons() {
  connectBtn.disabled = isConnected || !isSerialSupported;
  disconnectBtn.disabled = !isConnected;
  getLogBtn.disabled = !isConnected || !isSerialSupported;
  downloadBtn.disabled = captureBuffer.length === 0;
  refreshBtn.disabled = !isConnected;
  exportLanguageSelect.disabled = !isConnected;
  refreshDebugControls();
}

function getSelectedExportLanguage() {
  const rawValue = exportLanguageSelect?.value ?? "0";
  return ["0", "1", "2", "3"].includes(rawValue) ? rawValue : "0";
}

function updateCompatibilityWarning() {
  if (!compatWarning) {
    return;
  }

  if (isSerialSupported) {
    compatWarning.hidden = true;
    return;
  }

  compatWarning.hidden = false;
  setStatus("Browser not compatible. Use Microsoft Edge or Google Chrome.");
}

function appendToLog(text, options = {}) {
  if (!text) {
    return;
  }

  const { includeInCapture = true } = options;

  if (!includeInCapture) {
    let visible = (logOutput.textContent || "") + text;
    if (visible.length > MAX_UI_CHARS) {
      visible = visible.slice(visible.length - MAX_UI_CHARS);
    }

    logOutput.textContent = visible;
    logOutput.scrollTop = logOutput.scrollHeight;
    refreshButtons();
    return;
  }

  appendRxToDebugTerminal(text);
  processIncomingFrames(text);

  const filteredText = filterDeviceInfoFromLog(text);
  if (!filteredText) {
    refreshButtons();
    return;
  }

  updateDownloadProgressFromLog(filteredText);

  if (autoDownloadArmed) {
    logTransferStarted = true;
    scheduleAutoDownloadCheck();
  }

  captureBuffer += filteredText;

  let visible = captureBuffer;
  if (visible.length > MAX_UI_CHARS) {
    visible = visible.slice(visible.length - MAX_UI_CHARS);
  }

  logOutput.textContent = visible;
  logOutput.scrollTop = logOutput.scrollHeight;
  refreshButtons();
}

async function readLoop() {
  if (!port?.readable) {
    return;
  }

  keepReading = true;
  const decoder = new TextDecoder();

  while (port.readable && keepReading) {
    reader = port.readable.getReader();

    try {
      while (keepReading) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        if (value) {
          appendToLog(decoder.decode(value, { stream: true }));
        }
      }

      const finalText = decoder.decode();
      if (finalText) {
        appendToLog(finalText);
      }
    } catch (error) {
      appendToLog(`\n[Read Error] ${error.message}\n`);
      break;
    } finally {
      reader.releaseLock();
      reader = null;
    }
  }
}
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendCommandAndWaitForResponse(command, statusMessage, match, timeoutMs = 3000) {
  const sent = await sendCommand(command, statusMessage);
  if (!sent) {
    return null;
  }

  try {
    return await waitForResponseFrame(match, timeoutMs);
  } catch (error) {
    setStatus(`${statusMessage.replace(/\.\.\.$/, "")} timeout.`);
    appendToDebugTerminal(`[RX TIMEOUT] ${command.replace(/\r\n$/, "")}\n`);
    return null;
  }
}

async function requestDeviceInfoSequence(statusWhenDone) {
  await getWorkingHours();
  await getSerialNumber();
  await getFirmwareVersion();
  await getHardwareVersion();
  await getDelay();

  if (statusWhenDone) {
    setStatus(statusWhenDone);
  }
}



async function connectPort() {
  if (!("serial" in navigator)) {
    setStatus("Web Serial API not supported in this browser.");
    return;
  }

  try {
    const baudRate =  115200;
    port = await navigator.serial.requestPort({
      filters: [COMPACT_PANEL_PLUS_FILTER]
    });

    if (!isCompactPanelPlusPort(port)) {
      setStatus("Selected device is not COMPACT PANEL PLUS.");
      port = null;
      return;
    }

    await port.open({ baudRate });

    isConnected = true;
    responseBuffer = "";
    logFilterCarry = "";
    rxFrameCarry = "";
    setInformationVisibility(true);
    refreshButtons();

    readLoop();
    await requestDeviceInfoSequence("Connected");
  } catch (error) {
    setStatus(`Connect failed: ${error.message}`);
  }
}

async function disconnectPort() {
  if (!port) {
    return;
  }

  try {
    keepReading = false;

    if (reader) {
      await reader.cancel();
    }

    if (port.writable) {
      const writer = port.writable.getWriter();
      writer.releaseLock();
    }

    await port.close();
    // appendToLog("\n[Disconnected]\n");
  } catch (error) {
    // appendToLog(`\n[Disconnect Error] ${error.message}\n`);
  } finally {
    clearAutoDownloadTimer();
    autoDownloadArmed = false;
    logTransferStarted = false;
    setDownloadProgressVisibility(false);
    resetDownloadProgressState();
    port = null;
    reader = null;
    isConnected = false;
    responseBuffer = "";
    logFilterCarry = "";
    rxFrameCarry = "";
    clearPendingResponseWaiters();
    setInformationVisibility(false);
    resetInfoValues();
    setStatus("Disconnected");
    refreshButtons();
  }
}

async function sendExportLogs() {
  clearLog();
  try {
    resetDownloadProgressState();
    setDownloadProgressVisibility(true);
    autoDownloadArmed = true;
    logTransferStarted = false;
    clearAutoDownloadTimer();
    const language = getSelectedExportLanguage();
    const command = `@EXPORT_LOGS ${language};\r\n`;
    const sent = await sendCommand(command, "receiving data...");
    if (!sent) {
      clearAutoDownloadTimer();
      autoDownloadArmed = false;
      logTransferStarted = false;
      setDownloadProgressVisibility(false);
      return;
    }
    appendToLog(`[TX] ${command.replace(/\r\n$/, "")}\n`, { includeInCapture: false });
    scheduleAutoDownloadCheck();
  } catch (error) {
    clearAutoDownloadTimer();
    autoDownloadArmed = false;
    logTransferStarted = false;
    setDownloadProgressVisibility(false);
    //appendToLog(`\n[Write Error] ${error.message}\n`);
    setStatus(`Write failed: ${error.message}`);
  } finally {
  }
}
async function getWorkingHours() {
  const command = "@GET_WORKING_HOURS;\r\n";
  const frame = await sendCommandAndWaitForResponse(
    command,
    "receiving working hours...",
    (value) => /^D{3,4}=\d+,HH=\d+,MM=\d+$/i.test(value) || /^@WORKING_HOURS:D{3,4}=\d+,HH=\d+,MM=\d+$/i.test(value)
  );

  if (!frame) {
    return false;
  }

  const parsed = parseWorkingHoursFrame(frame);
  if (!parsed) {
    return false;
  }

  setWorkingHours(`${parsed.ddd}:${parsed.hh}:${parsed.mm}`);
  return true;
}

async function getSerialNumber() {
  const command = "@GET_AFEX_SERIAL_NUMBER;\r\n";
  const frame = await sendCommandAndWaitForResponse(
    command,
    "receiving serial number...",
    (value) => /^\d+$/.test(value) || /^@AFEX_SERIAL_NUMBER:[^\r\n]+$/i.test(value)
  );

  if (!frame) {
    return false;
  }

  const payload = frame.replace(/^@AFEX_SERIAL_NUMBER:/i, "");
  const cleanedSerial = payload.replace(/\D/g, "");
  setSerialNumber(cleanedSerial || "N/A");
  return true;
}

async function getFirmwareVersion() {
  const command = "@GET_FIRMWARE_VERSION;\r\n";
  const frame = await sendCommandAndWaitForResponse(
    command,
    "receiving firmware version...",
    (value) => /^\d+\.\d+\.\d+$/.test(value) || /^@FIRMWARE_VERSION:\d+\.\d+\.\d+$/i.test(value)
  );

  if (!frame) {
    return false;
  }

  const payload = frame.replace(/^@FIRMWARE_VERSION:/i, "");
  setFirmwareVersion(payload);
  return true;
}

async function getHardwareVersion() {
  const command = "@GET_HARDWARE_VERSION;\r\n";
  const frame = await sendCommandAndWaitForResponse(
    command,
    "receiving hardware version...",
    (value) => /^[A-Za-z0-9]+\.[A-Za-z0-9]+$/.test(value) || /^@HARDWARE_VERSION:[A-Za-z0-9]+\.[A-Za-z0-9]+$/i.test(value)
  );

  if (!frame) {
    return false;
  }

  const payload = frame.replace(/^@HARDWARE_VERSION:/i, "");
  setHardwareVersion(payload);
  return true;
}

async function getDelay() {
  const command = "@GET_DELAY;\r\n";
  const frame = await sendCommandAndWaitForResponse(
    command,
    "receiving delay...",
    (value) => /^\d+(?:\.\d+)?$/.test(value) || /^@DELAY:\d+(?:\.\d+)?$/i.test(value)
  );

  if (!frame) {
    return false;
  }

  const payload = frame.replace(/^@DELAY:/i, "");
  setDelay(`${payload} Sec`);
  return true;
}

function clearLog() {
  captureBuffer = "";
  logOutput.textContent = "";
  refreshButtons();
}

function downloadLog() {
  if (!captureBuffer) {
    return;
  }

  const now = new Date();
  const pad2 = (value) => String(value).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
    `-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;

  const blob = new Blob([captureBuffer], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `compact-panel-log-${stamp}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function refreshdeviceInfo() {
  await requestDeviceInfoSequence("Refreshed device information.");
    clearLog();
}

connectBtn.addEventListener("click", connectPort);
disconnectBtn.addEventListener("click", disconnectPort);
getLogBtn.addEventListener("click", sendExportLogs);
clearBtn.addEventListener("click", clearLog);
downloadBtn.addEventListener("click", downloadLog);
refreshBtn.addEventListener("click", refreshdeviceInfo);

navigator.serial?.addEventListener("disconnect", async () => {
  await disconnectPort();
});

updateCompatibilityWarning();
setInformationVisibility(false);
setDownloadProgressVisibility(false);
if (debugToggle) {
  debugToggle.checked = DEBUG_TERMINAL_ENABLED_BY_CODE;
  debugToggle.hidden = true;
}
setDebugTerminalEnabled(DEBUG_TERMINAL_ENABLED_BY_CODE);
resetDownloadProgressState();
resetInfoValues();
refreshButtons();
downloadBtn.style.display = "none";
clearBtn.style.display = "none";
//document.querySelector(".log-section").style.display = "none";
//document.getElementById("debugSection").style.visibility = "hidden";

debugSendBtn?.addEventListener("click", sendCustomDebugCommand);
debugClearBtn?.addEventListener("click", clearDebugTerminal);
debugCommandInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    sendCustomDebugCommand();
  }
});