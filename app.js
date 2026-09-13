/*
 * Photo viewer for photobooth sessions.
 *
 * The booth shows the QR code for this page *while it is still uploading*, so a
 * guest often arrives before their files exist. Most of what happens here is
 * about tolerating that: every file is retried with a backoff, and each image
 * is slotted into the carousel at its fixed position whenever it shows up.
 *
 * The first half is pure logic with no DOM access, so it can be exercised from
 * Node. The second half wires it to the page.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Pure logic (no DOM)
  // ---------------------------------------------------------------------------

  // Both values end up inside an image URL, so they are held to the exact
  // shapes the booth produces. Anything else is treated as "no session" rather
  // than being escaped and requested anyway.
  const EVENT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Everything a session *might* contain, in display order. The bucket only
  // allows GetObject (no listing) and we deliberately avoid fetch/CORS, so the
  // page just tries each file and leaves out the ones that never appear. That
  // is how a 3-photo booth, or one without motion mode, shows fewer slides.
  const SESSION_FILES = Object.freeze([
    Object.freeze({ file: 'composite.png', label: 'Photo strip' }),
    Object.freeze({ file: 'motion.gif', label: 'Animated photo strip' }),
    Object.freeze({ file: 'photo-1.jpg', label: 'Photo 1' }),
    Object.freeze({ file: 'photo-2.jpg', label: 'Photo 2' }),
    Object.freeze({ file: 'photo-3.jpg', label: 'Photo 3' }),
    Object.freeze({ file: 'photo-4.jpg', label: 'Photo 4' }),
  ]);

  // Every real session has a strip, so it alone decides between showing the
  // viewer and showing an error. The other files are optional by design.
  const PRIMARY_FILE = 'composite.png';

  // The booth uploads the strip within a few seconds and encodes the GIF
  // after it, so early misses are expected. This works out to 12 retries and
  // about 69 s of waiting (plus request time) before a file is given up on.
  const RETRY_OPTIONS = Object.freeze({
    firstDelayMs: 1000,
    factor: 1.5,
    maxDelayMs: 8000,
    budgetMs: 75000,
  });

  const S3_BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
  const AWS_REGION_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)+$/;

  function isValidEvent(value) {
    return typeof value === 'string' && EVENT_PATTERN.test(value);
  }

  function isValidUuid(value) {
    return typeof value === 'string' && UUID_PATTERN.test(value);
  }

  // Returns { event, uuid } or null. The UUID's case is kept as given: S3 keys
  // are case-sensitive and the QR code carries exactly the key the booth used.
  function parseSessionParams(search) {
    const params = new URLSearchParams(search);
    const event = params.get('event');
    const uuid = params.get('uuid');
    if (!isValidEvent(event) || !isValidUuid(uuid)) return null;
    return { event, uuid };
  }

  // Throws on a broken config so a typo shows up as one clear console error
  // instead of a page full of silently failing image requests.
  function resolveBaseUrl(config) {
    if (!config) throw new Error('PHOTO_VIEWER_CONFIG is missing; is config.js loaded?');

    const override = typeof config.baseUrlOverride === 'string' ? config.baseUrlOverride.trim() : '';
    if (override) {
      if (!/^https?:\/\/[^/]/i.test(override)) {
        throw new Error(`baseUrlOverride must be an http(s) URL, got "${override}"`);
      }
      return override.replace(/\/+$/, '');
    }

    if (!S3_BUCKET_PATTERN.test(String(config.bucket))) {
      throw new Error(`config.bucket is not a valid S3 bucket name: "${config.bucket}"`);
    }
    if (!AWS_REGION_PATTERN.test(String(config.region))) {
      throw new Error(`config.region is not a valid AWS region: "${config.region}"`);
    }
    return `https://${config.bucket}.s3.${config.region}.amazonaws.com`;
  }

  // `attempt` 0 is the plain URL so a successful first load can be cached
  // normally. Retries add ?attempt=N so the browser (or a CDN in front of the
  // bucket) can't hand back the 403/404 it saw a moment ago.
  function buildImageUrl(baseUrl, session, file, attempt) {
    // Re-checked here, not just at parse time, so no code path can ever build
    // a URL out of an unvalidated value.
    if (!session || !isValidEvent(session.event) || !isValidUuid(session.uuid)) {
      throw new Error('Refusing to build an image URL for an invalid session');
    }
    if (!SESSION_FILES.some((entry) => entry.file === file)) {
      throw new Error(`Unknown session file: ${file}`);
    }

    const url = [baseUrl, session.event, session.uuid, file].map((part, i) => (
      i === 0 ? part : encodeURIComponent(part)
    )).join('/');
    return attempt > 0 ? `${url}?attempt=${attempt}` : url;
  }

  // Delays (ms) to wait before each retry: exponential, capped, and cut off
  // once the total would pass the budget.
  function buildRetrySchedule(options) {
    const delays = [];
    let total = 0;
    let delay = options.firstDelayMs;
    while (delay > 0 && total + delay <= options.budgetMs) {
      delays.push(delay);
      total += delay;
      delay = Math.min(Math.round(delay * options.factor), options.maxDelayMs);
    }
    return delays;
  }

  // Where a newly loaded file belongs among the slides already in the carousel.
  // `shownOrders` is the SESSION_FILES index of each current slide, ascending.
  function insertionIndex(shownOrders, newOrder) {
    let index = 0;
    while (index < shownOrders.length && shownOrders[index] < newOrder) index += 1;
    return index;
  }

  // Which slide is (mostly) in view. Rounding means the dot flips at the
  // halfway point of a swipe, which is where the snap would land anyway.
  function slideIndexFromScroll(scrollLeft, slideWidth, slideCount) {
    if (slideCount <= 0 || !(slideWidth > 0)) return 0;
    const index = Math.round(scrollLeft / slideWidth);
    return Math.max(0, Math.min(slideCount - 1, index));
  }

  const core = {
    SESSION_FILES,
    PRIMARY_FILE,
    RETRY_OPTIONS,
    isValidEvent,
    isValidUuid,
    parseSessionParams,
    resolveBaseUrl,
    buildImageUrl,
    buildRetrySchedule,
    insertionIndex,
    slideIndexFromScroll,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = core;
  }

  // ---------------------------------------------------------------------------
  // Page wiring
  // ---------------------------------------------------------------------------

  if (typeof document === 'undefined') return;

  const STATUS = {
    noSession: {
      title: 'Find your photos',
      text: 'Scan the QR code at the photo booth to see your photos.',
    },
    loading: {
      title: 'Getting your photos…',
      text: 'They may still be uploading from the booth. This usually takes a few seconds.',
      busy: true,
    },
    failed: {
      title: 'Your photos aren’t here yet',
      text: 'They may still be uploading, or the connection dropped. Give it a moment and try again.',
      canRetry: true,
    },
    misconfigured: {
      title: 'Something’s not set up right',
      text: 'This page can’t find where the photos are stored. Please let the photo booth host know.',
    },
  };

  const IDLE_AFTER_SCROLL_MS = 150;

  function showStatus(els, status) {
    els.viewer.hidden = true;
    els.statusTitle.textContent = status.title;
    els.statusText.textContent = status.text;
    els.spinner.hidden = !status.busy;
    els.retryButton.hidden = !status.canRetry;
    els.status.hidden = false;
  }

  // Loads one file into a fresh <img>, retrying on error. Plain <img> loads
  // need no CORS on the bucket, and S3's 403 (no ListBucket permission) and
  // 404 both surface the same way: an error event.
  function loadWithRetry({ urlFor, schedule, isCurrent, later, onLoad, onGiveUp }) {
    let attempt = 0;

    function tryOnce() {
      if (!isCurrent()) return;

      // A new element per attempt means a late event from an earlier attempt
      // can never be mistaken for the current one.
      const img = document.createElement('img');
      img.decoding = 'async';
      img.onload = () => {
        img.onload = img.onerror = null;
        if (isCurrent()) onLoad(img);
      };
      img.onerror = () => {
        img.onload = img.onerror = null;
        if (!isCurrent()) return;
        if (attempt >= schedule.length) {
          onGiveUp();
          return;
        }
        const delay = schedule[attempt];
        attempt += 1;
        later(tryOnce, delay);
      };
      img.src = urlFor(attempt);
    }

    tryOnce();
  }

  function createCarousel({ track, dots, prevButton, nextButton }) {
    const slides = []; // { order, label, el }, in display order
    const pending = []; // loaded images waiting for the user to stop scrolling

    let currentIndex = 0;
    let targetIndex = null; // where the last button/key/dot navigation is heading
    let knownWidth = 0;
    let frameRequested = false;
    let scrolling = false;
    let touching = false;
    let idleTimer = 0;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    function add(order, entry, img) {
      pending.push({ order, entry, img });
      // Moving scrollLeft under a finger or mid-momentum kills the gesture on
      // iOS, so late arrivals wait until the carousel is at rest.
      if (!scrolling && !touching) flushPending();
    }

    function flushPending() {
      if (pending.length === 0) return;

      const width = track.clientWidth;
      const anchor = slides[currentIndex] ? slides[currentIndex].el : null;

      for (const item of pending.splice(0)) {
        const index = insertionIndex(slides.map((slide) => slide.order), item.order);
        const el = buildSlide(item.entry, item.img);
        track.insertBefore(el, index < slides.length ? slides[index].el : null);
        slides.splice(index, 0, { order: item.order, label: item.entry.label, el });
      }

      // A slide inserted before the one in view would push it right. Putting
      // the same slide back under the viewport in the same task means the
      // browser never paints the shifted position. Some browsers re-snap to
      // the same element on their own; then this assignment is a no-op.
      if (anchor && width > 0) {
        currentIndex = slides.findIndex((slide) => slide.el === anchor);
        track.scrollLeft = currentIndex * width;
      }

      renderDots();
    }

    function buildSlide(entry, img) {
      const el = document.createElement('div');
      el.className = 'slide';
      el.setAttribute('role', 'group');
      el.setAttribute('aria-roledescription', 'slide');
      el.dataset.file = entry.file;

      img.className = 'slide-image';
      img.alt = entry.label;
      el.appendChild(img);
      return el;
    }

    function renderDots() {
      dots.textContent = '';
      slides.forEach((slide, i) => {
        const label = `${slide.label} (${i + 1} of ${slides.length})`;
        slide.el.setAttribute('aria-label', label);

        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'dot';
        dot.setAttribute('aria-label', `Show ${label}`);
        dot.addEventListener('click', () => goTo(i));
        dots.appendChild(dot);
      });
      updateActive();
    }

    function updateActive() {
      Array.prototype.forEach.call(dots.children, (dot, i) => {
        if (i === currentIndex) dot.setAttribute('aria-current', 'true');
        else dot.removeAttribute('aria-current');
      });
      prevButton.disabled = currentIndex <= 0;
      nextButton.disabled = currentIndex >= slides.length - 1;
    }

    function goTo(index) {
      if (slides.length === 0) return;
      targetIndex = Math.max(0, Math.min(slides.length - 1, index));
      track.scrollTo({
        left: targetIndex * track.clientWidth,
        behavior: reducedMotion.matches ? 'auto' : 'smooth',
      });
    }

    // Repeated key presses during a smooth scroll should keep advancing from
    // where the scroll is heading, not from the slide it is passing through.
    function step(delta) {
      const from = scrolling && targetIndex !== null ? targetIndex : currentIndex;
      goTo(from + delta);
    }

    function syncFromScroll() {
      const width = track.clientWidth;
      // During a resize scrollLeft still reflects the old width, so the index
      // would come out wrong. The ResizeObserver realigns instead.
      if (width !== knownWidth) return;
      const index = slideIndexFromScroll(track.scrollLeft, width, slides.length);
      if (index !== currentIndex) {
        currentIndex = index;
        updateActive();
      }
    }

    function onScroll() {
      scrolling = true;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(onScrollIdle, IDLE_AFTER_SCROLL_MS);

      if (!frameRequested) {
        frameRequested = true;
        requestAnimationFrame(() => {
          frameRequested = false;
          syncFromScroll();
        });
      }
    }

    // A debounce rather than the `scrollend` event, which older iOS Safari
    // versions don't fire.
    function onScrollIdle() {
      scrolling = false;
      targetIndex = null;
      syncFromScroll();
      if (!touching) flushPending();
    }

    function onTouchChange(event) {
      touching = event.touches.length > 0;
      if (!touching && !scrolling) flushPending();
    }

    // Rotation or a resized desktop window changes the slide width; keep the
    // same slide in view rather than whatever the old scrollLeft now points at.
    function onResize() {
      const width = track.clientWidth;
      if (width === knownWidth) return;
      knownWidth = width;
      if (width > 0) track.scrollLeft = currentIndex * width;
    }

    function reveal() {
      knownWidth = track.clientWidth;
      currentIndex = 0;
      targetIndex = null;
      track.scrollLeft = 0;
      flushPending();
      updateActive();
    }

    function reset() {
      pending.length = 0;
      slides.length = 0;
      track.textContent = '';
      currentIndex = 0;
      targetIndex = null;
      renderDots();
    }

    function onKeyDown(event) {
      if (track.offsetParent === null) return; // viewer hidden
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      // preventDefault stops the focused track's native arrow-key scroll from
      // also moving it, which would skip a slide.
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        step(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        step(1);
      }
    }

    track.addEventListener('scroll', onScroll, { passive: true });
    track.addEventListener('touchstart', onTouchChange, { passive: true });
    track.addEventListener('touchend', onTouchChange, { passive: true });
    track.addEventListener('touchcancel', onTouchChange, { passive: true });
    new ResizeObserver(onResize).observe(track);
    document.addEventListener('keydown', onKeyDown);
    prevButton.addEventListener('click', () => step(-1));
    nextButton.addEventListener('click', () => step(1));

    return { add, reveal, reset };
  }

  function startApp() {
    const byId = (id) => document.getElementById(id);
    const els = {
      status: byId('status'),
      statusTitle: byId('status-title'),
      statusText: byId('status-text'),
      spinner: byId('status-spinner'),
      retryButton: byId('retry-button'),
      viewer: byId('viewer'),
      track: byId('track'),
      dots: byId('dots'),
      prevButton: byId('prev-button'),
      nextButton: byId('next-button'),
    };

    const session = parseSessionParams(window.location.search);
    if (!session) {
      showStatus(els, STATUS.noSession);
      return;
    }

    let baseUrl;
    try {
      baseUrl = resolveBaseUrl(window.PHOTO_VIEWER_CONFIG);
    } catch (err) {
      console.error(err);
      showStatus(els, STATUS.misconfigured);
      return;
    }

    const carousel = createCarousel(els);
    const schedule = buildRetrySchedule(RETRY_OPTIONS);
    const timers = new Set();
    let generation = 0;

    // Starting over bumps the generation so every retry loop, pending timer
    // and in-flight image from the previous run ignores itself.
    function loadSession() {
      generation += 1;
      const thisGeneration = generation;
      const isCurrent = () => thisGeneration === generation;

      timers.forEach(clearTimeout);
      timers.clear();
      carousel.reset();
      showStatus(els, STATUS.loading);

      const later = (fn, delay) => {
        const id = setTimeout(() => {
          timers.delete(id);
          fn();
        }, delay);
        timers.add(id);
      };

      SESSION_FILES.forEach((entry, order) => {
        loadWithRetry({
          urlFor: (attempt) => buildImageUrl(baseUrl, session, entry.file, attempt),
          schedule,
          isCurrent,
          later,
          onLoad(img) {
            // Files that beat the strip are added to the still-hidden
            // carousel, so the viewer opens with them already in place.
            carousel.add(order, entry, img);
            if (entry.file === PRIMARY_FILE) {
              els.status.hidden = true;
              els.viewer.hidden = false;
              carousel.reveal();
            }
          },
          onGiveUp() {
            if (entry.file === PRIMARY_FILE) showStatus(els, STATUS.failed);
          },
        });
      });
    }

    els.retryButton.addEventListener('click', loadSession);
    loadSession();
  }

  startApp();
})();
