// Remote page: devices, a button panel built from the server's command
// catalogue, and a browser version of the device console.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const ICONS = {
    tv: "fa-tv",
    phone: "fa-mobile-screen-button",
    tablet: "fa-tablet-screen-button",
    laptop: "fa-laptop",
  };
  const KINDS = { tv: "TV", phone: "Phone", tablet: "Tablet", laptop: "Computer" };
  const POLL_MS = 3000;

  let catalog = [];
  let devices = [];
  let selectedId = null;
  let panelSignature = "";

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  async function request(method, url, body) {
    const response = await fetch(url, {
      method,
      cache: "no-store",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  const iconOf = (kind) => ICONS[kind] || ICONS.laptop;

  function clock(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function stateText(device) {
    const watching = device.watching || {};
    if (!watching.title) {
      return device.page && device.page !== "unknown" ? `On ${device.page}` : "Connected";
    }
    return `${watching.paused ? "Paused" : "Playing"} · ${watching.title}`;
  }

  const selectedDevice = () => devices.find((device) => device.id === selectedId) || null;

  function setStatus(message, isError) {
    const status = $("status");
    status.textContent = message || "";
    status.classList.toggle("error", Boolean(isError));
  }

  // ---------- Device list ----------
  function deviceCard(device) {
    const card = el("button", "rm-device");
    card.type = "button";
    if (device.id === selectedId) card.classList.add("active");
    card.setAttribute("aria-pressed", String(device.id === selectedId));

    const badge = el("span", "rm-device-icon");
    badge.innerHTML = `<i class="fa-solid ${iconOf(device.kind)}"></i>`;

    const text = el("span", "rm-device-text");
    text.append(el("strong", "rm-device-name", device.name || "Unnamed device"));
    text.append(el("span", "rm-device-meta", `${KINDS[device.kind] || "Device"} · ${device.ip}`));
    text.append(el("span", "rm-device-state", stateText(device)));

    card.append(badge, text);
    card.addEventListener("click", () => select(device.id));
    return card;
  }

  function renderDevices() {
    $("deviceList").replaceChildren(...devices.map(deviceCard));
    $("deviceCount").textContent = String(devices.length);
    $("deviceEmpty").hidden = devices.length > 0;
  }

  function select(id) {
    if (id === selectedId) return;
    selectedId = id;
    panelSignature = "";
    setStatus("");
    renderDevices();
    renderPanel();
  }

  // ---------- Selected device ----------
  function renderNow(device) {
    const now = $("panelNow");
    const watching = device.watching || {};
    if (!watching.title) {
      now.hidden = true;
      now.replaceChildren();
      return;
    }
    now.hidden = false;
    now.replaceChildren(
      el("strong", null, watching.title),
      el("span", null, watching.paused ? "Paused" : "Playing"),
      el("span", null, `${clock(watching.time)} / ${clock(watching.duration)}`),
      el("span", null, `Volume ${Math.round((Number(watching.volume) || 0) * 100)}%`),
    );
  }

  function renderPanel() {
    const device = selectedDevice();
    if (!device) {
      selectedId = null;
      panelSignature = "";
      $("panel").hidden = true;
      $("noSelection").hidden = false;
      return;
    }

    $("panel").hidden = false;
    $("noSelection").hidden = true;
    $("panelIcon").innerHTML = `<i class="fa-solid ${iconOf(device.kind)}"></i>`;
    $("panelName").textContent = device.name || "Unnamed device";
    $("panelMeta").textContent = `${KINDS[device.kind] || "Device"} · ${device.ip} · ${device.page}`;
    if (document.activeElement !== $("renameInput")) {
      $("renameInput").value = device.name || "";
    }
    renderNow(device);

    // Rebuild the buttons only when the device or the page it is on changes,
    // so a poll never wipes text someone is typing into a field.
    const signature = `${device.id}|${device.page}`;
    if (signature !== panelSignature) {
      panelSignature = signature;
      renderGroups(device);
    }
  }

  function sendControl(control, value) {
    const device = selectedDevice();
    if (!device) return;
    const text = value === undefined ? "" : String(value).trim();
    const command = control.prefix ? `${control.command}${text}` : control.command;
    const args = control.prefix || !text ? { values: [] } : { values: [text] };
    setStatus(`Sending ${control.label.toLowerCase()}…`);
    request("POST", `/api/devices/${encodeURIComponent(device.id)}/command`, { command, args })
      .then(() => setStatus(`Sent ${control.label.toLowerCase()} to ${device.name || device.ip}.`))
      .catch((error) => setStatus(error.message, true));
  }

  function buttonControl(control) {
    const button = el("button", "hbtn rm-btn");
    button.type = "button";
    if (control.icon) button.append(el("i", `fa-solid ${control.icon}`));
    button.append(el("span", null, control.label));
    button.addEventListener("click", () => sendControl(control));
    return button;
  }

  function rangeControl(control) {
    const field = el("label", "rm-field");
    field.append(el("span", "rm-field-label", control.label));
    const output = el("output", "rm-value", `${control.value}${control.unit || ""}`);
    const input = el("input");
    input.type = "range";
    for (const key of ["min", "max", "step", "value"]) {
      if (control[key] !== undefined) input[key] = control[key];
    }
    input.addEventListener("input", () => {
      output.textContent = `${input.value}${control.unit || ""}`;
    });
    input.addEventListener("change", () => sendControl(control, input.value));
    field.append(output, input);
    return field;
  }

  function selectControl(control) {
    const field = el("label", "rm-field");
    field.append(el("span", "rm-field-label", control.label));
    const select = el("select");
    for (const option of control.options || []) {
      const node = el("option", null, option.label);
      node.value = option.value;
      select.append(node);
    }
    if (control.value !== undefined) select.value = control.value;
    select.addEventListener("change", () => sendControl(control, select.value));
    field.append(select);
    return field;
  }

  function textControl(control) {
    const form = el("form", "rm-field");
    form.append(el("span", "rm-field-label", control.label));
    const row = el("div", "rm-send-row");
    const input = el("input");
    input.type = control.type === "number" ? "number" : "text";
    if (control.placeholder) input.placeholder = control.placeholder;
    for (const key of ["min", "max", "step", "value"]) {
      if (control[key] !== undefined) input[key] = control[key];
    }
    const submit = el("button", "hbtn", "Send");
    submit.type = "submit";
    row.append(input, submit);
    form.append(row);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) {
        input.focus();
        return;
      }
      sendControl(control, value);
    });
    return form;
  }

  function controlNode(control) {
    if (control.type === "range") return rangeControl(control);
    if (control.type === "select") return selectControl(control);
    if (control.type === "text" || control.type === "number") return textControl(control);
    return buttonControl(control);
  }

  function renderGroups(device) {
    const host = $("groups");
    host.replaceChildren();
    for (const group of catalog) {
      if (group.pages && group.pages.length && !group.pages.includes(device.page)) continue;
      const section = el("section", "rm-group");
      const title = el("h3", "rm-group-title");
      if (group.icon) title.append(el("i", `fa-solid ${group.icon}`));
      title.append(el("span", null, group.title));
      const controls = el("div", "rm-controls");
      for (const control of group.controls) controls.append(controlNode(control));
      section.append(title, controls);
      host.append(section);
    }
    if (!host.children.length) {
      host.append(el("p", "rm-empty", "This device is on a page with no controls yet."));
    }
  }

  // ---------- Console ----------
  const history = [];
  let historyAt = 0;

  function write(text, kind) {
    const out = $("consoleOut");
    out.append(el("div", `rm-line${kind ? ` ${kind}` : ""}`, text));
    while (out.children.length > 300) out.firstElementChild.remove();
    out.scrollTop = out.scrollHeight;
  }

  async function runLine(line) {
    write(`> ${line}`, "echo");
    try {
      const { lines } = await request("POST", "/api/console", { line });
      (lines && lines.length ? lines : ["(no output)"]).forEach((text) => write(text));
    } catch (error) {
      write(error.message, "error");
      return;
    }
    if (/^\/restart\b/i.test(line)) {
      write("The server is restarting. This page reconnects on its own.", "warn");
      setTimeout(() => poll(true), 4000);
    }
  }

  $("consoleForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("consoleInput");
    const line = input.value.trim();
    if (!line) return;
    input.value = "";
    history.push(line);
    historyAt = history.length;
    runLine(line);
  });

  $("consoleInput").addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (!history.length) return;
    event.preventDefault();
    historyAt = Math.min(history.length, Math.max(0, historyAt + (event.key === "ArrowUp" ? -1 : 1)));
    $("consoleInput").value = history[historyAt] || "";
  });

  // ---------- Rename ----------
  $("renameForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const device = selectedDevice();
    if (!device) return;
    const name = $("renameInput").value.trim();
    if (!name) {
      $("renameInput").focus();
      return;
    }
    try {
      await request("POST", `/api/devices/${encodeURIComponent(device.id)}/name`, { name });
      setStatus(`This device is now called ${name}.`);
      await poll();
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  // ---------- Refresh loop ----------
  let failures = 0;

  async function poll(report) {
    try {
      const data = await request("GET", "/api/devices");
      failures = 0;
      catalog = data.commands || catalog;
      devices = data.devices || [];
      if (selectedId && !devices.some((device) => device.id === selectedId)) {
        selectedId = null;
        panelSignature = "";
      }
      renderDevices();
      renderPanel();
      if (report) setStatus("Reconnected.");
    } catch (error) {
      failures += 1;
      if (report || failures === 1) setStatus(error.message, true);
    }
  }

  $("refreshDevices").addEventListener("click", async () => {
    await poll(true);
    setStatus("Device list updated.");
  });

  write("Device console ready. Type /help for commands.");
  poll();
  setInterval(poll, POLL_MS);
})();
