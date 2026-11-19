// Chess page. The socket lives at /chess/ws and is authenticated by the site
// session cookie, so the account name and record come from the server.
(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const GLYPH = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
  const FILES = "abcdefgh";

  let ws = null;
  let state = null;
  let sel = null;
  let pending = null;
  let me = null;
  let online = [];
  const notices = new Map(); // notice id -> element, so any tab can clear them

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function toast(message) {
    const element = $("#toast");
    element.textContent = message;
    element.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => element.classList.remove("show"), 2600);
  }

  const send = (payload) => ws && ws.readyState === 1 && ws.send(JSON.stringify(payload));

  // ---------- Notifications ----------
  // These deliberately never time out: an invite waits until it is answered,
  // cancelled, or dismissed with the close button.
  function removeNotice(id) {
    const node = notices.get(id);
    if (!node) return false;
    node.remove();
    notices.delete(id);
    return true;
  }

  function addNotice({ id, title, body, actions = [], onClose }) {
    removeNotice(id);
    const card = el("div", "notice");

    const head = el("div", "notice-head");
    head.append(el("p", "notice-title", title));
    const close = el("button", "notice-x");
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss");
    close.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    close.addEventListener("click", () => {
      removeNotice(id);
      onClose?.();
    });
    head.append(close);
    card.append(head);

    if (body) card.append(el("p", "notice-body", body));

    if (actions.length) {
      const row = el("div", "notice-actions");
      for (const action of actions) {
        const button = el("button", `hbtn${action.primary ? " chess-primary" : ""}`, action.label);
        button.type = "button";
        button.addEventListener("click", () => {
          removeNotice(id);
          action.onClick?.();
        });
        row.append(button);
      }
      card.append(row);
    }

    $("#notices").append(card);
    notices.set(id, card);
    return card;
  }

  function showInvite(code, from) {
    const decline = () => send({ type: "inviteDecline", code });
    addNotice({
      id: `invite:${code}`,
      title: `${from.name} invited you to play`,
      body: "Accept to start the game. This stays here until you answer it.",
      actions: [
        { label: "Accept", primary: true, onClick: () => send({ type: "join", code }) },
        { label: "Decline", onClick: decline },
      ],
      onClose: decline,
    });
  }

  function showSentInvite(code, to) {
    const cancel = () => send({ type: "inviteCancel", code });
    addNotice({
      id: `sent:${code}`,
      title: `Invite sent to ${to.name}`,
      body: "They have to accept before the game starts. This stays until they answer or you cancel it.",
      actions: [{ label: "Cancel invite", onClick: cancel }],
      onClose: cancel,
    });
  }

  // ---------- Connection ----------
  function connect() {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${scheme}://${location.host}/chess/ws`);
    ws.onopen = () => {
      if (state && state.code) send({ type: "join", code: state.code });
    };
    ws.onclose = () => setTimeout(connect, 1500);
    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      handle(message);
    };
  }

  function handle(message) {
    if (message.type === "welcome") {
      me = message;
      online = message.online || [];
      renderHeader();
      renderOnline();
      const code = (state && state.code) || new URLSearchParams(location.search).get("g");
      if (code) send({ type: "join", code });
      return;
    }
    if (message.type === "online") {
      online = message.users || [];
      renderOnline();
      return;
    }
    if (message.type === "stats") {
      if (me) me.stats = message.stats;
      renderHeader();
      return;
    }
    if (message.type === "state") {
      state = message;
      sel = null;
      if (new URLSearchParams(location.search).get("g") !== message.code) {
        history.replaceState(null, "", `?g=${message.code}`);
      }
      render();
      return;
    }
    if (message.type === "left") {
      state = null;
      history.replaceState(null, "", location.pathname);
      render();
      return;
    }
    if (message.type === "error") {
      toast(message.msg);
      if (message.msg === "Game not found.") {
        state = null;
        history.replaceState(null, "", location.pathname);
        render();
      }
      return;
    }
    if (message.type === "invite") {
      showInvite(message.code, message.from);
      return;
    }
    if (message.type === "invite-sent") {
      showSentInvite(message.code, message.to);
      return;
    }
    if (message.type === "invite-cancelled") {
      removeNotice(`invite:${message.code}`);
      removeNotice(`sent:${message.code}`);
      return;
    }
    if (message.type === "invite-accepted") {
      removeNotice(`sent:${message.code}`);
      toast(`${message.by?.name || "They"} accepted — game on.`);
      return;
    }
    if (message.type === "invite-declined") {
      removeNotice(`sent:${message.code}`);
      toast(`${message.by?.name || "They"} declined the invite.`);
    }
  }

  function renderHeader() {
    if (!me) return;
    const record = me.stats ? ` · ${me.stats.w}W ${me.stats.l}L ${me.stats.d}D` : "";
    $("#who").textContent = `Playing as ${me.name}${record}`;
  }

  // ---------- Who can be invited ----------
  function onlineRow(user) {
    const row = el("div", "online-row");

    const avatar = el("span", "avatar");
    avatar.style.setProperty("--c", user.color || "#f0344a");
    avatar.textContent = (String(user.name).trim()[0] || "?").toUpperCase();
    avatar.setAttribute("aria-hidden", "true");

    const invite = el("button", "hbtn online-invite", "Invite");
    invite.type = "button";
    invite.addEventListener("click", () => {
      send({ type: "invite", to: user.id, color: "r" });
      invite.disabled = true;
      setTimeout(() => invite.removeAttribute("disabled"), 1500);
    });

    row.append(avatar, el("span", "online-name", user.name), invite);
    return row;
  }

  function renderOnline() {
    const others = online.filter((user) => !me || user.id !== me.id);
    $("#onlineList").replaceChildren(...others.map(onlineRow));
    $("#onlineEmpty").hidden = others.length > 0;
  }

  // ---------- Board ----------
  function parseFen(fen) {
    const grid = {};
    fen
      .split(" ")[0]
      .split("/")
      .forEach((row, index) => {
        let file = 0;
        for (const character of row) {
          if (/\d/.test(character)) file += Number(character);
          else {
            grid[FILES[file] + (8 - index)] = character;
            file += 1;
          }
        }
      });
    return grid;
  }

  function playerBar(element, color) {
    const name = state.players[color] || "Waiting…";
    element.replaceChildren();
    const chip = el("span", "chip");
    chip.style.background = color === "w" ? "#fff" : "#14181c";
    const dot = el("span", `dot${state.online[color] ? " on" : ""}`);
    element.append(chip, el("span", null, name), dot);
  }

  function render() {
    $("#lobby").hidden = Boolean(state);
    $("#game").hidden = !state;
    if (!state) return;

    const flipped = state.you === "b";
    const grid = parseFen(state.fen);
    const dests = sel
      ? state.legal.filter((move) => move.from === sel).map((move) => move.to)
      : [];
    const board = $("#board");
    board.replaceChildren();

    for (let row = 0; row < 8; row += 1) {
      for (let column = 0; column < 8; column += 1) {
        const file = flipped ? 7 - column : column;
        const rank = flipped ? row + 1 : 8 - row;
        const square = FILES[file] + rank;
        const piece = grid[square];
        const cell = el("div", `sq ${(file + rank) % 2 ? "d" : "l"}`);
        cell.dataset.square = square;
        cell.setAttribute("role", "gridcell");
        if (state.last && (state.last.from === square || state.last.to === square)) cell.classList.add("last");
        if (sel === square) cell.classList.add("sel");
        if (dests.includes(square)) {
          cell.classList.add("dest");
          if (piece) cell.classList.add("cap");
        }
        if (state.check && piece === (state.check === "w" ? "K" : "k")) cell.classList.add("check");

        if (piece) {
          const span = el("span", `pc ${piece === piece.toUpperCase() ? "w" : "b"}`);
          span.textContent = `${GLYPH[piece.toLowerCase()]}\uFE0E`;
          cell.append(span);
        }
        // Coordinates on the outer edge, following the board's orientation.
        if (row === 7) cell.append(el("span", "coord file", FILES[file]));
        if (column === 0) cell.append(el("span", "coord rank", String(rank)));

        cell.addEventListener("click", () => clickSquare(square));
        board.append(cell);
      }
    }

    const bottom = flipped ? "b" : "w";
    playerBar($("#top"), bottom === "w" ? "b" : "w");
    playerBar($("#bottom"), bottom);

    const colorName = (color) => (color === "w" ? "White" : "Black");
    let text;
    if (state.status === "waiting") text = "Waiting for an opponent…";
    else if (state.status === "over") {
      text =
        state.result === "1/2-1/2"
          ? `Draw by ${state.reason}.`
          : `${state.result === "1-0" ? "White" : "Black"} wins by ${state.reason}.`;
    } else {
      const mine = state.you === state.turn;
      text =
        (state.you === "s" ? `${colorName(state.turn)} to move` : mine ? "Your move" : "Opponent's move") +
        (state.check ? " — check" : "");
    }
    const status = $("#status");
    status.textContent = text;
    status.classList.toggle("over", state.status === "over");

    const waiting = state.status === "waiting";
    $("#invite").hidden = !waiting;
    if (waiting) {
      $("#inviteCode").textContent = state.code;
      $("#waitText").textContent = state.invited
        ? `Waiting for ${state.invited} to accept…`
        : "Waiting for an opponent. Invite someone from the lobby.";
    }

    const moves = $("#moves");
    moves.replaceChildren();
    for (let i = 0; i < state.history.length; i += 2) {
      const row = el("div");
      row.append(
        el("span", null, `${i / 2 + 1}.`),
        el("span", null, state.history[i]),
        el("span", null, state.history[i + 1] || ""),
      );
      moves.append(row);
    }
    moves.scrollTop = moves.scrollHeight;

    const playing = state.status === "playing" && state.you !== "s";
    $("#resign").hidden = !playing;
    $("#draw").hidden = !playing || state.bot || Boolean(state.drawOffer);
    $("#acceptDraw").hidden = $("#declineDraw").hidden = !(playing && state.drawOffer && state.drawOffer !== state.you);
    if (playing && state.drawOffer === state.you) {
      $("#draw").hidden = false;
      $("#draw").disabled = true;
      $("#draw").textContent = "Draw offered";
    } else {
      $("#draw").disabled = false;
      $("#draw").textContent = "Offer draw";
    }
  }

  function clickSquare(square) {
    if (!state || !state.legal.length) return;
    if (sel) {
      const moves = state.legal.filter((move) => move.from === sel && move.to === square);
      if (moves.length) {
        if (moves[0].promo) {
          pending = { from: sel, to: square };
          showPromotion();
          return;
        }
        send({ type: "move", from: sel, to: square });
        sel = null;
        render();
        return;
      }
    }
    sel = state.legal.some((move) => move.from === square) && square !== sel ? square : null;
    render();
  }

  function showPromotion() {
    const box = $("#promo .promo");
    box.replaceChildren();
    for (const piece of ["q", "r", "b", "n"]) {
      const button = el("button", null, `${GLYPH[piece]}\uFE0E`);
      button.type = "button";
      button.addEventListener("click", () => {
        send({ type: "move", ...pending, promotion: piece });
        pending = null;
        sel = null;
        $("#promo").close();
        render();
      });
      box.append(button);
    }
    $("#promo").showModal();
  }
  $("#promo").addEventListener("cancel", () => {
    pending = null;
  });

  // ---------- Lobby / game actions ----------
  $("#bot").addEventListener("click", () =>
    send({ type: "bot", level: $("#botLevel").value, color: $("#botColor").value }),
  );
  $("#quick").addEventListener("click", () => send({ type: "quick" }));
  $("#join").addEventListener("click", () => {
    const code = $("#code").value.trim();
    if (code) send({ type: "join", code });
  });
  $("#code").addEventListener("keydown", (event) => {
    if (event.key === "Enter") $("#join").click();
  });
  $("#cancelInvite").addEventListener("click", () => send({ type: "leave" }));
  $("#resign").addEventListener("click", () => {
    if (confirm("Resign this game?")) send({ type: "resign" });
  });
  $("#draw").addEventListener("click", () => send({ type: "offerDraw" }));
  $("#acceptDraw").addEventListener("click", () => send({ type: "acceptDraw" }));
  $("#declineDraw").addEventListener("click", () => send({ type: "declineDraw" }));
  $("#leave").addEventListener("click", () => send({ type: "leave" }));

  render();
  renderOnline();
  connect();
})();
