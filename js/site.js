// PAB SHOP redesign: renders the pages from the live cars table (Supabase, read only).
(() => {
  const { business: B, supabase: SB } = window.PAB;
  const PHOTOS = window.PAB_PHOTOS || {};   // per photo: [crop %, pop-out strip, car depth] (tools/photos.py)
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const NF = new Intl.NumberFormat("en-US");
  const money = (n) => `$${NF.format(Math.round(n))}`;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const shortMiles = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k mi` : `${n} mi`);
  const shortTransmission = (t) => (/manual/i.test(t) ? "Manual" : /auto|cvt|dct|tiptronic/i.test(t) ? "Auto" : t);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = (name, cls = "ic") => `<svg class="${cls}" aria-hidden="true"><use href="#${name}"></use></svg>`;
  const carHref = (id) => `car.html?id=${encodeURIComponent(id)}`;
  const priceText = (c) => (c.status === "sold" ? "Sold" : c.price !== null ? money(c.price) : "Call for price");
  const smsHref = (text) => `sms:${B.phone}?&body=${encodeURIComponent(text)}`;
  const shortDate = (iso) => {
    const d = new Date(iso);
    const year = d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {};
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...year });
  };
  const fromHtml = (html) => {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };
  const samePage = (a, b) => a.replace(/index\.html$/, "") === b.replace(/index\.html$/, "");

  const root = document.documentElement;
  let page = null;          // "home" | "sold" | "car", read from #view[data-page]
  let currentCarId = null;
  let shown = "";           // path + query of the view on screen

  /* ---------- cars from the live database ----------
     The cars table of the PAB SHOP Supabase project (js/data.js), filled by the Facebook importer
     extension. Rows are read once per page load and reused by in-site links. Photos are the
     importer's uploads: per photo a /full/ file (longest side 1000px), a /card/ file (640px, framed
     the same) and a /thumb/ file (420px, cropped 3:2). Older rows may point at Cloudinary ids. */
  // A list card shows one photo, a price, a name and two facts, so the list asks for those columns
  // only. Dragging every description and every photo URL of every car along made the request 207 KB
  // with 63 cars, against about 25 KB this way, and none of it is cached (the database answers are
  // marked dynamic, unlike the photos, which are cached for a year). The car page then fetches its
  // own row in full — one small request, once per car opened. The color is there for search ("white").
  const LIST_COLUMNS = "id,title,price,mileage,year,make,model,drivetrain,transmission,exterior_color,status,pending,cover_image,photo_count,listed_at,created_at";
  // Newest first by the day the seller posted the car on Facebook (listed_at); created_at is only
  // when it was copied to the site, which for a bulk import is the same half hour for every car.
  const ORDER = "order=listed_at.desc.nullslast,created_at.desc";
  // The key goes in the address, not in headers: a request with its own headers is preceded by a
  // CORS preflight, one extra round trip before the answer, and the browser remembers a preflight
  // per address, so every car page paid it again (a tap waited two round trips for the car's row).
  // Supabase reads `apikey` from the query and treats the request as the anon role, same as the
  // headers did. Should it ever refuse that (401), the request is repeated the old way.
  const HEADERS = { apikey: SB.key, Authorization: `Bearer ${SB.key}` };
  const askFor = (query) => fetch(`${SB.url}/rest/v1/cars?${query}&apikey=${encodeURIComponent(SB.key)}`)
    .then((r) => (r.status === 401 ? fetch(`${SB.url}/rest/v1/cars?${query}`, { headers: HEADERS }) : r))
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });

  let cars = [];
  let carsRequest = null;
  function loadCars() {
    carsRequest ??= askFor(`select=${LIST_COLUMNS}&${ORDER}`)
      .then((rows) => {
        // A car page fetches its own full row at the same time; when that answer lands first it
        // must not be replaced by the list's cover-only copy (a shared car link then showed one
        // photo and "1/1" whenever the list request was the slower of the two).
        const full = new Map(cars.filter((c) => c.full).map((c) => [c.id, c]));
        cars = rows.map((r) => full.get(String(r.id)) || toCar(r));
      })
      .catch((err) => { carsRequest = null; throw err; });
    return carsRequest;
  }

  // The photos of one car, fetched when that car's page opens and kept for the rest of the visit.
  const carRequests = new Map();
  function loadCar(id) {
    if (!id) return Promise.resolve();
    if (!carRequests.has(id)) {
      carRequests.set(id, askFor(`select=*&id=eq.${encodeURIComponent(id)}`)
        .then((rows) => {
          if (!rows.length) return;
          const full = toCar(rows[0]);
          const at = cars.findIndex((c) => c.id === full.id);
          if (at < 0) cars.push(full); else cars[at] = full;
        })
        .catch((err) => {
          // An id that is not even a uuid (a mistyped link) is refused with 400: that is "no such
          // car", not a database outage, so the page shows Car not found instead of Try again.
          if (err.message === "HTTP 400") return;
          carRequests.delete(id);
          throw err;
        }));
    }
    return carRequests.get(id);
  }

  const STORAGE = `${SB.url}/storage/v1/object/public/cars/`;
  const CLOUDINARY = "https://res.cloudinary.com/dhhbcpnez/image/upload/";
  const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");
  // Three sizes per photo, uploaded by the importer: /full/ (1000px), /card/ (640px, framed like
  // full) and /thumb/ (420px, cropped 3:2). Cards and gallery offer full and card in a srcset so a
  // phone never downloads the big one.
  function photoUrls(ref) {
    if (/^https?:\/\//.test(ref)) {
      const full = ref.replace("/card/", "/full/").replace("/thumb/", "/full/");
      const sized = (dir) => (full.includes("/full/") ? full.replace("/full/", dir) : full);
      return { full, card: sized("/card/"), sm: sized("/thumb/") };
    }
    const path = ref.replace(/^\/+/, "");
    if (/\/(full|card|thumb)\//.test(path)) {
      const full = STORAGE + encodePath(path.replace("/thumb/", "/full/").replace("/card/", "/full/"));
      return { full, card: full.replace("/full/", "/card/"), sm: full.replace("/full/", "/thumb/") };
    }
    const id = encodePath(path);
    return {
      full: `${CLOUDINARY}f_auto,q_auto,w_1000/${id}`,
      card: `${CLOUDINARY}f_auto,q_auto,w_640/${id}`,
      sm: `${CLOUDINARY}f_auto,q_auto,w_420/${id}`,
    };
  }

  // Each photo is cropped where its own car sits (tools/photos.py measured it); 72% is the low crop
  // that suits most of these phone shots, used for a photo the script has not seen yet.
  const fileName = (u) => u.split("?")[0].split("/").pop();
  function framed(p) {
    const [y, pop, depth] = PHOTOS[fileName(p.full)] || [];
    return { ...p, y: Number.isFinite(y) ? y : 72, pop, depth };
  }

  const text = (v) => String(v ?? "").trim();
  const num = (v) => (v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

  // The drive. Facebook has no drivetrain field, so the column is empty on every imported car,
  // but the seller usually says it: "2015 Chevrolet Equinox AWD", "Car run and drive good, AwD".
  // The owner's own value wins, then the title, then the description. 4WD is tested first because
  // "AWD 4x4" and "4WD / AWD" both describe a Jeep's 4WD; "4D" (doors) and "test drive" match none.
  const DRIVES = [
    ["4WD", /\b(4wd|4x4|four[\s-]?wheel[\s-]?drive)\b/i],
    ["AWD", /\b(awd|all[\s-]?wheel[\s-]?drive|xdrive|quattro|4matic|4motion)\b/i],
    ["FWD", /\b(fwd|front[\s-]?wheel[\s-]?drive)\b/i],
    ["RWD", /\b(rwd|rear[\s-]?wheel[\s-]?drive)\b/i],
  ];
  const driveIn = (s) => DRIVES.find(([, re]) => re.test(s))?.[0] || "";
  const driveOf = (r) => text(r.drivetrain) || driveIn(text(r.title)) || driveIn(text(r.description));

  function toCar(r) {
    // the cover first, so the card's photo is the gallery's first photo
    const refs = [r.cover_image, ...(Array.isArray(r.images) ? r.images : [])]
      .map(text)
      .filter((ref) => ref && !/^(data|blob):/.test(ref));
    const photos = [];
    refs.forEach((ref) => {
      const p = photoUrls(ref);
      if (!photos.some((q) => q.full === p.full)) photos.push(framed(p));
    });
    const year = num(r.year);
    return {
      id: String(r.id),
      name: text(r.title || r.name) || [year, text(r.make), text(r.model)].filter(Boolean).join(" ") || "Car",
      year,
      make: text(r.make),
      model: text(r.model),
      price: num(r.price),
      mileage: num(r.mileage),
      transmission: text(r.transmission),
      drivetrain: driveOf(r),
      engine: text(r.engine),
      exterior: text(r.exterior_color),
      interior: text(r.interior_color),
      vin: text(r.vin),
      fuel: text(r.fuel),
      owners: num(r.owners),
      titleStatus: text(r.title_status),
      description: text(r.description),
      status: text(r.status),
      pending: r.pending === true,
      fbItemId: text(r.fb_item_id),
      listed: text(r.listed_at || r.created_at),
      photos,
      full: Array.isArray(r.images),   // a car's own row (every photo), not a list row (cover only)
      // List rows carry only the cover and a count; a car page's own row carries every photo.
      photoCount: Number.isFinite(Number(r.photo_count)) ? Number(r.photo_count) : photos.length,
    };
  }

  /* ---------- motion helpers ---------- */
  // Timing lives in css/site.css; JS only decides what moves.
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const scrollBehavior = () => (reduceMotion.matches ? "auto" : "smooth");
  const canMorph = () => Boolean(document.startViewTransition) && !reduceMotion.matches;
  const vtName = (el, name = "") => { if (el) el.style.viewTransitionName = name; };
  const clearVtNames = () => $$('[style*="view-transition-name"]').forEach((el) => vtName(el));

  // iOS Safari only shows :active press states when a touch listener exists.
  document.addEventListener("touchstart", () => {}, { passive: true });

  // Nothing here is meant to be dragged. Without this, holding a card, a photo or a thumbnail and
  // moving started the browser's own drag: the element stayed pressed and the taps after it were
  // swallowed (reported 2026-09-15). CSS does not cover every browser, so the drag is refused here.
  document.addEventListener("dragstart", (e) => e.preventDefault());

  // Focus rings are for keyboard users. On a phone, focus still moves (the viewer's close button
  // when it opens, back to the photo when it closes) and the browser draws the ring anyway.
  // The "keyboard" class turns rings on from the first key press until the next tap or click.
  document.addEventListener("keydown", (e) => {
    if (!e.metaKey && !e.ctrlKey && !e.altKey) root.classList.add("keyboard");
  }, true);
  document.addEventListener("pointerdown", () => root.classList.remove("keyboard"), true);

  // One view transition at a time. Starting one while another is still playing makes the browser
  // skip the first: everything jumps to its end in one frame (seen opening and closing a car
  // quickly). So the playing one is sped up and the next starts the moment it ends. `before` runs
  // right before a transition starts, which is where the elements that travel get their names;
  // all names are cleared when a transition ends. The vt-<kind> class on <html> picks CSS timing.
  const HURRY = 3;
  let active = null;
  let queue = Promise.resolve();
  const hurry = () => document.getAnimations().forEach((a) => {
    if (a.effect?.pseudoElement?.startsWith("::view-transition")) a.updatePlaybackRate(HURRY);
  });
  // Things that travel follow a curve, not a straight line (his ask, 2026-11-19): the card photo
  // and its price flying to the car page and back, and cards moving to new places in a sort. The
  // browser moves each named layer (its group) along a straight line on one spring; on top of that
  // the picture inside the group (its image pair) is pushed out sideways and back, peaking halfway,
  // on the same spring and duration. That is a quadratic Bézier through the same two ends: the x and
  // y parts of the move get different timing, and both still land together.
  // Which side it bows to: a move with a real sideways part sags downward as if thrown (Material's
  // arc rule: going up, the sideways part leads; going down, the drop leads), so a photo flying back
  // retraces its way out. A move that is (almost) straight up or down, which on a phone is nearly
  // every move because the list is one column, has no lower side: a page change bows to the right
  // both ways (back retraces it), and in a sort cards going up bow right and cards going down bow
  // left, so two cards trading places pass beside each other instead of through each other.
  // How far: `bow` of the distance, at most `max` px, so a long move does not swing off screen.
  const ARC = {
    page: { duration: "--dur-photo", curve: "--spring-zoom", bow: 0.14, max: 48 },
    list: { duration: "--dur-list", curve: "--spring-smooth", bow: 0.1, max: 48 },
  };
  const TRAVELLER = /^(car-photo|car-price|card-.+)$/;
  const arcSheet = document.head.appendChild(document.createElement("style"));
  function travellerCentres() {
    const at = new Map();
    $$('[style*="view-transition-name"], #carGrid > li').forEach((el) => {
      const name = getComputedStyle(el).viewTransitionName;
      if (!TRAVELLER.test(name)) return;
      const r = el.getBoundingClientRect();
      at.set(name, [r.left + r.width / 2, r.top + r.height / 2]);
    });
    return at;
  }
  // A CSS linear() curve (the spring tokens in css/site.css) as a function of time 0..1.
  function curveOf(css) {
    const stops = css.trim().replace(/^linear\(|\)$/g, "").split(",").map((s) => s.trim().split(/\s+/));
    const pts = stops.map(([v, at], i) => [Number(v), at ? parseFloat(at) / 100 : i ? (i === stops.length - 1 ? 1 : NaN) : 0]);
    pts.forEach((p, i) => {   // a stop without a position sits halfway between its neighbours
      if (Number.isNaN(p[1])) p[1] = (pts[i - 1][1] + (pts.slice(i + 1).find((q) => !Number.isNaN(q[1]))?.[1] ?? 1)) / 2;
    });
    return (t) => {
      let i = 1;
      while (i < pts.length - 1 && pts[i][1] < t) i++;
      const [[v0, t0], [v1, t1]] = [pts[i - 1], pts[i]];
      return t1 > t0 ? v0 + ((v1 - v0) * (t - t0)) / (t1 - t0) : v1;
    };
  }
  function bend(kind, from) {
    const { duration, curve, bow, max } = ARC[kind];
    const spring = curveOf(getComputedStyle(root).getPropertyValue(curve));
    const rules = [];
    travellerCentres().forEach(([x1, y1], name) => {
      if (!from.has(name)) return;
      const [x0, y0] = from.get(name);
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy);
      if (len < 24) return;
      let [nx, ny] = [-dy / len, dx / len];   // a unit normal to the straight path
      const sideways = Math.abs(dx) >= 0.3 * Math.abs(dy);
      if (sideways ? ny < 0 : (nx > 0) !== (kind === "page" || dy < 0)) [nx, ny] = [-nx, -ny];
      const size = Math.min(max, bow * len);
      const id = CSS.escape(name);
      const frames = [];
      for (let i = 0; i <= 40; i++) {
        const q = spring(i / 40);
        const k = 4 * q * (1 - q) * size;
        frames.push(`${i * 2.5}% { translate: ${(nx * k).toFixed(2)}px ${(ny * k).toFixed(2)}px; }`);
      }
      rules.push(`@keyframes arc-${id} { ${frames.join(" ")} }`,
        `::view-transition-image-pair(${id}) { animation: arc-${id} var(${duration}) linear both; }`);
    });
    arcSheet.textContent = rules.join("\n");
  }

  function transition(kind, update, before) {
    if (!document.startViewTransition) {
      update();
      return Promise.resolve();
    }
    const run = () => {
      before?.();
      root.classList.add(`vt-${kind}`);
      // where the travellers start; where they end is measured once the update has drawn the new state
      const from = ARC[kind] && canMorph() ? travellerCentres() : null;
      const t = document.startViewTransition(!from ? update : async () => {
        await update();
        try { bend(kind, from); } catch (err) {}   // a straight path is fine; a lost animation is not
      });
      active = t;
      t.ready.catch(() => {});
      return t.finished.catch(() => {}).then(() => {
        arcSheet.textContent = "";
        root.classList.remove(`vt-${kind}`);
        root.style.removeProperty("--vt-photo-shift");
        root.style.removeProperty("--menu-origin");
        clearVtNames();
        active = null;
      });
    };
    if (active) hurry();
    queue = queue.then(run).catch(() => { active = null; });
    return queue;
  }

  // While a view transition is on screen, Chrome hit-tests its overlay, so a tap lands on <html>
  // and would be lost (pointer-events on ::view-transition does not change that). Hurry the
  // animation and hand the tap to whatever is under the finger when it ends. A second tap on the
  // same spot right after following a link is a double tap, not a new tap, so it is dropped.
  let lastNavTap = { at: 0, x: 0, y: 0 };
  document.addEventListener("click", (e) => {
    if (!active || e.target !== root) return;
    const near = Math.hypot(e.clientX - lastNavTap.x, e.clientY - lastNavTap.y) < 40;
    if (near && performance.now() - lastNavTap.at < 350) return;
    const { clientX: x, clientY: y } = e;
    hurry();
    queue.then(() => {
      const target = document.elementFromPoint(x, y)?.closest("button, a[href], input, select, textarea");
      if (!target) return;
      if (target.matches("input, select, textarea")) target.focus();
      else target.click();
    });
  }, true);

  // Photos fade in when they arrive instead of popping. Visible by default: the class is only
  // added to images that are still loading. Photos already loaded once skip it, so a list drawn
  // again (coming back from a car) shows them at once.
  const seenPhotos = new Set();
  function fadeInImages(scope) {
    $$(".car-photo img, .car-glow", scope).forEach((img) => {
      const src = img.getAttribute("src");
      if (img.complete || seenPhotos.has(src)) return;
      img.classList.add("is-loading");
      img.addEventListener("load", () => { img.classList.remove("is-loading"); seenPhotos.add(src); }, { once: true });
      img.addEventListener("error", () => img.classList.remove("is-loading"), { once: true });
    });
  }

  const inView = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.bottom > 0 && r.top < innerHeight;
  };
  const cardPhotoFor = (id) => $$(".car-link").find((a) => a.getAttribute("href") === carHref(id) && inView(a))?.querySelector(".car-photo");

  /* ---------- in-site navigation without page loads ----------
     Chrome on iPhone resets its toolbar insets on every navigation that loads a new document
     (Chromium ios/chrome/browser/fullscreen/ui_bundled/fullscreen_web_state_observer.mm:
     DidFinishNavigation calls ResetForNavigation, skipped for same-document navigations). Until the
     next page painted, that drew the old page a toolbar-height too high (screen recordings, 2026-09-15;
     Safari and Firefox on the same phone were fine). So links between the list, sold and car pages
     swap #view in place and use history.pushState. Every page is still a real HTML file, so direct
     links, reloads and browsers where fetch fails (file://) keep working as normal navigation. */
  const PAGE_PATH = /(^|\/)(index|sold|car)\.html$|\/$/;
  const htmlCache = new Map();
  function fetchPage(path) {
    if (!htmlCache.has(path)) {
      const request = fetch(path)
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
        .catch((err) => { htmlCache.delete(path); throw err; });
      htmlCache.set(path, request);
    }
    return htmlCache.get(path);
  }
  function inSiteUrl(a) {
    if (!a || a.target || a.hasAttribute("download")) return null;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || !PAGE_PATH.test(url.pathname)) return null;
    if (url.hash && url.pathname === location.pathname && url.search === location.search) return null;
    return url;
  }

  // Start loading the next page as soon as a finger lands on the link (or a mouse rests on it):
  // its HTML and, for a car, the car's own row, which the page waits for. Fetching the row only
  // on the click left a card tap looking dead for one whole round trip after the finger lifted
  // (455ms with 400ms of latency, tools: tap-latency.mjs).
  function prefetch(a) {
    const url = inSiteUrl(a);
    if (!url) return;
    fetchPage(url.pathname).catch(() => {});
    if (url.pathname.includes("car.html")) loadCar(url.searchParams.get("id")).catch(() => {});
  }
  document.addEventListener("pointerdown", (e) => prefetch(e.target.closest?.("a[href]")), { capture: true, passive: true });
  let hovered = null;
  let hoverTimer = 0;
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse") return;
    const a = e.target.closest?.("a[href]") || null;
    if (a === hovered) return;
    hovered = a;
    clearTimeout(hoverTimer);
    if (a) hoverTimer = setTimeout(() => prefetch(a), 65);   // a pointer only passing over does not count
  }, { passive: true });

  // While the next page loads, a tap must not look dead: the tapped link stays pressed instead of
  // springing back, and after 100ms a gold line grows along the top of the screen, the way a
  // browser shows a page loading (it shows nothing here: in-site links do not load documents).
  let pendingLink = null;
  let pendingTimer = 0;
  function startPending(link) {
    endPending();
    pendingLink = link;
    link?.classList.add("is-opening");
    pendingTimer = setTimeout(() => root.classList.add("nav-pending"), 100);
  }
  function endPending() {
    clearTimeout(pendingTimer);
    root.classList.remove("nav-pending");
    pendingLink?.classList.remove("is-opening");
    pendingLink = null;
  }

  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest("a[href]");
    const url = inSiteUrl(a);
    if (!url) return;
    e.preventDefault();
    lastNavTap = { at: performance.now(), x: e.clientX, y: e.clientY };
    navigate(url, true, a);
  });

  history.scrollRestoration = "manual";
  addEventListener("popstate", () => {
    if (location.pathname + location.search === shown) return;   // a #hash change, not a page change
    navigate(new URL(location.href), false);
  });

  let navToken = 0;
  async function navigate(url, push, link = null) {
    const token = ++navToken;
    startPending(link);
    let html;
    try {
      // A car page needs its own row (the photos) before the transition starts, like the HTML does.
      const wanted = url.pathname.includes("car.html") ? url.searchParams.get("id") : null;
      [html] = await Promise.all([fetchPage(url.pathname), loadCars(), loadCar(wanted)]);
    } catch (err) {
      location.assign(url.href);
      return;
    }
    if (token !== navToken) return;
    const next = new DOMParser().parseFromString(html, "text/html");
    const nextView = next.getElementById("view");
    if (!nextView) { location.assign(url.href); return; }
    const nextCarId = nextView.dataset.page === "car" ? url.searchParams.get("id") : null;

    const restoreY = push ? 0 : (history.state?.scrollY ?? 0);
    // The photo that travels: the tapped card's (into a car page) or the gallery's (out of one).
    // The price or Sold tag travels too, between the card's tag and the car page's sticker, as its
    // own layer above the photo: a tag that only faded in or out let the photo show through it.
    let travelling = null;
    const nameCard = (photoEl) => {
      vtName(photoEl, "car-photo");
      vtName(photoEl?.closest(".car-link")?.querySelector(".price-tag"), "car-price");
    };

    transition("page", () => {
      // the old picture (still pressed, line still running) has been taken; it fades with the old page
      endPending();
      clearVtNames();
      cleanupView();
      if (push) {
        history.replaceState({ ...history.state, scrollY }, "");
        history.pushState({ scrollY: 0, from: location.pathname }, "", url.href);
      }
      $("#view").replaceWith(document.importNode(nextView, true));
      document.title = next.title;
      init();
      scrollTo(0, restoreY);
      if (travelling && page === "car" && travelling === currentCarId) {
        vtName($(".gallery-frame"), "car-photo");
        const tag = $("#priceTag");
        vtName(tag, "car-price");
        tag.classList.add("travelled");   // it flies in with the photo instead of slapping on
      } else if (travelling && page !== "car") {
        const to = cardPhotoFor(travelling);
        nameCard(to);
        to?.querySelector("img.is-loading")?.classList.remove("is-loading");
      }
      if (push) $("#view").focus({ preventScroll: true });
    }, () => {
      if (!canMorph()) return;
      if (nextCarId && nextCarId !== currentCarId) {
        const from = cardPhotoFor(nextCarId);
        if (from) {
          nameCard(from);
          travelling = nextCarId;
        }
      } else if (page === "car" && inView($(".gallery-frame"))) {
        // the whole frame, so the photo counter (and desktop arrows) travel with the photo
        vtName($(".gallery-frame"), "car-photo");
        if (inView($("#priceTag"))) vtName($("#priceTag"), "car-price");
        travelling = currentCarId;
      }
    });
  }

  // Things a view sets up outside its own elements, undone when it is swapped out.
  const cleanups = [];
  const cleanupView = () => cleanups.splice(0).forEach((fn) => fn());

  /* ---------- theme ---------- */
  function syncThemeControls() {
    const theme = root.dataset.theme;
    $$("[data-toggle-theme]").forEach((b) => {
      b.setAttribute("aria-label", theme === "black" ? "Switch to light theme" : "Switch to black theme");
      b.innerHTML = icon(theme === "black" ? "sun" : "moon");
    });
    // the browser chrome (address bar on phones) follows the page
    $('meta[name="theme-color"]')?.setAttribute("content", theme === "black" ? "#000000" : "#ffffff");
  }
  function setTheme(theme) {
    if (theme === root.dataset.theme) return;
    try { localStorage.setItem("pab-theme2", theme); } catch (e) {}
    transition("theme", () => {
      root.dataset.theme = theme;
      syncThemeControls();
    });
  }
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-toggle-theme]")) setTheme(root.dataset.theme === "black" ? "plate" : "black");
  });

  /* ---------- shared bits ---------- */
  function fillContacts(message) {
    $$("[data-tel]").forEach((a) => { a.href = `tel:${B.phone}`; });
    $$("[data-tel2]").forEach((a) => { a.href = `tel:${B.phone2}`; });
    $$("[data-sms]").forEach((a) => { a.href = smsHref(message); });
    $$("[data-email]").forEach((a) => { a.href = `mailto:${B.email}`; });
    $$("[data-phone-label]").forEach((el) => { el.textContent = B.phoneLabel; });
    $$("[data-phone2-label]").forEach((el) => { el.textContent = B.phone2Label; });
    $$("[data-email-label]").forEach((el) => { el.textContent = B.email; });
    $$("[data-year]").forEach((el) => { el.textContent = new Date().getFullYear(); });
  }

  // "2016 Buick encore" -> "Encore": the model column when filled, else the word after year and make.
  const modelOf = (c) => {
    const model = c.model || c.name.match(/^(?:19|20)\d\d\s+\S+\s+(\S+)/)?.[1] || "";
    return model.charAt(0).toUpperCase() + model.slice(1);
  };

  /* ---------- search ----------
     People type what they remember, in any order and spelling: "escape ford", "2013 escape",
     "chevy", "Equnox", "65k". Each word is matched on its own and every word must match. A word
     matches the start of any word about the car (so results hold up while typing), a nickname
     finds its make, and "65k" or "7.5k" find the mileage or price as the card shows them. A typo
     is forgiven only when the word, spelled as typed, finds no car at all (so "trax" does not also
     find the Traverse), only in names, never in numbers (2012 is not 2013): one wrong letter from 4
     letters on, two from 8 — the limits Algolia uses. */
  const NICKNAMES = {
    chevrolet: ["chevy"], volkswagen: ["vw"], "mercedes-benz": ["mercedes", "benz", "merc"],
    cadillac: ["caddy"], bmw: ["bimmer", "beemer"], subaru: ["subie"], mitsubishi: ["mitsu"],
    jaguar: ["jag"], "land rover": ["landrover"], toyota: ["yota"], oldsmobile: ["olds"],
  };
  const SKIP_WORDS = new Set(["a", "an", "and", "the", "with", "for", "mi", "mile", "miles", "car", "cars"]);
  // lower case, "65,300" -> "65300", "$7,500" -> "7500", split on anything but letters, digits and decimal points
  const words = (s) => String(s ?? "").toLowerCase().replace(/(\d),(?=\d{3})/g, "$1").replace(/[’']/g, "")
    .split(/[^a-z0-9.]+/).map((w) => w.replace(/^\.+|\.+$/g, "")).filter(Boolean);
  const kilo = (n) => [`${Math.round(n / 1000)}k`, `${Math.floor(n / 1000)}k`, `${Math.round(n / 100) / 10}k`];

  // Words about one car: [names (typos forgiven), other words (start of word only)].
  function searchWords(c) {
    const names = new Set();
    const other = new Set();
    const add = (set, value) => {
      const w = words(value);
      w.forEach((x) => set.add(x));
      // "F-150" is also "f150", "CR-V" "crv", "Grand Vitara" "grandvitara"
      w.slice(1).forEach((x, i) => set.add(w[i] + x));
    };
    [c.name, c.make, c.model, c.exterior].forEach((v) => add(names, v));
    Object.entries(NICKNAMES).forEach(([make, nick]) => {
      if (c.make.toLowerCase() === make || c.name.toLowerCase().includes(make)) nick.forEach((n) => names.add(n));
    });
    [c.drivetrain, c.transmission, shortTransmission(c.transmission), c.engine].forEach((v) => add(other, v));
    if (/4wd/i.test(c.drivetrain)) other.add("4x4");
    if (c.year) { other.add(String(c.year)); other.add(String(c.year).slice(2)); }
    if (c.mileage !== null) { other.add(String(c.mileage)); kilo(c.mileage).forEach((k) => other.add(k)); }
    if (c.price !== null) { other.add(String(Math.round(c.price))); kilo(c.price).forEach((k) => other.add(k)); }
    return [[...names], [...names, ...other]];
  }

  // Edit distance with swapped neighbours counting as one edit; stops early past `max`.
  function typos(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev2 = null;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      let best = i;
      for (let j = 1; j <= b.length; j++) {
        let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (prev2 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
        row.push(d);
        best = Math.min(best, d);
      }
      if (best > max) return max + 1;
      prev2 = prev;
      prev = row;
    }
    return prev[b.length];
  }
  const startsWord = (q, list) => list.some((w) => w.startsWith(q));
  function nearlyNames(q, names) {
    if (q.length < 4 || /\d/.test(q)) return false;
    const max = q.length >= 8 ? 2 : 1;
    // the whole word, or the start of a longer one ("equno" while typing "equinox": a letter may be
    // missing or extra, so the start is taken a little shorter and longer too)
    return names.some((w) => typos(q, w, max) <= max
      || [-1, 0, 1].some((d) => w.length > q.length + d && typos(q, w.slice(0, q.length + d), max) <= max));
  }
  // The cars (with their words, from searchWords) that match every word of the query. A round
  // number ("65000", "65,000") also matches what the card says ("65k").
  const asTyped = (q, list) => startsWord(q, list) || (/^\d+000$/.test(q) && list.includes(`${q.slice(0, -3)}k`));
  function search(entries, query) {
    const terms = words(query).filter((w) => !SKIP_WORDS.has(w));
    if (!terms.length) return entries.map((e) => e.car);
    const exact = new Set(terms.filter((q) => entries.some((e) => asTyped(q, e.all))));
    return entries
      .filter((e) => terms.every((q) => asTyped(q, e.all) || (!exact.has(q) && nearlyNames(q, e.names))))
      .map((e) => e.car);
  }

  const factRows = (list) => list
    .filter(([, , value]) => value !== null && value !== "")
    .map(([ic, label, value]) => `<div><dt>${icon(ic)}<span>${label}</span></dt><dd>${esc(value)}</dd></div>`)
    .join("");

  function card(c, { sizes = "(min-width: 1180px) 370px, (min-width: 720px) 45vw, 100vw" } = {}) {
    const sold = c.status === "sold";
    const [cover] = c.photos;
    // Always the full photo: the thumbnail is already a centred 3:2 crop, so it has lost the
    // bottom of the car that the low card crop keeps, and it would not line up with the gallery.
    const photoHtml = cover
      ? `<img src="${esc(cover.card)}" srcset="${esc(cover.card)} 640w, ${esc(cover.full)} 1000w" sizes="${sizes}"
               width="1000" height="667" style="--photo-y: ${cover.y}%"
               loading="${seenPhotos.has(cover.card) ? "eager" : "lazy"}" decoding="async" draggable="false" alt="${esc(c.name)}">`
      : icon("car", "ic no-photo");
    // A car for sale lights the black page under it with its own photo, blurred (css: .car-glow).
    // The same src, srcset and sizes as the photo, so the browser picks the same file: no second
    // download. Sold cars stay unlit, like their greyed photos.
    const glow = cover && !sold
      ? `<img class="car-glow" src="${esc(cover.card)}" srcset="${esc(cover.card)} 640w, ${esc(cover.full)} 1000w" sizes="${sizes}"
               style="--photo-y: ${cover.y}%" loading="${seenPhotos.has(cover.card) ? "eager" : "lazy"}" decoding="async" draggable="false" alt="" aria-hidden="true">`
      : "";
    const pop = cover && cover.pop;
    const count = c.photoCount > 1
      ? `<span class="photo-count" aria-label="${c.photoCount} photos">${icon("images")}${c.photoCount}</span>`
      : "";
    // A deposit taken on Facebook ("pending") is worth knowing before anyone calls.
    const pending = !sold && c.pending ? `<span class="pending-pill">${icon("clock")}Sale pending</span>` : "";
    // Second fact: the drive (AWD/FWD) when the owner typed one, otherwise the transmission,
    // which Facebook always has. Manual cars are the ones people ask about.
    const facts = [
      c.mileage !== null && `${icon("gauge")}${shortMiles(c.mileage)}`,
      c.drivetrain ? `${icon("disc-3")}${esc(c.drivetrain)}`
        : c.transmission && `${icon("cog")}${esc(shortTransmission(c.transmission))}`,
    ].filter(Boolean);
    return `
      <li class="car-card${sold ? " is-sold" : ""}${pop ? " has-pop" : ""}" style="--vt: card-${esc(c.id)}${pop ? `; --pop-h: ${Number(cover.depth) || 0}` : ""}">
        <a class="car-link" href="${carHref(c.id)}" draggable="false">
          ${glow}<div class="car-photo">${photoHtml}${count}${pending}</div>
          ${pop ? `<img class="car-pop" src="${esc(pop)}" alt="" loading="lazy" decoding="async" draggable="false">` : ""}
          <p class="price-tag${sold ? " is-sold" : ""}">${priceText(c)}</p>
          <h3 class="car-title">${esc(c.name)}</h3>
          ${facts.length ? `<ul class="car-facts">${facts.map((f) => `<li>${f}</li>`).join("")}</ul>` : ""}
        </a>
      </li>`;
  }

  function renderCards(el, list, opts) {
    el.innerHTML = list.map((c) => card(c, opts)).join("");
    fadeInImages(el);
  }

  /* ---------- homepage ---------- */
  function initHome() {
    // rows arrive newest listing first, the order the live site uses
    const available = cars.filter((c) => c.status === "available");
    const sold = cars.filter((c) => c.status === "sold");
    const grid = $("#carGrid");
    const q = $("#q");
    const count = $("#resultCount");
    const empty = $("#empty");
    const sortButton = $("#sortButton");
    const sortMenu = $("#sortMenu");
    const sortOptions = $$("[data-sort]", sortMenu);
    const last = (v, dir = 1) => (v === null ? Infinity : v * dir);   // cars without the number go last
    const sorters = {
      newest: (a, b) => b.listed.localeCompare(a.listed),
      "price-asc": (a, b) => last(a.price) - last(b.price) || 0,
      "price-desc": (a, b) => last(a.price, -1) - last(b.price, -1) || 0,
      miles: (a, b) => last(a.mileage) - last(b.mileage) || 0,
      year: (a, b) => (b.year ?? 0) - (a.year ?? 0) || last(a.mileage) - last(b.mileage) || 0,
    };

    // One element per car, reused on every render: loaded photos stay loaded and the
    // reorder transition moves the same boxes instead of fading in new ones.
    const nodes = new Map(available.map((c) => [c.id, fromHtml(card(c))]));
    nodes.forEach((li) => fadeInImages(li));

    // Search and sort live in the address, so a shared or reloaded link shows the same list.
    const params = new URLSearchParams(location.search);
    let sort = sorters[params.get("sort")] ? params.get("sort") : "newest";
    q.value = params.get("q") || "";
    $("#homeTitle").textContent = `${plural(available.length, "car")} for sale`;
    // The search hint names models that are actually for sale ("Encore, Legacy…").
    const models = [...new Set(available.map(modelOf).filter((m) => /[a-z]/i.test(m)))].slice(0, 3);
    if (models.length) q.placeholder = `${models.join(", ")}…`;

    function syncUrl() {
      const p = new URLSearchParams(location.search);
      const put = (key, value, fallback) => (value && value !== fallback ? p.set(key, value) : p.delete(key));
      put("q", q.value.trim(), "");
      put("sort", sort, "newest");
      p.delete("show");   // the old quick filters are gone
      const qs = p.toString();
      history.replaceState(history.state, "", qs ? `?${qs}` : location.pathname);
      shown = location.pathname + location.search;
    }

    // The button shows the chosen order's icon and name; the menu ticks it.
    function syncSortControl() {
      const current = sortOptions.find((o) => o.dataset.sort === sort);
      sortOptions.forEach((o) => o.setAttribute("aria-selected", String(o === current)));
      $("#sortLabel").textContent = current.querySelector("span").textContent;
      sortButton.querySelector("use").setAttribute("href", current.querySelector("use").getAttribute("href"));
    }

    const entries = available.map((car) => {
      const [names, all] = searchWords(car);
      return { car, names, all };
    });

    function render() {
      const term = q.value.trim();
      const list = search(entries, term).sort(sorters[sort]);
      grid.replaceChildren(...list.map((c) => nodes.get(c.id)));
      count.textContent = term ? `${list.length} of ${available.length}` : plural(available.length, "car");
      empty.hidden = list.length > 0;
      $("h2", empty).textContent = available.length ? "No cars match" : "Nothing for sale right now";
      $("#clearSearch").hidden = !available.length;
      syncSortControl();
      syncUrl();
    }

    // Sort menu: a popover list so each order can show an icon (a native select can't, on phones).
    // It opens under the button with right edges lined up, or above it when there is no room below.
    const menuOpen = () => sortMenu.matches(":popover-open");
    sortMenu.addEventListener("beforetoggle", (e) => {
      if (e.newState !== "open") return;
      const r = sortButton.getBoundingClientRect();
      const height = sortOptions.length * 48 + 14;   // rows are 48px, plus padding and border
      const above = r.bottom + 8 + height > innerHeight && r.top - 8 - height > 0;
      sortMenu.classList.toggle("above", above);
      sortMenu.style.right = `${document.documentElement.clientWidth - r.right}px`;
      sortMenu.style.top = `${above ? r.top - 8 - height : r.bottom + 8}px`;
    });
    sortMenu.addEventListener("toggle", (e) => {
      const open = e.newState === "open";
      sortButton.setAttribute("aria-expanded", String(open));
      if (open) sortOptions.find((o) => o.getAttribute("aria-selected") === "true")?.focus({ preventScroll: true });
    });
    sortMenu.addEventListener("keydown", (e) => {
      const i = sortOptions.indexOf(document.activeElement);
      const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
      if (step) {
        e.preventDefault();
        sortOptions[(i + step + sortOptions.length) % sortOptions.length].focus();
      }
      if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        (e.key === "Home" ? sortOptions[0] : sortOptions.at(-1)).focus();
      }
      if (e.key === "Tab") sortMenu.hidePopover();
    });
    // Closing the menu as part of a sort: it leaves the top layer at once, inside the transition's
    // update, and its picture shrinks and fades on its own layer (css: view-transition-old(sort-menu)).
    // Left to its own 150ms closing, the popover dropped out of the top layer while the cards were
    // moving, and Chrome ended the whole transition right there: every sort chosen from the menu
    // jumped to its end after 167ms instead of sliding for 750ms (measured 2026-11-19).
    const closeMenuNow = () => {
      if (document.startViewTransition) sortMenu.classList.add("instant");   // no view transitions: its own close
      sortMenu.hidePopover();
    };
    sortMenu.addEventListener("beforetoggle", (e) => { if (e.newState === "open") sortMenu.classList.remove("instant"); });
    sortOptions.forEach((o) => o.addEventListener("click", () => {
      sortButton.focus({ preventScroll: true });
      if (o.dataset.sort === sort) { sortMenu.hidePopover(); return; }
      sort = o.dataset.sort;
      // the closing menu gets its own layer, so the cards sliding underneath don't cover it
      transition("list", () => { closeMenuNow(); render(); }, () => {
        vtName(sortMenu, "sort-menu");
        root.style.setProperty("--menu-origin", sortMenu.classList.contains("above") ? "bottom right" : "top right");
      });
    }));
    // A fixed menu would drift away from its button when the page scrolls, so scrolling closes it.
    const closeOnScroll = () => { if (menuOpen()) sortMenu.hidePopover(); };
    addEventListener("scroll", closeOnScroll, { passive: true });
    cleanups.push(() => removeEventListener("scroll", closeOnScroll));

    // Sorting reorders with a short move; typing in search updates instantly.
    q.addEventListener("input", render);
    $("#clearSearch").addEventListener("click", () => { q.value = ""; render(); q.focus(); });
    render();

    $("#soldStrip").hidden = !sold.length;
    renderCards($("#soldRow"), sold.slice(0, 6), { sizes: "260px" });
    fillContacts("Yo, what cars do you have right now?");
  }

  /* ---------- sold page ---------- */
  function initSold() {
    const sold = cars.filter((c) => c.status === "sold");
    $("#soldCount").textContent = sold.length;
    renderCards($("#soldGrid"), sold);
    fillContacts("Yo, got anything like these?");
  }

  /* ---------- photo slider (native scroll + snap points) ---------- */
  function createSlider(track, onChange) {
    const s = { index: -1, count: track.children.length, target: null };
    const width = () => track.clientWidth || 1;

    function set(i) {
      if (i === s.index) return;
      s.index = i;
      [i - 1, i + 1].forEach((n) => {
        const img = track.children[n]?.querySelector("img");
        if (img && img.loading !== "eager") img.loading = "eager";
      });
      onChange(i);
    }

    s.goTo = (i, smooth = true) => {
      if (!s.count || !track.clientWidth) return;   // hidden (a closed viewer): nothing to scroll
      const wraps = i < 0 || i >= s.count;
      const back = i < 0;
      i = ((i % s.count) + s.count) % s.count;
      const move = () => {
        const left = i * width();
        s.target = Math.abs(track.scrollLeft - left) > 2 ? i : null;
        track.scrollTo({ left, behavior: smooth && !wraps ? scrollBehavior() : "auto" });
        set(i);
      };
      // Going past the last photo (or before the first) cannot scroll there: every photo in between
      // would fly past. So the two photos slide over each other the way the arrow points instead of
      // swapping in one frame.
      if (!wraps || !smooth || !canMorph()) return move();
      const slidePhoto = (n) => track.children[n]?.querySelector("img");
      transition(back ? "wrap-back" : "wrap", () => {
        vtName(slidePhoto(s.index));
        move();
        vtName(slidePhoto(i), "wrap-photo");
      }, () => vtName(slidePhoto(s.index), "wrap-photo"));
    };
    s.reset = () => { s.index = -1; };

    let frame = 0;
    track.addEventListener("scroll", () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const w = track.clientWidth;
        // A hidden track (the viewer once it closes) reports no width, and browsers reset its scroll
        // position: that is not the visitor choosing photo 1, so it must not move the index.
        if (!w) return;
        if (s.target !== null) {
          if (Math.abs(track.scrollLeft - s.target * w) > 2) return;
          s.target = null;
        }
        set(Math.min(s.count - 1, Math.max(0, Math.round(track.scrollLeft / w))));
      });
    }, { passive: true });

    ["touchstart", "wheel", "keydown"].forEach((type) => track.addEventListener(type, () => { s.target = null; }, { passive: true }));

    let lastWidth = track.clientWidth;
    const resize = new ResizeObserver(() => {
      const w = track.clientWidth;
      if (!w || w === lastWidth) return;
      lastWidth = w;
      s.target = null;
      track.scrollTo({ left: Math.max(0, s.index) * w, behavior: "auto" });
    });
    resize.observe(track);
    cleanups.push(() => resize.disconnect());

    set(0);
    return s;
  }

  /* ---------- car page ---------- */
  function initCar() {
    const c = cars.find((x) => x.id === currentCarId);
    if (!c) {
      $("#carMain").hidden = true;
      $("#notFound").hidden = false;
      document.title = "Car not found - PAB SHOP";
      fillContacts("Yo, what cars do you have right now?");
      return;
    }

    const sold = c.status === "sold";
    const name = c.name;
    document.title = `${name} - PAB SHOP`;

    // Back goes back in history when the list is the entry right before this one,
    // so the list comes back with its scroll position and search.
    const back = $("#backLink");
    back.href = sold ? "sold.html" : "index.html";
    $("#backText").textContent = sold ? "Sold cars" : "All cars";
    back.addEventListener("click", (e) => {
      const from = history.state?.from;
      if (from && samePage(from, new URL(back.href).pathname)) {
        e.preventDefault();
        history.back();
      }
    });
    $(sold ? '[data-nav="sold"]' : '[data-nav="sale"]')?.setAttribute("aria-current", "page");

    const tag = $("#priceTag");
    tag.textContent = priceText(c);
    tag.classList.toggle("is-sold", sold);
    $("#carName").textContent = name;
    $("#pendingNote").hidden = sold || !c.pending;

    // Only what the listing has: a fact without a value is left out.
    const keyFacts = factRows([
      ["calendar", "Year", c.year],
      ["gauge", "Miles", c.mileage === null ? null : NF.format(c.mileage)],
      ["cog", "Transmission", shortTransmission(c.transmission)],
      ["disc-3", "Drive", c.drivetrain],
    ]);
    $("#keyFacts").innerHTML = keyFacts;
    $("#keyFacts").hidden = !keyFacts;

    $("#about").textContent = c.description;
    $("#aboutSection").hidden = !c.description;

    const specs = factRows([
      ["cog", "Engine", c.engine],
      // only when it says more than the Auto/Manual tile above ("6-speed automatic", not "Automatic")
      ["cog", "Transmission", /^(auto|automatic|manual)$/i.test(c.transmission) ? "" : c.transmission],
      ["fuel", "Fuel", c.fuel],
      ["palette", "Color", c.exterior],
      ["armchair", "Interior", c.interior],
      ["users", "Owners", c.owners],
      ["file-check", "Title", c.titleStatus],
      ["hash", "VIN", c.vin],
      ["calendar", "Listed", c.listed && shortDate(c.listed)],
    ]);
    $("#specList").innerHTML = specs;
    $("#detailsSection").hidden = !specs;

    fillContacts(sold
      ? `Yo, got anything like the ${name}?`
      : `Yo, is the ${name} still available?`);

    // The same car on Facebook Marketplace, for cars still for sale: the importer stores the
    // listing id. A sold car's listing is usually deleted, so no link there.
    const fbLink = $("#fbLink");
    fbLink.hidden = sold || !c.fbItemId;
    if (c.fbItemId) fbLink.href = `https://www.facebook.com/marketplace/item/${encodeURIComponent(c.fbItemId)}/`;

    const more = cars.filter((x) => x.status === "available" && x.id !== c.id).slice(0, 3);
    renderCards($("#moreGrid"), more);
    $("#moreSection").hidden = !more.length;

    // Gallery
    const shots = c.photos;
    const track = $("#slides");
    const thumbs = $("#thumbs");
    const count = $("#galCount");
    const several = shots.length > 1;
    [thumbs, count, $("#galPrev"), $("#galNext"), $("#viewerPrev"), $("#viewerNext")].forEach((el) => { el.hidden = !several; });
    if (!shots.length) {
      track.innerHTML = `<div class="slide no-photo">${icon("car")}</div>`;
      return;
    }

    // Gallery and viewer load the full photo: the thumbnail is a 3:2 crop, not a smaller copy.
    const slidesHtml = () => shots.map((p, i) => `
      <div class="slide">
        <img src="${esc(p.full)}" srcset="${esc(p.card)} 640w, ${esc(p.full)} 1000w" sizes="(min-width: 960px) 62vw, 100vw"
             width="1000" height="667" style="--photo-y: ${p.y}%"
             alt="${esc(name)}, photo ${i + 1} of ${shots.length}" loading="${i < 2 ? "eager" : "lazy"}" decoding="async" draggable="false">
      </div>`).join("");

    track.innerHTML = slidesHtml();
    thumbs.innerHTML = shots.map((p, i) => `
      <li><button type="button" data-i="${i}" aria-label="Show photo ${i + 1}">
        <img src="${esc(p.sm)}" alt="" width="420" height="280" loading="lazy" decoding="async">
      </button></li>`).join("");

    const main = createSlider(track, (i) => {
      count.innerHTML = `${icon("images")}<span>${i + 1}/${shots.length}</span>`;
      $$("button", thumbs).forEach((b, k) => {
        if (k === i) {
          b.setAttribute("aria-current", "true");
          thumbs.scrollTo({ left: b.offsetLeft - (thumbs.clientWidth - b.clientWidth) / 2, behavior: scrollBehavior() });
        } else {
          b.removeAttribute("aria-current");
        }
      });
    });
    thumbs.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-i]");
      if (b) main.goTo(Number(b.dataset.i));
    });
    $("#galPrev").addEventListener("click", () => main.goTo(main.index - 1));
    $("#galNext").addEventListener("click", () => main.goTo(main.index + 1));

    // Fullscreen viewer: the tapped photo grows into it and shrinks back on close.
    const viewer = $("#viewer");
    const vtrack = $("#viewerSlides");
    const vcount = $("#viewerCount");
    vtrack.innerHTML = slidesHtml();
    // The viewer fits each photo to the screen from its own shape (--ar in css/site.css), known
    // once the photo has loaded; before that the gallery's copy of the same photo may know it.
    const keepShape = (img) => {
      if (!img?.naturalWidth) return;
      img.style.setProperty("--ar", (img.naturalWidth / img.naturalHeight).toFixed(4));
    };
    $$("img", vtrack).forEach((img) => {
      keepShape(img);
      img.addEventListener("load", () => keepShape(img), { once: true });
    });
    // Which photo the viewer is showing. Kept here because a closed dialog is display: none, and a
    // hidden scroller's position is reset to the start: reading it back after closing gave photo 1.
    let shownInViewer = 0;
    const full = createSlider(vtrack, (i) => {
      shownInViewer = i;
      vcount.textContent = several ? `${i + 1}/${shots.length}` : "";
    });
    const galleryImg = (i) => track.children[i]?.querySelector("img");
    const viewerImg = (i) => vtrack.children[i]?.querySelector("img");
    const ready = (img) => {
      if (!img) return null;
      img.loading = "eager";
      return img.decode().catch(() => {}).then(() => keepShape(img));
    };

    // What travels on the gallery side is the whole frame, so the photo counter (and desktop arrows)
    // move with the photo. The viewer's close button, counter and arrows get their own layers so
    // they stay above the growing or shrinking photo instead of popping on top when it ends.
    const frame = $(".gallery-frame");
    const nameViewerControls = (on) => {
      vtName($(".viewer-bar", viewer), on ? "viewer-bar" : "");
      vtName($("#viewerPrev"), on ? "viewer-prev" : "");
      vtName($("#viewerNext"), on ? "viewer-next" : "");
    };

    // The viewer shows the whole photo; the gallery shows a crop of it. Without help the full photo
    // simply appears at its final size (both are the width of the screen on a phone, so nothing
    // scales) and reads as a pop. So the full photo starts shifted to sit exactly where the gallery's
    // crop is, and slides back as the box grows: the picture opens out of the crop.
    function alignPhoto(i) {
      const img = galleryImg(i);
      const box = frame.getBoundingClientRect();
      const shape = img?.naturalWidth ? img.naturalHeight / img.naturalWidth : 0;
      const visible = shape ? Math.min(1, box.height / box.width / shape) : 1;   // share of the photo the crop shows
      const y = (parseFloat(getComputedStyle(img).objectPosition.split(" ")[1]) || 50) / 100;
      root.style.setProperty("--vt-photo-shift", `${(-y * (1 - visible) * 100).toFixed(2)}%`);
    }

    function openViewer() {
      let i = 0;
      let morph = false;
      transition("viewer-open", async () => {
        vtName(frame);
        viewer.showModal();
        full.reset();
        full.goTo(i, false);
        if (morph) {
          vtName(viewerImg(i), "viewer-photo");
          nameViewerControls(true);
          await ready(viewerImg(i));
        }
      }, () => {
        i = main.index;
        morph = canMorph();
        // the gallery already shows this photo, so its shape is known before the viewer's copy loads
        const shown = galleryImg(i);
        if (shown?.naturalWidth && viewerImg(i)) viewerImg(i).style.setProperty("--ar", (shown.naturalWidth / shown.naturalHeight).toFixed(4));
        if (morph) {
          vtName(frame, "viewer-photo");
          alignPhoto(i);
        }
      });
    }

    function closeViewer() {
      if (!viewer.open) return;
      let i = 0;
      let morph = false;
      transition("viewer-close", async () => {
        vtName(viewerImg(i));
        nameViewerControls(false);
        resetDrag();   // after the old picture was taken, so a dragged photo flies home from where it was let go
        viewer.close();
        main.goTo(i, false);
        if (morph) {
          vtName(frame, "viewer-photo");
          await ready(galleryImg(i));
        }
      }, () => {
        i = shownInViewer;
        morph = canMorph();
        if (morph) {
          vtName(viewerImg(i), "viewer-photo");
          nameViewerControls(true);
          alignPhoto(i);
        }
      });
    }

    let downX = 0;
    let moved = false;
    track.addEventListener("pointerdown", (e) => { downX = e.clientX; moved = false; }, { passive: true });
    track.addEventListener("pointermove", (e) => { if (Math.abs(e.clientX - downX) > 8) moved = true; }, { passive: true });
    track.addEventListener("click", () => { if (!moved) openViewer(); });
    // Swipe down to close, as in Photos: the photo follows the finger both ways and shrinks a little
    // as it goes down, the black thins out to the car page underneath, and the controls fade. Let go
    // past 96px down, or flick down, and the viewer closes from wherever the photo is (closeViewer
    // flies it home from there); anything else springs it back. Sideways stays the photo strip's own
    // swipe: the track allows only horizontal panning (css), so a vertical drag reaches this code.
    let drag = null;
    let draggedAt = -1e9;   // a drag that ends over the black must not also count as a tap there
    const dragImg = () => viewerImg(shownInViewer);
    function resetDrag() {
      drag = null;
      viewer.classList.remove("dragging", "settling");
      viewer.style.removeProperty("--viewer-dim");
      $$("img", vtrack).forEach((img) => { img.style.removeProperty("translate"); img.style.removeProperty("scale"); });
    }
    function placeDrag(dx, dy) {
      const down = Math.max(0, dy);
      // upward the photo moves a quarter as far, like a rubber band
      const y = dy < 0 ? dy / 4 : dy;
      const lift = Math.min(1, down / (innerHeight * 0.45));
      dragImg().style.translate = `${dx.toFixed(1)}px ${y.toFixed(1)}px`;
      dragImg().style.scale = (1 - 0.28 * lift).toFixed(4);
      viewer.style.setProperty("--viewer-dim", (1 - lift).toFixed(3));
    }
    vtrack.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" || !e.isPrimary || active) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, on: false, trail: [[e.timeStamp, e.clientY]] };
    }, { passive: true });
    vtrack.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.on) {
        if (Math.hypot(dx, dy) < 10) return;
        if (Math.abs(dy) <= Math.abs(dx)) { drag = null; return; }   // sideways: the next photo
        drag.on = true;
        viewer.classList.remove("settling");
        viewer.classList.add("dragging");
        try { vtrack.setPointerCapture(e.pointerId); } catch (err) {}
      }
      drag.trail.push([e.timeStamp, e.clientY]);
      while (drag.trail.length > 2 && drag.trail[0][0] < e.timeStamp - 100) drag.trail.shift();
      placeDrag(dx, dy);
    }, { passive: true });
    const letGo = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const was = drag;
      drag = null;
      if (!was.on) return;
      draggedAt = performance.now();
      const dy = e.clientY - was.y;
      // The finger's speed over its last 100ms of movement, px per ms (+ is down). A finger that
      // stopped before lifting (no move in the last 60ms) has none: that is a drag let go, not a flick.
      const [t0, y0] = was.trail[0];
      const [t1, y1] = was.trail.at(-1);
      const speed = t1 > t0 && e.timeStamp - t1 < 60 ? (y1 - y0) / (t1 - t0) : 0;
      viewer.classList.remove("dragging");
      if (e.type === "pointerup" && (dy > 96 || (dy > 24 && speed > 0.35))) {
        closeViewer();
        return;
      }
      viewer.classList.add("settling");   // css springs translate, scale and the black back
      viewer.style.removeProperty("--viewer-dim");
      dragImg().style.removeProperty("translate");
      dragImg().style.removeProperty("scale");
    };
    vtrack.addEventListener("pointerup", letGo);
    vtrack.addEventListener("pointercancel", letGo);

    // Escape and the phone's back gesture close the dialog directly, without closeViewer: keep the
    // gallery on the photo the viewer was showing (closeViewer has already done it in that path).
    viewer.addEventListener("close", () => { resetDrag(); main.goTo(shownInViewer, false); });
    $("#viewerClose").addEventListener("click", closeViewer);
    $("#viewerPrev").addEventListener("click", () => full.goTo(full.index - 1));
    $("#viewerNext").addEventListener("click", () => full.goTo(full.index + 1));
    vtrack.addEventListener("click", (e) => { if (performance.now() - draggedAt > 400 && e.target.tagName !== "IMG") closeViewer(); });
    viewer.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") full.goTo(full.index + 1);
      if (e.key === "ArrowLeft") full.goTo(full.index - 1);
    });
  }

  /* ---------- start the view on screen (first load, and after every in-site link) ---------- */
  function init() {
    const view = $("#view");
    page = view.dataset.page;
    view.removeAttribute("aria-busy");   // entrance animations start now, with the content
    currentCarId = page === "car" ? new URLSearchParams(location.search).get("id") : null;
    shown = location.pathname + location.search;
    $$("[data-nav]").forEach((a) => a.removeAttribute("aria-current"));
    if (page === "home") $('[data-nav="sale"]').setAttribute("aria-current", "page");
    if (page === "sold") $('[data-nav="sold"]').setAttribute("aria-current", "page");
    if (page === "home") initHome();
    if (page === "sold") initSold();
    if (page === "car") initCar();
    if (page === "missing") fillContacts("Yo, what cars do you have right now?");
    syncThemeControls();
  }

  // First load: grey placeholder cards show until the cars arrive.
  syncThemeControls();
  fillContacts("Yo, what cars do you have right now?");
  const firstCar = $("#view").dataset.page === "car" ? new URLSearchParams(location.search).get("id") : null;
  Promise.all([loadCars(), loadCar(firstCar)]).then(init, () => {
    const view = $("#view");
    view.removeAttribute("aria-busy");
    $("main", view).replaceChildren(fromHtml(`
      <div class="wrap empty load-error">
        ${icon("wifi-off", "ic empty-icon")}
        <h1>Couldn't load the cars</h1>
        <button class="btn btn-accent" type="button">Try again</button>
      </div>`));
    $(".load-error button").addEventListener("click", () => location.reload());
  });
})();
