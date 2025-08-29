(function () {
  // ---------- helpers ----------
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const on = (sel, ev, fn, opts) => {
    const el = typeof sel === "string" ? $(sel) : sel;
    if (el && el.addEventListener)
      el.addEventListener(ev, fn, opts || { passive: true });
    return !!el;
  };
  const ready = (fn) => {
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    else fn();
  };

  // expose data from inline block if needed
  if (!window.meta && window.MANGA_META) window.meta = window.MANGA_META;
  if (!window.chapters && window.MANGA_CHAPTERS)
    window.chapters = window.MANGA_CHAPTERS;

  ready(function initApp() {
    if (!window.meta || !window.chapters) return;

    // ---------- storage keys ----------
    const STORE_PREFIX = "mreader:v10";
    let slug = window.meta?.slug;
    
    // Si no hay slug, intentar obtenerlo del título
    if (!slug) {
      console.warn('No se encontró slug en window.meta, usando título como fallback');
      slug = window.meta?.title?.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "manga";
    }

    // por-manga
    const K = {
      prefs: `${STORE_PREFIX}:${slug}:prefs`,
      seen: `${STORE_PREFIX}:${slug}:seen`,
    };
    const prefsDefault = {
      mode: "scroll",
      dir: "rtl",
      fit: "width", // valores posibles: "width", "height", "none"
      compact: false,
    };
    const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
    const load = (k, d) => {
      try {
        return JSON.parse(localStorage.getItem(k)) ?? d;
      } catch {
        return d;
      }
    };

    // globales (para usar en otra página)
    const GLOBAL_FAV_KEY = "mreader:favorites"; // array [{slug,title,cover,genres,addedAt}]
    const loadArr = (k) => {
      try {
        return JSON.parse(localStorage.getItem(k)) ?? [];
      } catch {
        return [];
      }
    };
    const saveArr = (k, a) => localStorage.setItem(k, JSON.stringify(a));
    const upsertFront = (k, obj, by = "slug") => {
      const arr = loadArr(k).filter((x) => x[by] !== obj[by]);
      arr.unshift(obj);
      saveArr(k, arr);
      return arr;
    };
    const removeBy = (k, val, by = "slug") => {
      const arr = loadArr(k).filter((x) => x[by] !== val);
      saveArr(k, arr);
      return arr;
    };

    // Global setting: chapters order reversed
    const GLOBAL_ORDER_KEY = "mreader:chaptersReversed";
    const loadBool = (k, d = false) => {
      try {
        const v = localStorage.getItem(k);
        if (v === null) return d;
        if (v === "true" || v === "false") return v === "true";
        return !!JSON.parse(v);
      } catch {
        return d;
      }
    };
    const saveBool = (k, v) => localStorage.setItem(k, String(!!v));

    // ---------- state ----------
    const state = {
      prefs: load(K.prefs, prefsDefault),
      current: { index: -1, chapter: null, images: [], page: 0 },
      io: null,
      lazyQueue: [],
      lazyBusy: false,
      _lastAppliedIdx: null, // para override por imagen
      fitOverride: {}, // { [chapterKey]: { [idx]: 'width'|'height'|null } }
      seeking: false, // slider arrastrando
      seen: load(K.seen, {}), // capítulos vistos por key
      chaptersReversed: loadBool(GLOBAL_ORDER_KEY, false), // estado del orden de capítulos
    };

    // Mostrar/ocultar ajustes de dirección según el modo inicial
    const dirSettings = $("#directionSettings");
    if (dirSettings) {
      dirSettings.style.display = state.prefs.mode === "paged" ? "" : "none";
    }

    // Configurar el modo compacto
    on("#compactMode", "change", (e) => {
      setPref("compact", e.target.checked);
      if (state.current.chapter) {
        // Actualizar las clases y estilos inmediatamente
        $("#reader").classList.toggle("compact", e.target.checked);

        // Actualizar alturas mínimas de placeholders
        $$("#readerScroll .img-container img").forEach((img) => {
          img.style.minHeight = e.target.checked ? "20vh" : "30vh";
        });
      }
    });

    // ---------- utils ----------
    const chapterKey = () =>
      state.current.chapter
        ? state.current.chapter.number ?? `${state.current.index + 1}`
        : null;

    function getCurrentScrollIndex() {
      const body = $("#readerBody"),
        cont = $("#readerScroll");
      if (!body || !cont) return 0;
      const center = body.scrollTop + body.clientHeight / 2;
      const imgs = Array.from(cont.querySelectorAll("img"));
      if (!imgs.length) return 0;
      let bestIdx = 0,
        bestDist = Infinity;
      for (let i = 0; i < imgs.length; i++) {
        const mid = imgs[i].offsetTop + imgs[i].offsetHeight / 2;
        const d = Math.abs(mid - center);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      return bestIdx;
    }
    const currentImageIndex = () =>
      state.prefs.mode === "paged"
        ? state.current.page || 0
        : getCurrentScrollIndex();

    // ---------- FAVORITOS ----------
    function isFavorite() {
      const favs = loadArr(GLOBAL_FAV_KEY);
      return favs.some((f) => f.slug === slug);
    }
    function toggleFavorite() {
      const btn = $("#favBtn");
      if (isFavorite()) {
        removeBy(GLOBAL_FAV_KEY, slug, "slug");
        if (btn) {
          btn.classList.remove("active");
          btn.setAttribute("aria-pressed", "false");
          const heart = btn.querySelector(".heart");
          heart.classList.remove("ri-heart-3-fill");
          heart.classList.add("ri-heart-3-line");
        }
      } else {
        upsertFront(GLOBAL_FAV_KEY, {
          slug,
          title: window.meta?.title || "",
          cover: window.meta?.cover || "",
          genres: window.meta?.genres || [],
          addedAt: Date.now(),
        });
        if (btn) {
          btn.classList.add("active");
          btn.setAttribute("aria-pressed", "true");
          const heart = btn.querySelector(".heart");
          heart.classList.remove("ri-heart-3-line");
          heart.classList.add("ri-heart-3-fill");
        }
      }
    }
    // === REEMPLAZA COMPLETAMENTE ===
    function ensureFavoriteButton() {
      const hero = document.querySelector("#hero");
      if (!hero) return;

      // Usando Remixicon para el corazón (outline por defecto, filled cuando es favorito)
      const heartSVG = `<i class="heart ri-heart-3-line"></i>`;

      let btn = document.querySelector("#favBtn");
      if (!btn) {
        btn = document.createElement("button");
        btn.id = "favBtn";
        btn.className = "fav-btn";
        btn.type = "button";
        btn.setAttribute("aria-label", "Favorito");
        btn.setAttribute("aria-pressed", "false");
        hero.appendChild(btn);
        btn.addEventListener("click", toggleFavorite, { passive: true }); // ya definida en tu script
      }

      // Forzar el nuevo SVG (por si había el diseño antiguo)
      btn.innerHTML = heartSVG;

      // Estado inicial segun localStorage
      let favs;
      try {
        favs = JSON.parse(localStorage.getItem("mreader:favorites")) || [];
      } catch {
        favs = [];
      }
      const slug = (window.meta?.title || "manga")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-");
      const isFav = favs.some((f) => f.slug === slug);

      btn.classList.toggle("active", isFav);
      btn.setAttribute("aria-pressed", isFav ? "true" : "false");
    }

    // ---------- hero / inicio ----------
    function renderHero() {
      $("#heroPoster") && ($("#heroPoster").src = window.meta?.cover || "");
      $("#heroBg") &&
        ($("#heroBg").style.backgroundImage = `url('${
          window.meta?.cover || ""
        }')`);
      $("#title") && ($("#title").textContent = window.meta?.title || "Manga");
      $("#mainTag") && ($("#mainTag").textContent = window.meta?.mainTag || "");
      $("#genres") &&
        ($("#genres").innerHTML = (window.meta?.genres || [])
          .map((g) => `<span class="tag">${g}</span>`)
          .join(""));
      $("#synopsis") &&
        ($("#synopsis").textContent = window.meta?.synopsis || "");

      ensureFavoriteButton();

      // Cambiar a filled cuando es favorito
      const btn = $("#favBtn");
      if (btn && btn.classList.contains("active")) {
        btn.querySelector(".heart").classList.remove("ri-heart-3-line");
        btn.querySelector(".heart").classList.add("ri-heart-3-fill");
      }
    }

    function renderList() {
      const tb = $("#chaptersTable tbody");
      if (!tb) return;
      tb.innerHTML = "";

      const chapters = window.chapters || [];
      const chaptersToRender = state.chaptersReversed
        ? [...chapters].reverse()
        : chapters;

      chaptersToRender.forEach((ch, displayIndex) => {
        const originalIndex = state.chaptersReversed
          ? chapters.length - 1 - displayIndex
          : displayIndex;
        const key = ch.number ?? `${originalIndex + 1}`;
        const isSeen = !!(state.seen && state.seen[key]);

        const tr = document.createElement("tr");
        tr.className = "episode-row" + (isSeen ? " is-seen" : "");
        tr.dataset.idx = String(originalIndex);
        tr.innerHTML = `
          <td class="episode-cell">
            <span class="episode-title" style="font-size:14px">${ch.title || "Capítulo " + key}</span>
          </td>
          <td class="episode-seen">
            <div class="seen-wrap">
              <input type="checkbox" class="seen-checkbox" aria-label="Marcar como visto" data-idx="${originalIndex}" ${isSeen ? "checked" : ""} />
            </div>
          </td>`;
        tb.appendChild(tr);
      });

      // Fila clickeable para leer
      $$("#chaptersTable tbody tr.episode-row").forEach((row) => {
        on(row, "click", () => openReader(+row.dataset.idx));
      });

      // Checkbox de visto con persistencia
      $$("#chaptersTable input[type=\"checkbox\"][data-idx]").forEach((chk) => {
        on(chk, "click", (e) => e.stopPropagation());
        on(chk, "change", () => {
          const idx = +chk.dataset.idx;
          const key = (window.chapters[idx]?.number) ?? `${idx + 1}`;
          state.seen = state.seen || {};
          state.seen[key] = chk.checked;
          save(K.seen, state.seen);
          const tr = chk.closest("tr");
          if (tr) tr.classList.toggle("is-seen", chk.checked);
        });
      });

      updateReverseButton();
    }

    // Función para actualizar el texto del botón de inversión
    function updateReverseButton() {
      const btn = $("#btnReverseOrder");
      if (!btn) return;
      
      const icon = btn.querySelector("i");
      if (state.chaptersReversed) {
        if (icon) {
          icon.className = "ri-sort-asc";
        }
        btn.innerHTML = '<i class="ri-sort-asc"></i> Orden original';
        btn.title = "Volver al orden original";
      } else {
        if (icon) {
          icon.className = "ri-sort-desc";
        }
        btn.innerHTML = '<i class="ri-sort-desc"></i> Invertir orden';
        btn.title = "Invertir orden de capítulos";
      }
    }

    // Función para invertir el orden de los capítulos
    function toggleChaptersOrder() {
      state.chaptersReversed = !state.chaptersReversed;
      saveBool(GLOBAL_ORDER_KEY, state.chaptersReversed);
      renderList();
    }

    // ---------- overrides por imagen ----------
    function getOverrideFor(idx) {
      const key = chapterKey();
      if (!key) return null;
      const map = state.fitOverride[key] || {};
      return map[idx] ?? null; // 'width'|'height'|null
    }
    function setOverrideFor(idx, mode) {
      const key = chapterKey();
      if (!key) return;
      state.fitOverride[key] = state.fitOverride[key] || {};
      state.fitOverride[key][idx] = mode; // null => Auto
    }
    function resetInlineFor(idx) {
      if (state.prefs.mode === "scroll") {
        const cont = $("#readerScroll");
        if (!cont) return;
        const img = cont.querySelector(`img[data-idx="${idx}"]`);
        if (!img) return;
        img.style.maxWidth = "";
        img.style.width = "";
        img.style.maxHeight = "";
        img.style.height = "";
      } else {
        const img = $("#pageImg");
        if (!img) return;
        img.style.maxWidth = "";
        img.style.width = "";
        img.style.maxHeight = "";
        img.style.height = "";
      }
    }
    function updateFitBadge(mode) {
      const b = $("#fitModeBadge");
      if (!b) return;
      b.textContent =
        mode === "width" ? "Ancho" : mode === "height" ? "Alto" : "Auto";
    }
    function applyPerImageFit(idx) {
      if (state._lastAppliedIdx != null && state._lastAppliedIdx !== idx)
        resetInlineFor(state._lastAppliedIdx);
      state._lastAppliedIdx = idx;

      const mode = getOverrideFor(idx);
      updateFitBadge(mode);

      if (state.prefs.mode === "scroll") {
        const cont = $("#readerScroll");
        if (!cont) return;
        const img = cont.querySelector(`img[data-idx="${idx}"]`);
        if (!img) return;
        if (mode === "width") {
          img.style.width = "100%";
          img.style.maxWidth = "none";
          img.style.height = "auto";
          img.style.maxHeight = "";
        } else if (mode === "height") {
          img.style.width = "auto";
          img.style.maxWidth = "none";
          img.style.height = "auto";
          img.style.maxHeight = "85vh";
        } else {
          img.style.maxWidth = "";
          img.style.width = "";
          img.style.height = "";
          img.style.maxHeight = "";
        }
      } else {
        const img = $("#pageImg");
        if (!img) return;
        if (mode === "width") {
          img.style.width = "100%";
          img.style.maxWidth = "none";
          img.style.height = "auto";
          img.style.maxHeight = "";
        } else if (mode === "height") {
          img.style.width = "auto";
          img.style.maxWidth = "none";
          img.style.height = "auto";
          img.style.maxHeight = "calc(100vh - 56px)";
        } else {
          img.style.maxWidth = "";
          img.style.width = "";
          img.style.height = "";
          img.style.maxHeight = "";
        }
      }
    }

    // ---------- prefs globales ----------
    function syncPrefButtons() {
      [
        ["#modeScroll", state.prefs.mode === "scroll"],
        ["#modePaged", state.prefs.mode === "paged"],
        ["#dirRTL", state.prefs.dir === "rtl"],
        ["#dirLTR", state.prefs.dir === "ltr"],
        ["#fitContain", state.prefs.fit === "contain"],
        ["#fitWidth", state.prefs.fit === "width"],
        ["#fitNone", state.prefs.fit === "none"],
      ].forEach(([sel, act]) => {
        const el = $(sel);
        if (el) el.classList.toggle("active", act);
      });

      // Sincronizar checkbox de modo compacto
      const compactCheck = $("#compactMode");
      if (compactCheck) compactCheck.checked = state.prefs.compact;
    }
    function setPref(key, val) {
      if (key === "mode" && val !== state.prefs.mode) {
        captureIndexBeforeModeSwitch();
        // Mostrar/ocultar ajustes de dirección según el modo
        const dirSettings = $("#directionSettings");
        if (dirSettings) {
          dirSettings.style.display = val === "paged" ? "" : "none";
        }
      }
      state.prefs[key] = val;
      save(K.prefs, state.prefs);
      syncPrefButtons();
      if (state.current.chapter) renderReader(true); // viene de cambio de modo
    }

    // ---------- lector ----------
    async function openReader(chIndex) {
      const ch = window.chapters[chIndex];
      if (!ch) return;
      state.current.index = chIndex;
      state.current.chapter = ch;
      state.current.images = ch.images || [];
      state.current.page = 0;

      // limpiar targets heredados para evitar arrastrar scroll
      state._scrollTargetIndex = null;
      state._lastAppliedIdx = null;

      const key = ch.number ?? `${chIndex + 1}`;
      $("#readerTitle") &&
        ($("#readerTitle").textContent = ch.title || "Capítulo " + key);
      const reader = $("#reader");
      if (reader) {
        reader.classList.add("active");
        reader.setAttribute("aria-hidden", "false");
      }
      document.body.style.overflow = "hidden";

      await renderReader();

      // Precargar algunas imágenes cercanas
      if (state.prefs.mode === "scroll") {
        const currentPage = state.current.page || 0;
        const imagesToPreload = 2; // Número de imágenes a precargar antes y después
        const start = Math.max(0, currentPage - imagesToPreload);
        const end = Math.min(
          state.current.images.length - 1,
          currentPage + imagesToPreload
        );

        // Precargar el rango de imágenes
        await Promise.all(
          state.current.images.slice(start, end + 1).map(
            (src) =>
              new Promise((resolve) => {
                const img = new Image();
                img.onload = resolve;
                img.onerror = resolve;
                img.src = src;
              })
          )
        );

        // Ahora que las imágenes están cargadas, hacer scroll a la posición correcta
        const targetImg = document.querySelector(
          `#readerScroll img[data-idx="${currentPage}"]`
        );
        if (targetImg) {
          targetImg.scrollIntoView({ block: "start" });
        }
      }

      // Remover el indicador de carga (si existe)
      if (typeof loadingIndicator !== "undefined" && loadingIndicator && typeof loadingIndicator.remove === "function") {
        loadingIndicator.remove();
      }
    }

    function closeReader() {
      const reader = $("#reader");
      if (reader) {
        reader.classList.remove("active");
        reader.setAttribute("aria-hidden", "true");
      }
      document.body.style.overflow = "";
      renderList();
      if (typeof refreshContinueCard === "function") {
        refreshContinueCard();
      }
    }

    function captureIndexBeforeModeSwitch() {
      if (!state.current.chapter) return;
      if (state.prefs.mode === "scroll")
        state._scrollTargetIndex = getCurrentScrollIndex();
      else state._scrollTargetIndex = state.current.page || 0;
    }

    function renderReader(fromModeChange = false) {
      const isScroll = state.prefs.mode === "scroll";
      const body = $("#readerBody");
      const cont = $("#readerScroll");
      const paged = $("#readerPaged");
      if (!body) return;

      // reset IO/handlers
      if (state.io) {
        state.io.disconnect();
        state.io = null;
      }
      state.lazyQueue = [];
      state.lazyBusy = false;
      body.onscroll = null;
      const pimg = $("#pageImg");
      if (pimg) pimg.onclick = null;
      state._lastAppliedIdx = null;

      if (cont) cont.style.display = isScroll ? "" : "none";
      if (paged) paged.classList.toggle("active", !isScroll);

      if (isScroll && cont) {
        cont.innerHTML = "";

        // Aplicar modo compacto si está activado
        $("#reader").classList.toggle("compact", state.prefs.compact);

        // Empezar siempre arriba
        body.scrollTop = 0;

        // crear imágenes con contenedores y loaders
        state.current.images.forEach((src, idx) => {
          const container = document.createElement("div");
          container.className = "img-container";

          const img = document.createElement("img");
          img.setAttribute("loading", "lazy");
          img.dataset.src = src;
          img.dataset.idx = idx;
          img.alt = "Página";
          img.style.minHeight = state.prefs.compact ? "20vh" : "30vh"; // placeholder ajustado según modo
          img.addEventListener("click", toggleReaderUI);

          const loader = document.createElement("div");
          loader.className = "img-loader";

          container.appendChild(img);
          container.appendChild(loader);
          cont.appendChild(container);
        });

        setupLazy(cont);
        applyReaderFit();

        // restaurar destino si existe
        let targetIndex = 0;
        if (fromModeChange && state._scrollTargetIndex != null) {
          targetIndex = Math.max(
            0,
            Math.min(state.current.images.length - 1, state._scrollTargetIndex)
          );
        }

        if (targetIndex > 0 || fromModeChange) {
          const imgs = cont.querySelectorAll("img");
          const t = imgs[targetIndex];
          if (t) {
            t.scrollIntoView({ block: "start" });
            // Forzar la carga de la imagen actual y las adyacentes primero
            forceLoadImage(t);
            if (imgs[targetIndex - 1]) forceLoadImage(imgs[targetIndex - 1]);
            if (imgs[targetIndex + 1]) forceLoadImage(imgs[targetIndex + 1]);

            // Luego cargar todas las demás imágenes en segundo plano
            requestIdleCallback(
              () => {
                const startTime = Date.now();
                const BATCH_SIZE = 3; // Número de imágenes a cargar por lote
                const BATCH_DELAY = 100; // ms entre lotes para no saturar

                function loadBatch(startIdx) {
                  if (startIdx >= imgs.length) return;

                  // Cargar un lote de imágenes
                  for (
                    let i = 0;
                    i < BATCH_SIZE && startIdx + i < imgs.length;
                    i++
                  ) {
                    const img = imgs[startIdx + i];
                    if (
                      img &&
                      img.dataset.src &&
                      !img.dataset.enqueued &&
                      img !== t && // Saltar la imagen actual y adyacentes que ya cargamos
                      img !== imgs[targetIndex - 1] &&
                      img !== imgs[targetIndex + 1]
                    ) {
                      forceLoadImage(img);
                    }
                  }

                  // Programar el siguiente lote con un pequeño retraso
                  setTimeout(() => {
                    // Si han pasado más de 10 segundos, usar requestIdleCallback para el siguiente lote
                    if (Date.now() - startTime > 10000) {
                      requestIdleCallback(() =>
                        loadBatch(startIdx + BATCH_SIZE)
                      );
                    } else {
                      loadBatch(startIdx + BATCH_SIZE);
                    }
                  }, BATCH_DELAY);
                }

                // Comenzar la carga de lotes
                loadBatch(0);
              },
              { timeout: 1000 }
            );
          }
        }

        applyPerImageFit(currentImageIndex());
        body.onscroll = onReaderScroll;
        onReaderScroll();
      } else if (pimg) {
        applyReaderFit();
        if (fromModeChange && state._scrollTargetIndex != null) {
          state.current.page = Math.max(
            0,
            Math.min(state.current.images.length - 1, state._scrollTargetIndex)
          );
        }
        renderPage();
        pimg.onclick = toggleReaderUI;
        prefetchAround(state.current.page);
      }

      updateFootControls("render");
      syncPrefButtons();
    }

    // ---------- lazy ordenado ----------
    function setupLazy(container) {
      const root = $("#readerBody");
      if (!("IntersectionObserver" in window) || !root) {
        container.querySelectorAll("img[data-src]").forEach(forceLoadImage);
        return;
      }

      // Crear un buffer para evitar llamadas excesivas a processLazyQueue
      let processingTimeout = null;
      const scheduleProcessing = () => {
        clearTimeout(processingTimeout);
        processingTimeout = setTimeout(processLazyQueue, 16); // ~1 frame
      };

      state.io = new IntersectionObserver(
        (entries) => {
          let hasNewImages = false;

          // Procesar tanto las imágenes que entran como las que salen del viewport
          entries.forEach((entry) => {
            const img = entry.target;
            if (entry.isIntersecting) {
              // Cuando la imagen entra en el viewport
              if (img.dataset.src && !img.dataset.enqueued) {
                img.dataset.enqueued = "1";
                // Priorizar basado en la dirección del scroll
                const scrollingUp = state.lastScrollTop > root.scrollTop;
                if (scrollingUp) {
                  state.lazyQueue.unshift(img); // Agregar al inicio para cargar primero
                } else {
                  state.lazyQueue.push(img);
                }
                hasNewImages = true;
              }
            } else {
              // Cuando la imagen sale del viewport pero está en la cola,
              // mantenerla en la cola para que se cargue de todos modos
              if (img.dataset.src && !img.src) {
                // No hacer nada, dejar que se cargue
              }
            }
          });

          // Solo procesar si hay nuevas imágenes
          if (hasNewImages) {
            scheduleProcessing();
          }
        },
        {
          root,
          // Aumentar significativamente el margen de pre-carga
          rootMargin: "200% 0px 200% 0px",
          threshold: 0,
        }
      );
      container
        .querySelectorAll("img[data-src]")
        .forEach((img) => state.io.observe(img));
    }
    function processLazyQueue() {
      if (state.lazyBusy) return;
      state.lazyBusy = true;

      // Aumentar la concurrencia para cargar más imágenes a la vez
      const CONCURRENCY = 4;
      let active = 0;
      let timeoutId = null;

      const step = () => {
        // Si no hay imágenes activas y la cola está vacía, terminar
        if (active === 0 && state.lazyQueue.length === 0) {
          state.lazyBusy = false;
          return;
        }

        // Si alcanzamos el límite de concurrencia, esperar
        if (active >= CONCURRENCY) return;

        // Obtener la siguiente imagen de la cola
        const img = state.lazyQueue.shift();
        if (!img) {
          // Si no hay más imágenes pero hay algunas cargando,
          // programar una verificación en el futuro
          if (active > 0) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => step(), 100);
          } else {
            state.lazyBusy = false;
          }
          return;
        }

        active++;

        const done = () => {
          active--;
          // Limpiar los event listeners para evitar memory leaks
          img.onload = null;
          img.onerror = null;
          // Continuar con la siguiente imagen
          step();
        };

        if (img.dataset && img.dataset.src) {
          // Crear una nueva Image para precargar
          const loader = new Image();
          loader.onload = () => {
            // Una vez precargada, asignarla a la imagen visible
            img.src = img.dataset.src;
            img.removeAttribute("data-src");
            done();
          };
          loader.onerror = () => {
            console.error("Error cargando imagen:", img.dataset.src);
            done();
          };
          // Iniciar la precarga
          loader.src = img.dataset.src;
        } else {
          done();
        }

        // Intentar cargar más imágenes en paralelo
        step();
      };

      // Iniciar el proceso
      step();
    }
    function forceLoadImage(img) {
      if (!img) return;
      if (img.dataset && img.dataset.src) {
        img.src = img.dataset.src;
        img.removeAttribute("data-src");
      }
    }
    function ensureLoadedIndex(idx) {
      return new Promise((resolve) => {
        const cont = $("#readerScroll");
        const imgs = cont ? cont.querySelectorAll("img") : null;
        const img = imgs ? imgs[idx] : null;
        if (!img) {
          resolve();
          return;
        }
        // forzar target y vecinas
        forceLoadImage(img);
        if (imgs[idx - 1]) forceLoadImage(imgs[idx - 1]);
        if (imgs[idx + 1]) forceLoadImage(imgs[idx + 1]);

        if ((img.complete && img.naturalHeight > 0) || !img.dataset.src) {
          resolve();
          return;
        }
        const done = () => {
          img.removeEventListener("load", done);
          img.removeEventListener("error", done);
          resolve();
        };
        img.addEventListener("load", done, { once: true });
        img.addEventListener("error", done, { once: true });
      });
    }

    // ---------- fit global + UI ----------
    function applyReaderFit() {
      const fit = state.prefs.fit;
      const head = $(".reader-head");
      const uiHidden = head && head.style.display === "none";

      if (state.prefs.mode === "scroll") {
        // En modo scroll, siempre usar ancho completo
        $$("#readerScroll img").forEach((img) => {
          // Resetear estilos primero
          img.style.cssText = "";
          // Aplicar ajuste de ancho
          img.style.width = "100%";
          img.style.maxWidth = "100%";
          img.style.height = "auto";
          img.style.maxHeight = "none";
        });
      } else {
        // En modo paginado, aplicar el ajuste seleccionado
        const img = $("#pageImg");
        if (!img) return;

        // Resetear estilos primero
        img.style.cssText = "";

        const baseMaxWidth = uiHidden ? "100vw" : "calc(100vw - 16px)";

        if (fit === "width") {
          // Ajuste a ancho
          img.style.cssText = `
            width: auto !important;
            height: auto !important;
            max-width: ${baseMaxWidth} !important;
          `;
        } else if (fit === "height") {
          // Ajuste a alto, permitiendo scroll si es necesario
          img.style.cssText = `
            width: auto !important;
            height: auto !important;
            max-width: ${baseMaxWidth} !important;
          `;
        } else {
          // Tamaño original, permitiendo scroll si es necesario
          img.style.cssText = `
            width: auto !important;
            height: auto !important;
            max-width: ${baseMaxWidth} !important;
            max-height: none !important;
            object-fit: none !important;
          `;
        }
      }
    }
    function toggleReaderUI() {
      const head = $(".reader-head");
      const foot = $("#readerFoot");
      const scrollIndicator = $("#scrollPageIndicator");
      if (!head || !foot) return;
      const hide =
        head.style.display !== "none" || foot.style.display !== "none";
      head.style.display = hide ? "none" : "";
      foot.style.display = hide ? "none" : "";

      // También mostrar/ocultar el indicador de página en modo scroll
      if (scrollIndicator && state.prefs.mode === "scroll") {
        scrollIndicator.style.display = hide ? "none" : "block";
      }

      // Reajustar la imagen cuando se oculta/muestra la UI
      const img = $("#pageImg");
      if (img) {
        if (hide) {
          // Cuando se oculta la UI, permitir que la imagen ocupe todo el ancho
          img.style.maxWidth = "100vw";
        } else {
          // Cuando se muestra la UI, volver al ancho normal
          img.style.maxWidth = "calc(100vw - 16px)";
        }
      }
    }

    function onReaderScroll() {
      const body = $("#readerBody");
      if (!body) return;

      // Guardar la dirección del scroll para el lazy loading
      state.lastScrollTop = body.scrollTop;

      const idxNow = getCurrentScrollIndex();
      if (state._lastAppliedIdx !== idxNow) applyPerImageFit(idxNow);

      updateFootControls("scroll");
    }

    function renderPage() {
      const total = state.current.images.length;
      const idx = Math.max(0, Math.min(total - 1, state.current.page));
      const img = $("#pageImg");
      if (img) img.src = state.current.images[idx];

      applyPerImageFit(idx);
      prefetchAround(idx);
      updateFootControls("paged");
    }

    function prefetchAround(idx) {
      const urls = state.current.images || [];
      [idx - 1, idx + 1].forEach((i) => {
        if (i >= 0 && i < urls.length) {
          const im = new Image();
          im.src = urls[i];
        }
      });
    }

    // ---------- tapzones ----------
    on("#tapLeft", "click", () => {
      if (state.prefs.dir === "rtl") nextPage();
      else prevPage();
    });
    on("#tapRight", "click", () => {
      if (state.prefs.dir === "rtl") prevPage();
      else nextPage();
    });
    on("#tapCenter", "click", toggleReaderUI);

    function nextPage() {
      if (state.current.page < state.current.images.length - 1) {
        state.current.page++;
        renderPage();
      }
    }
    function prevPage() {
      if (state.current.page > 0) {
        state.current.page--;
        renderPage();
      }
    }

    // ---------- barra inferior (slider) ----------
    function setSliderVisualByPct(pct) {
      const s = $("#footSlider");
      if (!s) return;
      s.style.backgroundImage =
        "linear-gradient(90deg,var(--accent,#8b5cf6),var(--accent2,#22d3ee))";
      s.style.backgroundSize = pct + "% 100%";
      s.style.backgroundRepeat = "no-repeat";
      s.style.backgroundColor = "rgba(255,255,255,.10)";
    }

    function updateFootControls(source) {
      const isScroll = state.prefs.mode === "scroll";
      const total = state.current.images.length || 1;
      const idx = currentImageIndex();

      // Mostrar/ocultar controles según el modo
      const pagedControls = $("#pagedControls");
      const scrollIndicator = $("#scrollPageIndicator");

      if (pagedControls)
        pagedControls.style.display = isScroll ? "none" : "flex";

      if (!isScroll) {
        // En modo paginado, actualizar slider y controles
        const slider = $("#footSlider");
        const label = $("#footPageLabel");

        if (slider) {
          slider.max = String(total);
          if (!state.seeking || source !== "seek") {
            slider.value = String(idx + 1);
          }
        }
        if (label) label.textContent = `${idx + 1}/${total}`;

        // botones páginas
        const atFirstPage = idx <= 0;
        const atLastPage = idx >= total - 1;
        const prevBtn = $("#footPrevPage"),
          nextBtn = $("#footNextPage");
        if (prevBtn) prevBtn.disabled = atFirstPage;
        if (nextBtn) nextBtn.disabled = atLastPage;

        const pct = Math.round(((idx + 1) / Math.max(1, total)) * 100);
        setSliderVisualByPct(pct);
      }
    }

    on("#footPrevPage", "click", () =>
      state.prefs.mode === "paged"
        ? prevPage()
        : seekToIndex(currentImageIndex() - 1)
    );
    on("#footNextPage", "click", () =>
      state.prefs.mode === "paged"
        ? nextPage()
        : seekToIndex(currentImageIndex() + 1)
    );

    async function seekToIndex(i) {
      const total = state.current.images.length;
      const idx = Math.max(0, Math.min(total - 1, i));
      if (state.prefs.mode === "paged") {
        state.current.page = idx;
        renderPage();
      } else {
        state.seeking = true;
        await ensureLoadedIndex(idx);
        const cont = $("#readerScroll");
        const imgs = cont ? cont.querySelectorAll("img") : null;
        if (imgs && imgs[idx]) imgs[idx].scrollIntoView({ block: "start" });
        state.seeking = false;
        updateFootControls("seek");
      }
    }

    const sliderEl = $("#footSlider");
    if (sliderEl) {
      on(sliderEl, "pointerdown", () => {
        state.seeking = true;
      });
      on(sliderEl, "pointerup", () => {
        state.seeking = false;
      });
      on(sliderEl, "touchstart", () => {
        state.seeking = true;
      });
      on(sliderEl, "touchend", () => {
        state.seeking = false;
      });
      on(sliderEl, "mousedown", () => {
        state.seeking = true;
      });
      on(sliderEl, "mouseup", () => {
        state.seeking = false;
      });

      on(sliderEl, "input", () => {
        state.seeking = true;
        const target = (parseInt(sliderEl.value, 10) || 1) - 1;
        if (state.prefs.mode === "paged") {
          state.current.page = target;
          renderPage();
        } else {
          seekToIndex(target);
        }
        const total = state.current.images.length || 1;
        const pct = Math.round(((target + 1) / Math.max(1, total)) * 100);
        setSliderVisualByPct(pct);
        updateFootControls("seek");
      });
    }

    // ---------- ajustes (modal) ----------
    const modal = $("#settingsModal");
    if (modal) {
      modal.style.display = "none";
      modal.setAttribute("aria-hidden", "true");
      modal.classList.remove("active");
    }
    function showSettings() {
      if (!modal) return;
      modal.style.display = "flex";
      modal.classList.add("active");
      modal.setAttribute("aria-hidden", "false");
    }
    function hideSettings() {
      if (!modal) return;
      modal.style.display = "none";
      modal.classList.remove("active");
      modal.setAttribute("aria-hidden", "true");
    }
    on("#btnSettings", "click", showSettings);
    on("#btnCloseSettings", "click", hideSettings);
    on("#settingsModal", "click", (e) => {
      if (e.target && e.target.id === "settingsModal") hideSettings();
    });

    function updateSettingsUI() {
      // Actualizar botones de modo
      ["#modeScroll", "#modePaged"].forEach((sel) => {
        const btn = $(sel);
        if (btn)
          btn.classList.toggle(
            "active",
            sel ===
              "#mode" +
                state.prefs.mode.charAt(0).toUpperCase() +
                state.prefs.mode.slice(1)
          );
      });

      // Actualizar botones de dirección
      ["#dirRTL", "#dirLTR"].forEach((sel) => {
        const btn = $(sel);
        if (btn)
          btn.classList.toggle(
            "active",
            sel === "#dir" + state.prefs.dir.toUpperCase()
          );
      });

      // Actualizar botones de ajuste
      ["#fitWidth", "#fitHeight", "#fitNone"].forEach((sel) => {
        const btn = $(sel);
        if (btn)
          btn.classList.toggle(
            "active",
            sel ===
              "#fit" +
                state.prefs.fit.charAt(0).toUpperCase() +
                state.prefs.fit.slice(1)
          );
      });

      // Actualizar checkbox de modo compacto
      const compactCheck = $("#compactMode");
      if (compactCheck) compactCheck.checked = state.prefs.compact;
    }

    on("#modeScroll", "click", () => {
      setPref("mode", "scroll");
      // En modo scroll, forzar ajuste a ancho
      setPref("fit", "width");
      updateSettingsUI();
    });
    on("#modePaged", "click", () => {
      setPref("mode", "paged");
      updateSettingsUI();
    });
    on("#dirRTL", "click", () => {
      setPref("dir", "rtl");
      updateSettingsUI();
    });
    on("#dirLTR", "click", () => {
      setPref("dir", "ltr");
      updateSettingsUI();
    });
    on("#fitWidth", "click", () => {
      setPref("fit", "width");
      updateSettingsUI();
    });
    on("#fitHeight", "click", () => {
      setPref("fit", "height");
      updateSettingsUI();
    });
    on("#fitNone", "click", () => {
      setPref("fit", "none");
      updateSettingsUI();
    });

    // botón ajuste por imagen
    on("#btnFitToggle", "click", () => {
      const idx = currentImageIndex();
      const cur = getOverrideFor(idx); // 'width'|'height'|null
      const next =
        cur === "width" ? "height" : cur === "height" ? null : "width";
      setOverrideFor(idx, next);
      applyReaderFit();
      applyPerImageFit(idx);
    });

    // Recalcular ajuste al redimensionar la ventana
    window.addEventListener("resize", () => {
      if (state.current.chapter) {
        applyReaderFit();
        const idx = currentImageIndex();
        applyPerImageFit(idx);
      }
    });

    // volver
    on("#btnClose", "click", closeReader);

    // botón para invertir orden de capítulos
    on("#btnReverseOrder", "click", toggleChaptersOrder);

    // inicial
    renderHero();
    renderList();
    updateSettingsUI();
  });
})();
