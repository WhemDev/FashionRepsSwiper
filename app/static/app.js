/* FashionRepsSwiper — vanilla JS Tinder-style swipe UI */
(function () {
  "use strict";

  // ---------- Constants ----------
  var PAGE_SIZE = 50;
  var LOW_WATER = 10;      // fetch more when fewer unswiped cards than this
  var SWIPE_THRESHOLD = 80; // px
  var PREFETCH_COUNT = 5;
  var UNDO_LIMIT = 30;
  var LS_SAVED = "fr_saved";
  var LS_SWIPED = "fr_swiped";
  var LS_BRAND = "fr_brand";       // legacy single-slug key (migrated on init)
  var LS_BRANDS = "fr_brands";
  var LS_BRANDS_COLLAPSED = "fr_brands_collapsed";
  var LS_WELCOME = "fr_welcome_seen";
  var SS_SEED = "fr_seed";

  // ---------- State ----------
  var state = {
    view: "deck",              // deck | saved | skipped
    brands: [],
    totalItems: 0,
    selectedBrands: ["all"],   // ["all"] or one/more brand slugs
    brandsCollapsed: false,
    brandFilterQuery: "",
    seed: 0,
    deck: [],                  // unswiped items, deck[0] = top card
    offset: 0,                 // next offset for "all" mode
    brandOffsets: {},          // per-slug offsets for multi-brand mode
    brandTotals: {},           // per-slug totals from API
    total: null,               // total for "all" mode
    exhausted: false,
    fetching: false,
    fetchError: false,
    brandsError: false,
    seq: 0,                    // invalidates in-flight fetches on reset
    swiped: new Set(),         // "store|id" keys
    saved: [],                 // full item objects, newest first
    undoStack: [],             // { item, action }
    topEl: null,
    prefetched: new Set(),
    isDragging: false,     // suppress stack re-renders mid-drag
    pendingRender: false
  };

  // ---------- DOM ----------
  var el = {
    navDeck: document.getElementById("nav-deck"),
    navSaved: document.getElementById("nav-saved"),
    savedBadge: document.getElementById("saved-badge"),
    viewDeck: document.getElementById("view-deck"),
    viewSaved: document.getElementById("view-saved"),
    viewSkipped: document.getElementById("view-skipped"),
    brandSection: document.getElementById("brand-section"),
    brandChips: document.getElementById("brand-chips"),
    brandCollapseToggle: document.getElementById("brand-collapse-toggle"),
    brandFilterCount: document.getElementById("brand-filter-count"),
    brandSearch: document.getElementById("brand-search"),
    welcomeModal: document.getElementById("welcome-modal"),
    welcomeDismiss: document.getElementById("welcome-dismiss"),
    deck: document.getElementById("deck"),
    stack: document.getElementById("stack"),
    deckStatus: document.getElementById("deck-status"),
    btnSkip: document.getElementById("btn-skip"),
    btnSave: document.getElementById("btn-save"),
    btnUndo: document.getElementById("btn-undo"),
    savedGrid: document.getElementById("saved-grid"),
    savedEmpty: document.getElementById("saved-empty"),
    btnExportJson: document.getElementById("btn-export-json"),
    btnExportCsv: document.getElementById("btn-export-csv"),
    btnSkippedShops: document.getElementById("btn-skipped-shops"),
    btnBackSaved: document.getElementById("btn-back-saved"),
    skippedList: document.getElementById("skipped-list")
  };

  // ---------- Helpers ----------
  // Yupoo album pages 404 without these query params.
  var YUPOO_ALBUM_QS = "uid=1&isSubCate=false&referrercate=";

  function proxied(url) {
    return "/img?u=" + encodeURIComponent(url);
  }

  function albumLink(url) {
    if (!url) return "#";
    if (/[?&]uid=/.test(url)) return url;
    return url + (url.indexOf("?") >= 0 ? "&" : "?") + YUPOO_ALBUM_QS;
  }

  function itemKey(item) {
    return String(item.store) + "|" + String(item.id);
  }

  function readJSON(storage, key, fallback) {
    try {
      var raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(storage, key, value) {
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch (e) { /* storage full or unavailable — non-fatal */ }
  }

  function persistSaved() { writeJSON(localStorage, LS_SAVED, state.saved); }
  function persistSwiped() { writeJSON(localStorage, LS_SWIPED, Array.from(state.swiped)); }

  function isAllMode() {
    var brands = state.selectedBrands;
    return brands.length === 0 || (brands.length === 1 && brands[0] === "all");
  }

  function activeBrandSlugs() {
    if (isAllMode()) return [];
    return state.selectedBrands.filter(function (slug) { return slug !== "all"; });
  }

  function persistBrands() {
    var toSave = isAllMode() ? ["all"] : activeBrandSlugs();
    writeJSON(localStorage, LS_BRANDS, toSave);
  }

  function loadBrandsFromStorage() {
    var stored = readJSON(localStorage, LS_BRANDS, null);
    if (Array.isArray(stored)) {
      if (stored.length === 0 || (stored.length === 1 && stored[0] === "all")) {
        state.selectedBrands = ["all"];
      } else {
        state.selectedBrands = stored.filter(function (s) { return s && s !== "all"; });
        if (state.selectedBrands.length === 0) state.selectedBrands = ["all"];
      }
      return;
    }
    // Migrate legacy single-slug key
    var legacy = null;
    try { legacy = localStorage.getItem(LS_BRAND); } catch (e) { /* ok */ }
    if (legacy && legacy !== "all") {
      state.selectedBrands = [legacy];
    } else {
      state.selectedBrands = ["all"];
    }
    persistBrands();
  }

  function loadCollapseFromStorage() {
    var saved = null;
    try { saved = localStorage.getItem(LS_BRANDS_COLLAPSED); } catch (e) { /* ok */ }
    if (saved === "true" || saved === "false") {
      state.brandsCollapsed = saved === "true";
    } else {
      state.brandsCollapsed = false;
    }
  }

  function persistCollapse() {
    try { localStorage.setItem(LS_BRANDS_COLLAPSED, String(state.brandsCollapsed)); } catch (e) { /* ok */ }
  }

  function itemSortKey(item) {
    var k = itemKey(item);
    var s = String(state.seed) + "|" + k;
    var h = 0;
    for (var i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return h;
  }

  function sortItemsBySeed(items) {
    return items.slice().sort(function (a, b) {
      return itemSortKey(a) - itemSortKey(b);
    });
  }

  function mergeIntoDeck(newItems) {
    var inDeck = new Set(state.deck.map(itemKey));
    var fresh = [];
    newItems.forEach(function (item) {
      var k = itemKey(item);
      if (state.swiped.has(k) || inDeck.has(k)) return;
      inDeck.add(k);
      fresh.push(item);
    });
    if (fresh.length === 0) return;
    state.deck = sortItemsBySeed(state.deck.concat(fresh));
  }

  // Deterministic hue per brand name for the colored pill.
  function brandColor(name) {
    var h = 0;
    var s = String(name || "");
    for (var i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return "hsl(" + (h % 360) + ", 65%, 42%)";
  }

  // ---------- Init ----------
  function init() {
    var seed = parseInt(sessionStorage.getItem(SS_SEED), 10);
    if (!Number.isInteger(seed)) {
      seed = Math.floor(Math.random() * 1e9);
      try { sessionStorage.setItem(SS_SEED, String(seed)); } catch (e) { /* ok */ }
    }
    state.seed = seed;

    var swipedArr = readJSON(localStorage, LS_SWIPED, []);
    if (Array.isArray(swipedArr)) state.swiped = new Set(swipedArr);

    var saved = readJSON(localStorage, LS_SAVED, []);
    if (Array.isArray(saved)) state.saved = saved;

    loadBrandsFromStorage();
    loadCollapseFromStorage();
    applyCollapseUI();

    bindEvents();
    updateBadge();
    updateUndoBtn();
    maybeShowWelcome();
    loadBrands();
  }

  function maybeShowWelcome() {
    try {
      if (localStorage.getItem(LS_WELCOME) === "1") return;
    } catch (e) { /* ok */ }
    if (el.welcomeModal) el.welcomeModal.classList.remove("hidden");
  }

  function dismissWelcome() {
    if (el.welcomeModal) el.welcomeModal.classList.add("hidden");
    try { localStorage.setItem(LS_WELCOME, "1"); } catch (e) { /* ok */ }
  }

  function bindEvents() {
    el.navDeck.addEventListener("click", function () { switchView("deck"); });
    el.navSaved.addEventListener("click", function () {
      switchView(state.view === "saved" ? "deck" : "saved");
    });
    el.btnSkip.addEventListener("click", function () { triggerSwipe("skip"); });
    el.btnSave.addEventListener("click", function () { triggerSwipe("save"); });
    el.btnUndo.addEventListener("click", undo);
    el.btnExportJson.addEventListener("click", exportJSON);
    el.btnExportCsv.addEventListener("click", exportCSV);
    el.btnSkippedShops.addEventListener("click", function () { switchView("skipped"); });
    el.btnBackSaved.addEventListener("click", function () { switchView("saved"); });
    el.brandCollapseToggle.addEventListener("click", toggleBrandCollapse);
    if (el.brandSearch) {
      el.brandSearch.addEventListener("input", function () {
        state.brandFilterQuery = el.brandSearch.value.trim().toLowerCase();
        renderBrandBar();
      });
    }
    if (el.welcomeDismiss) {
      el.welcomeDismiss.addEventListener("click", dismissWelcome);
    }
    if (el.welcomeModal) {
      el.welcomeModal.querySelector(".modal-backdrop").addEventListener("click", dismissWelcome);
    }

    document.addEventListener("keydown", function (e) {
      if (e.target && /^(input|textarea|select)$/i.test(e.target.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        undo();
        return;
      }
      if (state.view !== "deck") return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        triggerSwipe("skip");
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        triggerSwipe("save");
      } else if (e.key === "u" || e.key === "U") {
        undo();
      }
    });
  }

  // ---------- Views ----------
  function switchView(view) {
    state.view = view;
    el.viewDeck.classList.toggle("hidden", view !== "deck");
    el.viewSaved.classList.toggle("hidden", view !== "saved");
    el.viewSkipped.classList.toggle("hidden", view !== "skipped");
    el.navDeck.classList.toggle("active", view === "deck");
    el.navSaved.classList.toggle("active", view === "saved" || view === "skipped");
    if (view === "saved") renderSaved();
    if (view === "skipped") loadSkipped();
  }

  // ---------- Brands ----------
  function loadBrands() {
    state.brandsError = false;
    showStatus("loading");
    fetch("/api/brands")
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        state.brands = Array.isArray(data.brands) ? data.brands : [];
        state.totalItems = data.total_items || 0;
        if (!isAllMode()) {
          var validSlugs = {};
          state.brands.forEach(function (b) { validSlugs[b.slug] = true; });
          state.selectedBrands = activeBrandSlugs().filter(function (slug) { return validSlugs[slug]; });
          if (state.selectedBrands.length === 0) state.selectedBrands = ["all"];
          persistBrands();
        }
        renderBrandBar();
        if (state.brands.length === 0) {
          showStatus("no-brands");
          return;
        }
        resetDeck();
      })
      .catch(function () {
        state.brandsError = true;
        showStatus("brands-error");
      });
  }

  function applyCollapseUI() {
    el.brandSection.classList.toggle("collapsed", state.brandsCollapsed);
    el.brandCollapseToggle.setAttribute("aria-expanded", String(!state.brandsCollapsed));
  }

  function toggleBrandCollapse() {
    state.brandsCollapsed = !state.brandsCollapsed;
    persistCollapse();
    applyCollapseUI();
  }

  function updateFilterCountBadge() {
    var slugs = activeBrandSlugs();
    if (slugs.length > 1) {
      el.brandFilterCount.textContent = String(slugs.length);
      el.brandFilterCount.classList.remove("hidden");
    } else {
      el.brandFilterCount.classList.add("hidden");
    }
  }

  function renderBrandBar() {
    el.brandChips.textContent = "";
    var q = state.brandFilterQuery;
    var filtered = q
      ? state.brands.filter(function (b) { return b.name.toLowerCase().indexOf(q) >= 0; })
      : state.brands;
    var all = { name: "All", slug: "all", count: state.totalItems };
    if (filtered.length === 0 && q) {
      var empty = document.createElement("p");
      empty.className = "brand-search-empty muted";
      empty.textContent = "No brands match";
      el.brandChips.appendChild(empty);
      updateFilterCountBadge();
      return;
    }
    var list = q ? filtered : [all].concat(filtered);
    list.forEach(function (b) {
      var chip = document.createElement("button");
      chip.type = "button";
      var isActive = b.slug === "all" ? isAllMode() : (!isAllMode() && state.selectedBrands.indexOf(b.slug) >= 0);
      chip.className = "chip" + (isActive ? " active" : "");
      chip.setAttribute("role", "tab");
      chip.setAttribute("aria-selected", String(isActive));
      var name = document.createElement("span");
      name.textContent = b.name;
      var count = document.createElement("span");
      count.className = "chip-count";
      count.textContent = String(b.count);
      chip.appendChild(name);
      chip.appendChild(count);
      chip.addEventListener("click", function () { toggleBrand(b.slug); });
      el.brandChips.appendChild(chip);
    });
    updateFilterCountBadge();
  }

  function toggleBrand(slug) {
    if (slug === "all") {
      if (isAllMode()) return;
      state.selectedBrands = ["all"];
    } else if (isAllMode()) {
      state.selectedBrands = [slug];
    } else {
      var idx = state.selectedBrands.indexOf(slug);
      if (idx >= 0) {
        state.selectedBrands.splice(idx, 1);
        if (state.selectedBrands.length === 0) state.selectedBrands = ["all"];
      } else {
        state.selectedBrands.push(slug);
      }
    }
    persistBrands();
    renderBrandBar();
    resetDeck();
  }

  // ---------- Deck data ----------
  function resetDeck() {
    state.seq++;
    state.deck = [];
    state.offset = 0;
    state.brandOffsets = {};
    state.brandTotals = {};
    state.total = null;
    state.exhausted = false;
    state.fetching = false;
    state.fetchError = false;
    renderDeck();
    ensureDeck();
  }

  function brandIsExhausted(slug) {
    if (state.brandTotals[slug] == null) return false;
    return (state.brandOffsets[slug] || 0) >= state.brandTotals[slug];
  }

  function anyBrandHasMore(slugs) {
    return slugs.some(function (slug) { return !brandIsExhausted(slug); });
  }

  function fetchAllMode(mySeq) {
    var url = "/api/items?brand=all" +
      "&seed=" + state.seed +
      "&offset=" + state.offset +
      "&limit=" + PAGE_SIZE;

    return fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (mySeq !== state.seq) return;
        var items = Array.isArray(data.items) ? data.items : [];
        state.total = typeof data.total === "number" ? data.total : items.length;
        state.offset += items.length;
        if (items.length === 0 || state.offset >= state.total) {
          state.exhausted = true;
        }
        mergeIntoDeck(items);
      });
  }

  function fetchMultiBrandMode(mySeq) {
    var slugs = activeBrandSlugs().filter(function (slug) { return !brandIsExhausted(slug); });
    if (slugs.length === 0) {
      state.exhausted = true;
      return Promise.resolve();
    }

    var fetches = slugs.map(function (slug) {
      var offset = state.brandOffsets[slug] || 0;
      var url = "/api/items?brand=" + encodeURIComponent(slug) +
        "&seed=" + state.seed +
        "&offset=" + offset +
        "&limit=" + PAGE_SIZE;
      return fetch(url)
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        })
        .then(function (data) {
          return { slug: slug, data: data };
        });
    });

    return Promise.all(fetches).then(function (results) {
      if (mySeq !== state.seq) return;
      var batch = [];
      var gotAny = false;
      results.forEach(function (result) {
        var slug = result.slug;
        var data = result.data;
        var items = Array.isArray(data.items) ? data.items : [];
        var total = typeof data.total === "number" ? data.total : items.length;
        state.brandTotals[slug] = total;
        var prevOffset = state.brandOffsets[slug] || 0;
        if (items.length === 0) {
          state.brandOffsets[slug] = total;
        } else {
          state.brandOffsets[slug] = prevOffset + items.length;
          gotAny = true;
        }
        items.forEach(function (item) { batch.push(item); });
      });
      mergeIntoDeck(sortItemsBySeed(batch));
      if (!gotAny || !anyBrandHasMore(activeBrandSlugs())) {
        state.exhausted = true;
      }
    });
  }

  function ensureDeck() {
    if (state.fetching || state.exhausted || state.fetchError) {
      renderDeck();
      return;
    }
    if (state.deck.length >= LOW_WATER) {
      renderDeck();
      return;
    }
    state.fetching = true;
    var mySeq = state.seq;
    renderDeck();

    var promise = isAllMode() ? fetchAllMode(mySeq) : fetchMultiBrandMode(mySeq);

    promise
      .then(function () {
        if (mySeq !== state.seq) return;
        state.fetching = false;
        ensureDeck();
      })
      .catch(function () {
        if (mySeq !== state.seq) return;
        state.fetching = false;
        state.fetchError = true;
        renderDeck();
      });
  }

  function prefetchImages() {
    state.deck.slice(0, PREFETCH_COUNT + 3).forEach(function (item) {
      if (!item.img) return;
      var url = proxied(item.img);
      if (state.prefetched.has(url)) return;
      state.prefetched.add(url);
      var img = new Image();
      img.src = url;
    });
  }

  // ---------- Deck rendering ----------
  function renderDeck() {
    if (state.isDragging) {
      // Rebuilding the stack now would destroy the card being dragged;
      // defer until the pointer is released.
      state.pendingRender = true;
      return;
    }
    state.pendingRender = false;
    el.stack.textContent = "";
    state.topEl = null;

    var visible = state.deck.slice(0, 3);
    // Append bottom-most first so the top card sits last in the DOM.
    for (var i = visible.length - 1; i >= 0; i--) {
      var card = buildCard(visible[i]);
      card.style.zIndex = String(100 - i);
      if (i > 0) {
        card.style.transform = "translateY(" + i * 12 + "px) scale(" + (1 - i * 0.045) + ")";
      } else {
        card.classList.add("top");
        attachDrag(card);
        state.topEl = card;
      }
      el.stack.appendChild(card);
    }

    if (visible.length === 0) {
      if (state.fetchError) showStatus("fetch-error");
      else if (state.fetching || (!state.exhausted && !state.brandsError && state.brands.length > 0)) showStatus("loading");
      else if (state.brands.length === 0) showStatus(state.brandsError ? "brands-error" : "no-brands");
      else showStatus("end");
    } else {
      hideStatus();
    }

    prefetchImages();
  }

  function buildCard(item) {
    var card = document.createElement("article");
    card.className = "card";

    var img = document.createElement("img");
    img.className = "card-img";
    img.alt = "";
    img.draggable = false;
    img.addEventListener("error", function () { card.classList.add("no-img"); });
    if (item.img) {
      img.src = proxied(item.img);
    } else {
      card.classList.add("no-img");
    }
    card.appendChild(img);

    var fallback = document.createElement("div");
    fallback.className = "card-fallback";
    var fbText = document.createElement("span");
    fbText.textContent = item.title || "Untitled item";
    fallback.appendChild(fbText);
    card.appendChild(fallback);

    var grad = document.createElement("div");
    grad.className = "card-grad";
    card.appendChild(grad);

    var info = document.createElement("div");
    info.className = "card-info";

    var chip = document.createElement("span");
    chip.className = "brand-chip";
    chip.textContent = item.brand || "Unknown";
    chip.style.background = brandColor(item.brand);
    info.appendChild(chip);

    var title = document.createElement("h3");
    title.className = "card-title";
    title.textContent = item.title || "Untitled item";
    info.appendChild(title);

    var store = document.createElement("p");
    store.className = "card-store";
    store.textContent = item.store || "";
    info.appendChild(store);

    card.appendChild(info);

    var stampSave = document.createElement("div");
    stampSave.className = "stamp stamp-save";
    stampSave.textContent = "SAVE";
    card.appendChild(stampSave);

    var stampSkip = document.createElement("div");
    stampSkip.className = "stamp stamp-skip";
    stampSkip.textContent = "SKIP";
    card.appendChild(stampSkip);

    return card;
  }

  // ---------- Drag / swipe ----------
  function attachDrag(card) {
    var startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;
    var stampSave = card.querySelector(".stamp-save");
    var stampSkip = card.querySelector(".stamp-skip");

    card.addEventListener("pointerdown", function (e) {
      if (card.classList.contains("flying")) return;
      dragging = true;
      state.isDragging = true;
      dx = 0; dy = 0;
      startX = e.clientX;
      startY = e.clientY;
      card.classList.add("dragging");
      try { card.setPointerCapture(e.pointerId); } catch (err) { /* ok */ }
    });

    card.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      dx = e.clientX - startX;
      dy = e.clientY - startY;
      var rot = dx * 0.05;
      card.style.transform = "translate(" + dx + "px, " + dy + "px) rotate(" + rot + "deg)";
      var strength = Math.min(Math.abs(dx) / SWIPE_THRESHOLD, 1);
      stampSave.style.opacity = dx > 0 ? String(strength) : "0";
      stampSkip.style.opacity = dx < 0 ? String(strength) : "0";
    });

    function release() {
      if (!dragging) return;
      dragging = false;
      state.isDragging = false;
      card.classList.remove("dragging");
      if (Math.abs(dx) >= SWIPE_THRESHOLD) {
        commitSwipe(dx > 0 ? "save" : "skip", card, dx, dy);
      } else {
        // Spring back — the base .card transition handles the animation.
        card.style.transform = "";
        stampSave.style.opacity = "0";
        stampSkip.style.opacity = "0";
        if (state.pendingRender) renderDeck();
      }
    }

    card.addEventListener("pointerup", release);
    card.addEventListener("pointercancel", release);
  }

  function triggerSwipe(action) {
    if (state.deck.length === 0 || !state.topEl) return;
    commitSwipe(action, state.topEl, 0, 0);
  }

  function commitSwipe(action, cardEl, dx, dy) {
    var item = state.deck.shift();
    if (!item) return;

    var k = itemKey(item);
    state.swiped.add(k);
    persistSwiped();

    if (action === "save") saveItem(item);

    state.undoStack.push({ item: item, action: action });
    if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
    updateUndoBtn();

    flyOff(cardEl, action, dx, dy);
    renderDeck();
    ensureDeck();
  }

  function flyOff(cardEl, action, dx, dy) {
    if (!cardEl || !cardEl.parentNode) return;
    // Move out of the stack (which renderDeck clears) into the deck wrapper.
    el.deck.appendChild(cardEl);
    cardEl.classList.remove("top", "dragging");

    var stamp = cardEl.querySelector(action === "save" ? ".stamp-save" : ".stamp-skip");
    var other = cardEl.querySelector(action === "save" ? ".stamp-skip" : ".stamp-save");
    if (stamp) stamp.style.opacity = "1";
    if (other) other.style.opacity = "0";

    var dir = action === "save" ? 1 : -1;
    var flyX = dir * (window.innerWidth || 800) * 1.1;
    var flyY = (dy || 0) + 60;
    var rot = dir * 30;

    // Force a reflow so the transition animates from the current transform.
    void cardEl.offsetWidth;
    cardEl.classList.add("flying");
    cardEl.style.transform = "translate(" + flyX + "px, " + flyY + "px) rotate(" + rot + "deg)";

    setTimeout(function () {
      if (cardEl.parentNode) cardEl.parentNode.removeChild(cardEl);
    }, 500);
  }

  // ---------- Save / undo ----------
  function saveItem(item) {
    var k = itemKey(item);
    var exists = state.saved.some(function (s) { return itemKey(s) === k; });
    if (!exists) {
      state.saved.unshift({
        id: item.id,
        title: item.title,
        brand: item.brand,
        store: item.store,
        url: albumLink(item.url),
        img: item.img,
        savedAt: Date.now()
      });
      persistSaved();
    }
    updateBadge();
  }

  function unsaveItem(key) {
    state.saved = state.saved.filter(function (s) { return itemKey(s) !== key; });
    persistSaved();
    updateBadge();
  }

  function undo() {
    var last = state.undoStack.pop();
    if (!last) return;
    updateUndoBtn();

    var k = itemKey(last.item);
    state.swiped.delete(k);
    persistSwiped();

    if (last.action === "save") {
      unsaveItem(k);
      if (state.view === "saved") renderSaved();
    }

    state.deck.unshift(last.item);
    if (state.view !== "deck") switchView("deck");
    renderDeck();
  }

  function updateBadge() {
    var n = state.saved.length;
    el.savedBadge.textContent = n > 99 ? "99+" : String(n);
    el.savedBadge.classList.toggle("hidden", n === 0);
  }

  function updateUndoBtn() {
    el.btnUndo.disabled = state.undoStack.length === 0;
  }

  // ---------- Deck status ----------
  function showStatus(kind) {
    var box = el.deckStatus;
    box.textContent = "";
    box.classList.remove("hidden");

    if (kind === "loading") {
      var spin = document.createElement("div");
      spin.className = "spinner";
      box.appendChild(spin);
      var p = document.createElement("p");
      p.textContent = "Loading items...";
      box.appendChild(p);
      return;
    }

    var title = document.createElement("h3");
    var msg = document.createElement("p");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "primary-btn";

    if (kind === "no-brands") {
      title.textContent = "Set up your deck";
      msg.textContent = "";
      var steps = document.createElement("ol");
      steps.className = "setup-steps";
      [
        "pip install -r requirements.txt",
        "python app/server.py --demo   (try sample items)",
        "python scraper/scrape.py --limit 20   (or full scrape)",
        "python app/server.py   (without --demo)"
      ].forEach(function (line) {
        var li = document.createElement("li");
        var code = document.createElement("code");
        code.textContent = line;
        li.appendChild(code);
        steps.appendChild(li);
      });
      msg.appendChild(steps);
      var sub = document.createElement("p");
      sub.className = "muted";
      sub.textContent = "See README.md in the repo for full instructions.";
      msg.appendChild(sub);
      btn.textContent = "Retry";
      btn.addEventListener("click", loadBrands);
      fetch("/api/info").then(function (r) { return r.json(); }).then(function (info) {
        if (info.demo) {
          sub.textContent = "Demo mode is active — if you still see this, refresh the page.";
        }
      }).catch(function () { /* ok */ });
    } else if (kind === "brands-error") {
      title.textContent = "Could not reach the server";
      msg.textContent = "Failed to load brands. Make sure the server is running, then retry.";
      btn.textContent = "Retry";
      btn.addEventListener("click", loadBrands);
    } else if (kind === "fetch-error") {
      title.textContent = "Something went wrong";
      msg.textContent = "Failed to load items. Check your connection and try again.";
      btn.textContent = "Retry";
      btn.addEventListener("click", function () {
        state.fetchError = false;
        ensureDeck();
      });
    } else { // end of deck
      title.textContent = "That's everything";
      msg.textContent = "You have swiped through every item for this filter. Start over to see swiped items again.";
      btn.textContent = "Start over";
      btn.addEventListener("click", function () {
        if (!window.confirm("Reset all swiped items? Saved items are kept.")) return;
        state.swiped = new Set();
        persistSwiped();
        state.undoStack = [];
        updateUndoBtn();
        resetDeck();
      });
    }

    box.appendChild(title);
    box.appendChild(msg);
    box.appendChild(btn);
  }

  function hideStatus() {
    el.deckStatus.classList.add("hidden");
  }

  // ---------- Saved view ----------
  function renderSaved() {
    el.savedGrid.textContent = "";
    el.savedEmpty.classList.toggle("hidden", state.saved.length > 0);

    state.saved.forEach(function (item) {
      var key = itemKey(item);

      var a = document.createElement("a");
      a.className = "saved-card";
      a.href = albumLink(item.url);
      a.target = "_blank";
      a.rel = "noopener noreferrer";

      var thumb = document.createElement("div");
      thumb.className = "saved-thumb";

      var img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.addEventListener("error", function () { thumb.classList.add("broken"); });
      if (item.img) {
        img.src = proxied(item.img);
      } else {
        thumb.classList.add("broken");
      }
      thumb.appendChild(img);

      var fb = document.createElement("div");
      fb.className = "thumb-fallback";
      fb.textContent = item.title || "Untitled item";
      thumb.appendChild(fb);

      a.appendChild(thumb);

      var meta = document.createElement("div");
      meta.className = "saved-meta";

      var chip = document.createElement("span");
      chip.className = "brand-chip";
      chip.textContent = item.brand || "Unknown";
      chip.style.background = brandColor(item.brand);
      meta.appendChild(chip);

      var title = document.createElement("h3");
      title.className = "saved-title";
      title.textContent = item.title || "Untitled item";
      meta.appendChild(title);

      var store = document.createElement("p");
      store.className = "saved-store";
      store.textContent = item.store || "";
      meta.appendChild(store);

      a.appendChild(meta);

      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove-btn";
      remove.setAttribute("aria-label", "Remove from saved");
      remove.innerHTML =
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<polyline points="3 6 5 6 21 6"/>' +
        '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
        "</svg>";
      remove.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        unsaveItem(key);
        renderSaved();
      });
      a.appendChild(remove);

      el.savedGrid.appendChild(a);
    });
  }

  // ---------- Export ----------
  function downloadBlob(content, filename, mime) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function exportJSON() {
    var payload = state.saved.map(function (s) {
      return {
        id: s.id,
        title: s.title,
        brand: s.brand,
        store: s.store,
        url: albumLink(s.url),
        img: s.img,
        savedAt: s.savedAt
      };
    });
    downloadBlob(JSON.stringify(payload, null, 2), "fr_saved.json", "application/json");
  }

  function csvField(v) {
    return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  }

  function exportCSV() {
    var lines = ["brand,title,store,url,img"];
    state.saved.forEach(function (s) {
      lines.push([s.brand, s.title, s.store, albumLink(s.url), s.img].map(csvField).join(","));
    });
    downloadBlob(lines.join("\r\n"), "fr_saved.csv", "text/csv;charset=utf-8");
  }

  // ---------- Skipped shops view ----------
  function loadSkipped() {
    el.skippedList.textContent = "";
    var spin = document.createElement("div");
    spin.className = "spinner";
    el.skippedList.appendChild(spin);

    fetch("/api/skipped")
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        el.skippedList.textContent = "";
        var entries = Array.isArray(data) ? data : [];
        if (entries.length === 0) {
          var p = document.createElement("p");
          p.className = "muted";
          p.textContent = "No skipped shops.";
          el.skippedList.appendChild(p);
          return;
        }
        var groups = {};
        var order = [];
        entries.forEach(function (entry) {
          var brand = entry.brand || "Other";
          if (!groups[brand]) {
            groups[brand] = [];
            order.push(brand);
          }
          groups[brand].push(entry);
        });
        order.sort(function (a, b) { return a.localeCompare(b); });
        order.forEach(function (brand) {
          var group = document.createElement("div");
          group.className = "skipped-group";
          var h = document.createElement("h3");
          h.textContent = brand;
          group.appendChild(h);
          var links = document.createElement("div");
          links.className = "skipped-links";
          groups[brand].forEach(function (entry) {
            var a = document.createElement("a");
            a.className = "skipped-link";
            a.href = entry.href || "#";
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.innerHTML =
              '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
              '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
              '<polyline points="15 3 21 3 21 9"/>' +
              '<line x1="10" y1="14" x2="21" y2="3"/>' +
              "</svg>";
            var text = document.createElement("span");
            text.textContent = entry.text || entry.href || "";
            a.appendChild(text);
            links.appendChild(a);
          });
          group.appendChild(links);
          el.skippedList.appendChild(group);
        });
      })
      .catch(function () {
        el.skippedList.textContent = "";
        var p = document.createElement("p");
        p.className = "muted";
        p.textContent = "Failed to load skipped shops.";
        el.skippedList.appendChild(p);
      });
  }

  // ---------- Go ----------
  init();
})();
