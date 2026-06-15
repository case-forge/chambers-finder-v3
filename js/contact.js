document.addEventListener("DOMContentLoaded", () => {

  // Match the Turnstile widget to the page theme once, at load. We deliberately
  // do NOT re-render it when the theme toggle is used: calling turnstile.reset()
  // on every toggle re-runs the challenge, and after a few switches Cloudflare
  // rate-limits it and the widget disappears. The widget keeps whichever
  // light/dark it loaded with until the next full page load.
  const turnstileEl = document.querySelector(".cf-turnstile");
  if (turnstileEl) {
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    turnstileEl.setAttribute("data-theme", dark ? "dark" : "light");
  }

  const form      = document.getElementById("contact-form");
  const submitBtn = document.getElementById("submit-btn");
  const errorBox  = document.getElementById("form-error");
  const msgArea   = document.getElementById("message");
  const charCount = document.getElementById("char-count");

  if (!form || !submitBtn || !errorBox || !msgArea || !charCount) return;

  // --- Validation rules (kept in line with functions/api/contact.js, which is authoritative) ---
  const rules = {
    name: v => {
      if (!v)          return 'Name is required.';
      if (v.length < 2) {
        const n = 2 - v.length;
        return `Name needs ${n} more character${n === 1 ? '' : 's'}.`;
      }
      if (v.length > 80) return 'Name must be 80 characters or fewer.';
      if (!/^[\p{L}\p{M}\s\-'’.]+$/u.test(v)) return "Letters, spaces, hyphens, apostrophes and full stops only.";
      return null;
    },
    email: v => {
      if (!v) return 'Email is required.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return 'Please enter a valid email address.';
      return null;
    },
    type: v => v ? null : 'Please select a message type.',
    message: v => {
      const len = v ? v.length : 0;
      if (len < 10) {
        const n = 10 - len;
        return `Message needs ${n} more character${n === 1 ? '' : 's'}.`;
      }
      if (len > 1000) return 'Message must be 1000 characters or fewer.';
      return null;
    }
  };

  // --- Per-field error helpers ---
  function showError(id, msg) {
    const errEl   = document.getElementById(id + '-error');
    const inputEl = document.getElementById(id);
    if (errEl)   { errEl.textContent = msg; errEl.classList.add('visible'); }
    if (inputEl) { inputEl.classList.add('invalid'); inputEl.classList.remove('valid'); }
  }

  function markValid(id) {
    const errEl   = document.getElementById(id + '-error');
    const inputEl = document.getElementById(id);
    if (errEl)   { errEl.textContent = ''; errEl.classList.remove('visible'); }
    if (inputEl) { inputEl.classList.remove('invalid'); inputEl.classList.add('valid'); }
  }

  function validateField(id) {
    const inputEl = document.getElementById(id);
    if (!inputEl || !rules[id]) return true;
    const err = rules[id](inputEl.value.trim());
    if (err) { showError(id, err); return false; }
    markValid(id);
    return true;
  }

  // --- Wire up live validation (shows on blur, updates on input) ---
  const touched = {};
  const textFields = ['name', 'email', 'message'];

  textFields.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('blur',  () => { touched[id] = true; validateField(id); });
    el.addEventListener('input', () => { if (touched[id]) validateField(id); });
  });

  const typeEl = document.getElementById('type');
  if (typeEl) {
    typeEl.addEventListener('change', () => { touched['type'] = true; validateField('type'); });
  }

  // --- Character counter ---
  charCount.textContent = msgArea.value.length;
  msgArea.addEventListener("input", () => {
    charCount.textContent = msgArea.value.length;
  });

  // --- Submit ---
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    // Validate everything, mark all fields as touched so errors show
    const allFields = ['name', 'email', 'type', 'message'];
    allFields.forEach(id => { touched[id] = true; });
    const valid = allFields.every(id => validateField(id));
    if (!valid) {
      // Scroll to first visible error
      const firstErr = form.querySelector('.field-error.visible');
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (firstErr) firstErr.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      return;
    }

    errorBox.style.display = "none";
    submitBtn.disabled = true;
    submitBtn.textContent = "Sending…";

    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        body: new FormData(form),
      });

      const isJson = res.headers.get("content-type")?.includes("application/json");
      const data = isJson ? await res.json() : {};

      if (data.success) {
        window.location.href = data.redirect || "/success";
      } else {
        errorBox.textContent = data.error || "The message could not be sent. Please try again.";
        errorBox.style.display = "block";
        // Reset Turnstile so the user can retry without reloading the page
        window.turnstile?.reset(document.querySelector('.cf-turnstile'));
      }
    } catch (_) {
      errorBox.textContent = "Network error. Please check your connection and try again.";
      errorBox.style.display = "block";
      window.turnstile?.reset(document.querySelector('.cf-turnstile'));
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Send message";
    }
  });
});
